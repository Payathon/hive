import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  checkDelivery,
  checkDeliverySpec,
  expiryEvent,
  fen,
  newOrder,
  needsListener,
  nextOffer,
  TIMEOUTS,
  transition,
  workStyle,
  workTimeoutMs,
  type Delivery,
  type DeliveredFile,
  type Fen,
  type Listing,
  type OrderEvent,
  type WorkMode,
} from "@hive/core";
import type { Db } from "./db/client.ts";
import { accounts, categories, deviceLogins, files, listings, notifications, orderEvents, orders, pushSubscriptions, tokens } from "./db/schema.ts";
import { MemoryFileStore, type FileStore } from "./files.ts";
import { OutboxMailer, type Mailer } from "./mail.ts";
import { lockOrder, orderColumns, rowToOrder, saveTransition, type OrderRow } from "./orders-repo.ts";
import type { PaymentProvider, ProductRef } from "./payments/provider.ts";
import type { PushMessage, PushSender, PushTarget } from "./push.ts";

export type Actor = "human" | "agent";
export interface Principal {
  accountId: string;
  actor: Actor;
  // tokens.id of the credential used.
  tokenId: string;
}

export class HiveError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// A listener that hasn't polled for this long is offline.
export const PRESENCE_TTL_MS = 60_000;
// A fully automatic seller whose listener goes quiet this long mid-order has abandoned it (design §3, #12).
export const HEARTBEAT_LOST_MS = 2 * 60_000;
// Listings that need a person are dispatched while the seller used hive (app, CLI or MCP) this recently.
export const ACTIVE_TTL_MS = 24 * 3600_000;
// How often an authenticated request refreshes accounts.active_at.
const ACTIVE_WRITE_EVERY_MS = 60_000;
const DEVICE_LOGIN_TTL_MS = 10 * 60_000;
// Categories change by editing rows; services pick edits up within this long.
const CATEGORY_CACHE_MS = 30_000;
// Per uploaded file. Big enough for a short video.
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = () => `hive_${randomBytes(24).toString("base64url")}`;
const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

// Daily caps and limits reset at midnight in China (UTC+8, no DST).
export function startOfShanghaiDay(now: Date): Date {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 8 * 3600_000);
}

// Orders that have been paid for but whose count hasn't been consumed yet.
const RESERVING: OrderRow["status"][] = ["PAID", "IN_PROGRESS"];
// Orders whose price counts against the buyer's daily cap.
const SPENDING: OrderRow["status"][] = ["ACCEPTED", "AWAITING_PAYMENT", "PAID", "IN_PROGRESS", "DELIVERED", "COMPLETED", "FAILED"];

export interface HiveOptions {
  db: Db;
  payments: PaymentProvider;
  files?: FileStore;
  clock?: () => Date;
  // Notifications beyond the in-app inbox (design §6). Mail defaults to the dev outbox; no push unless given.
  mailer?: Mailer;
  push?: PushSender | null;
  // Where the web app lives, for links in mail.
  webUrl?: string;
}

// Headline per notification kind, for push and mail.
const NOTICE_TITLE: Record<string, string> = {
  offer: "新派单，等你抢单",
  payment_required: "待你付款",
  paid: "买家已付款",
  delivered: "已交付，等你验收",
  failed: "订单失败",
  completed: "订单完成",
  cancelled: "订单已取消",
};
// People read these in push and mail, so reasons are spelled out (same words as the web order page).
const FAIL_TEXT: Record<string, string> = { work_timeout: "卖家没有按时交付", seller_abandoned: "卖家放弃了这单", heartbeat_lost: "卖家的 agent 掉线了" };
const CANCEL_TEXT: Record<string, string> = { no_seller: "暂时没有卖家接单，没有扣款", buyer_cancelled: "已取消，没有扣款", payment_expired: "超时未付款" };
const VERDICT_TEXT: Record<string, string> = { accepted: "买家已确认收货", rejected: "买家拒收了", auto_accepted: "超时自动确认收货" };

type CategoryRow = typeof categories.$inferSelect;

// What a buyer posts: the category to dispatch in, what they want, and how it must be delivered.
export interface OrderRequest {
  category: string;
  brief: string;
  input?: unknown;
  delivery: unknown;
}

// What a seller hands in. Files are ids returned by uploadFile for this order.
export interface DeliveryRequest {
  note?: string | null | undefined;
  data?: unknown;
  files?: string[] | undefined;
}

export class Hive {
  readonly db: Db;
  readonly payments: PaymentProvider;
  readonly files: FileStore;
  readonly mailer: Mailer;
  readonly push: PushSender | null;
  private readonly webUrl: string;
  private readonly clock: () => Date;
  // Push and mail in flight; they never hold up or fail the order change that caused them.
  private readonly outgoing = new Set<Promise<void>>();
  private categoryCache: { at: number; list: CategoryRow[] } | null = null;
  // Wakes long-polls for an account when something it cares about changes.
  private readonly bus = new EventEmitter().setMaxListeners(0);

  constructor(opts: HiveOptions) {
    this.db = opts.db;
    this.payments = opts.payments;
    this.files = opts.files ?? new MemoryFileStore();
    this.mailer = opts.mailer ?? new OutboxMailer(opts.db);
    this.push = opts.push ?? null;
    this.webUrl = (opts.webUrl ?? "http://localhost:5173").replace(/\/$/, "");
    this.clock = opts.clock ?? (() => new Date());
  }

  now() {
    return this.clock();
  }

  // ---- accounts & auth --------------------------------------------------

  async createAccount(name: string) {
    const id = newId("acct");
    const token = newToken();
    await this.db.transaction(async (tx) => {
      await tx.insert(accounts).values({ id, name, createdAt: this.now() });
      await tx.insert(tokens).values({ tokenHash: sha256(token), id: newId("tok"), accountId: id, actor: "human", label: "signup" });
    });
    return { accountId: id, token };
  }

  async authenticate(token: string): Promise<Principal | null> {
    const [row] = await this.db
      .select({ accountId: tokens.accountId, actor: tokens.actor, tokenId: tokens.id })
      .from(tokens)
      .where(and(eq(tokens.tokenHash, sha256(token)), isNull(tokens.revokedAt)));
    if (!row) return null;
    // Any authenticated use counts as activity; written at most once a minute.
    const stale = new Date(this.now().getTime() - ACTIVE_WRITE_EVERY_MS);
    await this.db
      .update(accounts)
      .set({ activeAt: this.now() })
      .where(and(eq(accounts.id, row.accountId), sql`coalesce(${accounts.activeAt}, 'epoch'::timestamptz) < ${stale}`));
    return row;
  }

  async startDeviceLogin(label: string | null) {
    const id = newId("dl");
    const secret = randomBytes(24).toString("base64url");
    const userCode = randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = new Date(this.now().getTime() + DEVICE_LOGIN_TTL_MS);
    await this.db.insert(deviceLogins).values({ id, userCode, secretHash: sha256(secret), label, expiresAt });
    return { id, userCode, secret, expiresAt };
  }

  // An agent token for MCP clients that take a key instead of running `hive login`.
  async createApiKey(p: Principal, label: string | null) {
    if (p.actor !== "human") throw new HiveError(403, "humans_only", "only the account owner can create API keys");
    const key = newToken();
    await this.db
      .insert(tokens)
      .values({ tokenHash: sha256(key), id: newId("tok"), accountId: p.accountId, actor: "agent", label, source: "api_key" });
    return { key };
  }

  // What the approval page shows before the owner says yes.
  async describeDeviceLogin(p: Principal, userCode: string) {
    if (p.actor !== "human") throw new HiveError(403, "humans_only", "only the account owner can approve an agent");
    const [dl] = await this.db.select().from(deviceLogins).where(eq(deviceLogins.userCode, userCode.toUpperCase()));
    if (!dl || (!dl.accountId && dl.expiresAt < this.now())) throw new HiveError(404, "login_not_found", "unknown or expired code");
    return { userCode: dl.userCode, label: dl.label, expiresAt: dl.expiresAt, approved: dl.accountId !== null };
  }

  // Called by a signed-in human to bind the waiting CLI to their account as an agent.
  async approveDeviceLogin(p: Principal, userCode: string) {
    if (p.actor !== "human") throw new HiveError(403, "humans_only", "only the account owner can approve an agent");
    const token = newToken();
    await this.db.transaction(async (tx) => {
      const [dl] = await tx.select().from(deviceLogins).where(eq(deviceLogins.userCode, userCode.toUpperCase())).for("update");
      if (!dl || dl.expiresAt < this.now()) throw new HiveError(404, "login_not_found", "unknown or expired code");
      if (dl.accountId) throw new HiveError(409, "login_used", "this code was already approved");
      await tx
        .insert(tokens)
        .values({ tokenHash: sha256(token), id: newId("tok"), accountId: p.accountId, actor: "agent", label: dl.label, source: "login" });
      await tx.update(deviceLogins).set({ accountId: p.accountId, pendingToken: token }).where(eq(deviceLogins.id, dl.id));
    });
  }

  async pollDeviceLogin(id: string, secret: string): Promise<{ status: "pending" } | { status: "approved"; token: string }> {
    return this.db.transaction(async (tx) => {
      const [dl] = await tx.select().from(deviceLogins).where(eq(deviceLogins.id, id)).for("update");
      if (!dl || dl.secretHash !== sha256(secret)) throw new HiveError(404, "login_not_found", "unknown login");
      if (dl.pendingToken) {
        await tx.update(deviceLogins).set({ pendingToken: null }).where(eq(deviceLogins.id, id));
        return { status: "approved", token: dl.pendingToken };
      }
      if (dl.accountId) throw new HiveError(409, "login_used", "token was already collected");
      if (dl.expiresAt < this.now()) throw new HiveError(404, "login_expired", "login expired");
      return { status: "pending" };
    });
  }

  // The owner's view of every live agent credential, with when each last ordered.
  async listAgents(p: Principal) {
    if (p.actor !== "human") throw new HiveError(403, "humans_only", "only the account owner can manage agents");
    const lastOrderAt = sql<Date | null>`max(${orders.createdAt})`.mapWith(orders.createdAt);
    return this.db
      .select({ id: tokens.id, label: tokens.label, source: tokens.source, createdAt: tokens.createdAt, lastOrderAt })
      .from(tokens)
      .leftJoin(orders, eq(orders.createdByToken, tokens.id))
      .where(and(eq(tokens.accountId, p.accountId), eq(tokens.actor, "agent"), isNull(tokens.revokedAt)))
      .groupBy(tokens.id, tokens.label, tokens.source, tokens.createdAt)
      .orderBy(desc(tokens.createdAt));
  }

  async revokeAgent(p: Principal, tokenId: string) {
    if (p.actor !== "human") throw new HiveError(403, "humans_only", "only the account owner can manage agents");
    const revoked = await this.db
      .update(tokens)
      .set({ revokedAt: this.now() })
      .where(and(eq(tokens.id, tokenId), eq(tokens.accountId, p.accountId), eq(tokens.actor, "agent"), isNull(tokens.revokedAt)))
      .returning({ id: tokens.id });
    if (revoked.length === 0) throw new HiveError(404, "agent_not_found", "no such agent");
  }

  async getAccount(accountId: string) {
    const [a] = await this.db.select().from(accounts).where(eq(accounts.id, accountId));
    if (!a) throw new HiveError(404, "account_not_found", "account not found");
    return a;
  }

  async updateRules(
    p: Principal,
    rules: { perOrderCapFen?: number | null; dailyCapFen?: number | null; paused?: boolean },
  ) {
    // Rules exist to restrain the agent, so only the human may change them.
    if (p.actor !== "human") throw new HiveError(403, "humans_only", "only the account owner can change rules");
    await this.db.update(accounts).set(rules).where(eq(accounts.id, p.accountId));
    return this.getAccount(p.accountId);
  }

  async setEmail(p: Principal, email: string | null) {
    if (p.actor !== "human") throw new HiveError(403, "humans_only", "only the account owner can change the email");
    await this.db.update(accounts).set({ email }).where(eq(accounts.id, p.accountId));
    return this.getAccount(p.accountId);
  }

  // ---- categories -------------------------------------------------------

  async listCategories(): Promise<CategoryRow[]> {
    if (!this.categoryCache || Date.now() - this.categoryCache.at > CATEGORY_CACHE_MS) {
      const list = await this.db.select().from(categories).orderBy(categories.sort, categories.id);
      this.categoryCache = { at: Date.now(), list };
    }
    return this.categoryCache.list;
  }

  async getCategory(id: string): Promise<CategoryRow> {
    const c = (await this.listCategories()).find((x) => x.id === id);
    if (!c) throw new HiveError(404, "unknown_category", `unknown category ${id}; see /v1/categories`);
    return c;
  }

  // ---- listings ---------------------------------------------------------

  async upsertListing(
    p: Principal,
    category: string,
    opts: {
      acceptMode: "auto" | "ask";
      workMode?: WorkMode | undefined;
      deliveryHours?: number | null | undefined;
      dailyLimit: number;
      tags?: string[] | undefined;
      intro?: string | null | undefined;
      active?: boolean | undefined;
    },
  ) {
    const cat = await this.getCategory(category);
    const workMode = opts.workMode ?? "agent";
    // Manual work is timed by the seller's own promise, or the category's usual time if they give none.
    const deliveryHours = workMode === "manual" ? (opts.deliveryHours ?? Math.ceil(cat.manualTimeoutMs / 3600_000)) : null;
    const values = {
      acceptMode: opts.acceptMode,
      workMode,
      deliveryHours,
      dailyLimit: opts.dailyLimit,
      tags: [...new Set((opts.tags ?? []).map((t) => t.trim()).filter(Boolean))],
      intro: opts.intro?.trim() || null,
      active: opts.active ?? true,
    };
    const [row] = await this.db
      .insert(listings)
      .values({ id: newId("lst"), sellerAccountId: p.accountId, category, ...values })
      .onConflictDoUpdate({ target: [listings.sellerAccountId, listings.category], set: values })
      .returning();
    return row!;
  }

  async myListings(accountId: string) {
    return this.db.select().from(listings).where(eq(listings.sellerAccountId, accountId));
  }

  private async productRef(listing: typeof listings.$inferSelect): Promise<ProductRef> {
    const cat = (await this.listCategories()).find((c) => c.id === listing.category);
    return {
      productId: listing.id,
      ownerId: listing.sellerAccountId,
      productName: `hive · ${cat?.title ?? listing.category}`,
    };
  }

  // Walks the seller through 即刻收 configuration and syncs the price they set there.
  async setupListingPayment(p: Principal, category: string) {
    const [listing] = await this.db
      .select()
      .from(listings)
      .where(and(eq(listings.sellerAccountId, p.accountId), eq(listings.category, category)));
    if (!listing) throw new HiveError(404, "listing_not_found", "list in this category first");
    const state = await this.payments.setupProduct(await this.productRef(listing));
    await this.db
      .update(listings)
      .set({ paymentStatus: state.status, priceFen: state.priceFen, skuId: state.skuId })
      .where(eq(listings.id, listing.id));
    return state;
  }

  // ---- presence ---------------------------------------------------------

  async setHumanAccepting(p: Principal, on: boolean) {
    if (p.actor !== "human") throw new HiveError(403, "humans_only", "agents go online with `hive serve`");
    await this.db.update(accounts).set({ humanAccepting: on }).where(eq(accounts.id, p.accountId));
  }

  // `hive serve` polls as a listener even with an owner token; other polls are just activity.
  private async touchListener(p: Principal) {
    await this.db.update(accounts).set({ listenerSeenAt: this.now() }).where(eq(accounts.id, p.accountId));
  }

  // ---- orders: buyer side -----------------------------------------------

  async createOrder(p: Principal, req: OrderRequest) {
    await this.getCategory(req.category);
    const spec = checkDeliverySpec(req.delivery);
    if (!spec.ok) throw new HiveError(422, "invalid_delivery_spec", spec.error);

    const account = await this.getAccount(p.accountId);
    if (account.paused) throw new HiveError(403, "account_paused", "this account is paused by its owner");
    const maxPriceFen = await this.budgetFor(account);
    if (maxPriceFen !== null && maxPriceFen <= 0) {
      throw new HiveError(403, "daily_cap_reached", "today's spending cap is used up");
    }

    const input = req.input === undefined ? null : req.input;
    const order = newOrder({ id: newId("ord"), category: req.category, buyerAccountId: p.accountId, input, deliverySpec: spec.value });
    await this.db.insert(orders).values({
      id: order.id,
      category: req.category,
      buyerAccountId: p.accountId,
      createdByActor: p.actor,
      createdByToken: p.tokenId,
      brief: req.brief,
      input,
      deliverySpec: spec.value,
      maxPriceFen,
      ...orderColumns(order),
      createdAt: this.now(),
      updatedAt: this.now(),
    });
    await this.apply(order.id, { type: "dispatch" });
    await this.dispatch(order.id);
    return this.getOrder(p, order.id);
  }

  // The most this buyer may pay for one more order right now, or null for no limit.
  private async budgetFor(account: typeof accounts.$inferSelect): Promise<number | null> {
    let budget = account.perOrderCapFen;
    if (account.dailyCapFen !== null) {
      const [{ spent }] = (await this.db
        .select({ spent: sql<number>`coalesce(sum(${orders.priceFen}), 0)::int` })
        .from(orders)
        .where(
          and(
            eq(orders.buyerAccountId, account.id),
            inArray(orders.status, SPENDING),
            gte(orders.createdAt, startOfShanghaiDay(this.now())),
          ),
        )) as [{ spent: number }];
      const left = account.dailyCapFen - spent;
      budget = budget === null ? left : Math.min(budget, left);
    }
    return budget;
  }

  async cancelOrder(p: Principal, orderId: string) {
    await this.requireBuyer(p, orderId);
    await this.apply(orderId, { type: "buyer_cancel" });
    return this.getOrder(p, orderId);
  }

  // Buyers (or their agent) call this after confirming in Alipay instead of waiting for the sweeper.
  async checkPayment(p: Principal, orderId: string) {
    await this.requireBuyer(p, orderId);
    await this.detectPayment(orderId);
    return this.getOrder(p, orderId);
  }

  async verdict(p: Principal, orderId: string, verdict: "accepted" | "rejected") {
    await this.requireBuyer(p, orderId);
    await this.apply(orderId, { type: "buyer_verdict", verdict });
    return this.getOrder(p, orderId);
  }

  // ---- orders: seller side ----------------------------------------------

  async acceptOffer(p: Principal, orderId: string) {
    await this.acceptFor(p.accountId, orderId);
    return this.getOrder(p, orderId);
  }

  private async acceptFor(sellerAccountId: string, orderId: string) {
    const row = await this.loadOrder(orderId);
    const [listing] = await this.db
      .select()
      .from(listings)
      .where(and(eq(listings.sellerAccountId, sellerAccountId), eq(listings.category, row.category)));
    if (!listing || listing.priceFen === null) throw new HiveError(409, "listing_not_ready", "no priced listing in this category");
    const cat = await this.getCategory(row.category);
    await this.apply(
      orderId,
      {
        type: "seller_accept",
        sellerAccountId,
        priceFen: fen(listing.priceFen),
        workTimeoutMs: workTimeoutMs(cat.workTimeoutMs, listing.workMode, listing.deliveryHours),
      },
      { listingId: listing.id },
    );
    await this.requestPayment(orderId);
  }

  async declineOffer(p: Principal, orderId: string) {
    await this.apply(orderId, { type: "seller_decline", sellerAccountId: p.accountId });
    await this.dispatch(orderId);
  }

  async startWork(p: Principal, orderId: string) {
    await this.requireSeller(p, orderId);
    await this.apply(orderId, { type: "work_started" });
    return this.getOrder(p, orderId);
  }

  async abandon(p: Principal, orderId: string) {
    await this.requireSeller(p, orderId);
    await this.apply(orderId, { type: "work_failed", reason: "seller_abandoned" });
    return this.getOrder(p, orderId);
  }

  // Stores one file for a delivery the seller is about to make. Files only count once delivered.
  async uploadFile(p: Principal, orderId: string, file: { name: string; mime: string; bytes: Uint8Array }) {
    const row = await this.requireSeller(p, orderId);
    if (!RESERVING.includes(row.status)) throw new HiveError(409, "not_in_progress", `order is ${row.status}`);
    if (file.bytes.byteLength === 0) throw new HiveError(400, "empty_file", "the file is empty");
    if (file.bytes.byteLength > MAX_FILE_BYTES) throw new HiveError(400, "file_too_large", `files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    // Unguessable: the download link is the file's only key (design §7).
    const id = `file_${randomBytes(16).toString("hex")}`;
    const name = file.name.replace(/[\/\x00-\x1f]/g, "_").slice(0, 200) || "file";
    await this.files.put(id, file.bytes);
    await this.db
      .insert(files)
      .values({ id, orderId, uploadedBy: p.accountId, name, mime: file.mime || "application/octet-stream", size: file.bytes.byteLength, createdAt: this.now() });
    return fileRef({ id, name, mime: file.mime || "application/octet-stream", size: file.bytes.byteLength });
  }

  async readFile(id: string) {
    const [meta] = await this.db.select().from(files).where(eq(files.id, id));
    const bytes = meta ? await this.files.get(id) : null;
    if (!meta || !bytes) throw new HiveError(404, "file_not_found", "file not found");
    return { meta, bytes };
  }

  async deliver(p: Principal, orderId: string, req: DeliveryRequest) {
    let row = await this.requireSeller(p, orderId);
    // Delivering a paid order the seller never marked as started starts it first.
    if (row.status === "PAID") {
      await this.apply(orderId, { type: "work_started" });
      row = await this.requireSeller(p, orderId);
    }
    if (row.status !== "IN_PROGRESS") throw new HiveError(409, "not_in_progress", `order is ${row.status}`);
    const order = rowToOrder(row);
    const output = await this.resolveDelivery(orderId, req);
    if (!checkDelivery(order.deliverySpec, output).ok) {
      // Records the attempt and error; the seller may resubmit before the deadline.
      await this.apply(orderId, { type: "delivery_submitted", output });
      const saved = await this.loadOrder(orderId);
      throw new HiveError(422, "invalid_output", saved.lastDeliveryError ?? "the delivery doesn't have the format the buyer asked for");
    }
    // Consume the paid count before accepting the delivery; quota.verify is idempotent on the request number.
    const listing = await this.listingFor(row);
    const status = await this.payments.consume({
      requestNo: `consume_${orderId}`,
      product: await this.productRef(listing),
      buyerId: row.buyerAccountId,
      reason: `hive ${order.category} ${orderId}`,
    });
    if (status === "PROCESSING") throw new HiveError(409, "consume_processing", "payment consumption pending, retry shortly");
    if (status !== "SUCCEEDED") throw new HiveError(502, "consume_failed", `could not consume the paid count: ${status}`);
    await this.apply(orderId, { type: "delivery_submitted", output });
    return this.getOrder(p, orderId);
  }

  // Turns uploaded file ids into the files recorded on the delivery; only this order's uploads count.
  private async resolveDelivery(orderId: string, req: DeliveryRequest): Promise<Delivery> {
    const ids = [...new Set(req.files ?? [])];
    const rows = ids.length ? await this.db.select().from(files).where(and(eq(files.orderId, orderId), inArray(files.id, ids))) : [];
    const missing = ids.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) throw new HiveError(422, "unknown_file", `upload these to this order first: ${missing.join(", ")}`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      note: req.note ?? null,
      data: req.data === undefined ? null : req.data,
      files: ids.map((id) => {
        const r = byId.get(id)!;
        return { id: r.id, name: r.name, mime: r.mime, size: r.size };
      }),
    };
  }

  // Long-poll for `hive serve` and the human 接单台: offers to answer and paid orders to work on.
  async pollSeller(p: Principal, waitMs: number, asListener = p.actor === "agent") {
    if (asListener) await this.touchListener(p);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const work = await this.sellerInbox(p.accountId);
      if (work.offers.length || work.work.length || Date.now() >= deadline) return work;
      await this.waitFor(p.accountId, deadline - Date.now());
    }
  }

  private async sellerInbox(accountId: string) {
    const offers = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.status, "OFFERED"), sql`${accountId} = any(${orders.offeredTo})`));
    const work = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.sellerAccountId, accountId), inArray(orders.status, RESERVING)));
    return { offers: offers.map(publicOrder), work: work.map(publicOrder) };
  }

  private waitFor(accountId: string, ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.bus.off(accountId, done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.bus.on(accountId, done);
    });
  }

  // ---- reads ------------------------------------------------------------

  async getOrder(p: Principal, orderId: string) {
    const row = await this.loadOrder(orderId);
    const visible = row.buyerAccountId === p.accountId || row.sellerAccountId === p.accountId || row.offeredTo.includes(p.accountId);
    if (!visible) throw new HiveError(404, "order_not_found", "order not found");
    return publicOrder(row);
  }

  // One order with what the order page shows: the seller's name and the applied transitions.
  async orderDetail(p: Principal, orderId: string) {
    const order = await this.getOrder(p, orderId);
    const [seller] = order.sellerAccountId
      ? await this.db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, order.sellerAccountId))
      : [];
    const events = await this.db
      .select({ type: orderEvents.type, at: orderEvents.at })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, orderId))
      .orderBy(orderEvents.id);
    // Who does the work, from the seller's listing: an approved order can still be done by their agent.
    const [listing] = order.sellerAccountId
      ? await this.db
          .select({ workMode: listings.workMode })
          .from(listings)
          .where(and(eq(listings.sellerAccountId, order.sellerAccountId), eq(listings.category, order.category)))
      : [];
    return { ...order, sellerName: seller?.name ?? null, sellerWorkMode: listing?.workMode ?? null, events };
  }

  // Public catalog: every category with its sellable listings, cheapest and most reliable first.
  // Each seller says how they work, so a buyer (or their agent) can tell instant from by-hand.
  async market() {
    const cats = await this.listCategories();
    const today = startOfShanghaiDay(this.now());
    const rows = await this.db
      .select({ listing: listings, account: accounts })
      .from(listings)
      .innerJoin(accounts, eq(accounts.id, listings.sellerAccountId))
      .where(and(eq(listings.active, true), eq(listings.paymentStatus, "ENABLED")));
    const sellers = new Map<string, Array<Record<string, unknown> & { priceFen: number; passRate: number | null }>>();
    for (const { listing, account } of rows) {
      if (listing.priceFen === null) continue;
      const cat = cats.find((c) => c.id === listing.category);
      if (!cat) continue;
      const stats = await this.sellerStats(listing.sellerAccountId, listing.category, today);
      const list = sellers.get(listing.category) ?? [];
      list.push({
        name: account.name,
        tags: listing.tags,
        intro: listing.intro,
        acceptMode: listing.acceptMode,
        workMode: listing.workMode,
        workStyle: workStyle(listing),
        workTimeoutMs: workTimeoutMs(cat.workTimeoutMs, listing.workMode, listing.deliveryHours),
        priceFen: listing.priceFen,
        online: this.isOnline(listing, account),
        passRate: stats.passRate,
        completed: stats.completed,
      });
      sellers.set(listing.category, list);
    }
    return cats.map((c) => ({
      id: c.id,
      title: c.title,
      blurb: c.blurb,
      icon: c.icon,
      color: c.color,
      workTimeoutMs: c.workTimeoutMs,
      manualTimeoutMs: c.manualTimeoutMs,
      tags: c.tags,
      sellers: (sellers.get(c.id) ?? []).sort((a, b) => a.priceFen - b.priceFen || (b.passRate ?? 1) - (a.passRate ?? 1)),
    }));
  }

  async listOrders(p: Principal, role: "buyer" | "seller") {
    const col = role === "buyer" ? orders.buyerAccountId : orders.sellerAccountId;
    const rows = await this.db.select().from(orders).where(eq(col, p.accountId)).orderBy(desc(orders.createdAt)).limit(100);
    return rows.map(publicOrder);
  }

  // Money that actually moved: paid orders, from either side.
  async bill(p: Principal) {
    const paid = sql`${orders.paidAt} is not null`;
    const spent = await this.db.select().from(orders).where(and(eq(orders.buyerAccountId, p.accountId), paid)).orderBy(desc(orders.paidAt));
    const earned = await this.db.select().from(orders).where(and(eq(orders.sellerAccountId, p.accountId), paid)).orderBy(desc(orders.paidAt));
    const entry = (r: OrderRow) => ({
      orderId: r.id,
      category: r.category,
      priceFen: r.priceFen,
      paidAt: r.paidAt,
      createdByActor: r.createdByActor,
      status: r.status,
    });
    const sum = (rs: OrderRow[]) => rs.reduce((n, r) => n + (r.priceFen ?? 0), 0);
    return { spentFen: sum(spent), earnedFen: sum(earned), spent: spent.map(entry), earned: earned.map(entry) };
  }

  async listNotifications(p: Principal, afterId = 0) {
    return this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.accountId, p.accountId), gt(notifications.id, afterId)))
      .orderBy(desc(notifications.id))
      .limit(100);
  }

  async markNotificationRead(p: Principal, id: number) {
    await this.db
      .update(notifications)
      .set({ readAt: this.now() })
      .where(and(eq(notifications.id, id), eq(notifications.accountId, p.accountId)));
  }

  async markAllNotificationsRead(p: Principal) {
    await this.db
      .update(notifications)
      .set({ readAt: this.now() })
      .where(and(eq(notifications.accountId, p.accountId), isNull(notifications.readAt)));
  }

  // ---- web push ---------------------------------------------------------

  async subscribePush(p: Principal, target: PushTarget) {
    if (p.actor !== "human") throw new HiveError(403, "humans_only", "only the account owner can turn on notifications");
    if (!this.push) throw new HiveError(409, "push_disabled", "web push is not configured on this server");
    const values = { accountId: p.accountId, p256dh: target.keys.p256dh, auth: target.keys.auth };
    await this.db
      .insert(pushSubscriptions)
      .values({ endpoint: target.endpoint, ...values })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
  }

  async unsubscribePush(p: Principal, endpoint: string) {
    await this.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.accountId, p.accountId)));
  }

  // The 我的 page's "发一条试试": proves the browser receives push without placing an order.
  async testPush(p: Principal) {
    const sent = await this.pushTo(p.accountId, { title: "hive 通知已开启", body: "订单要你处理时会这样提醒你", url: "/me", tag: "test" });
    if (sent === 0) throw new HiveError(409, "no_subscription", "this account has no browser subscribed to notifications");
    return { sent };
  }

  // Sends to every browser the account subscribed; drops subscriptions the push service says are gone.
  private async pushTo(accountId: string, message: PushMessage) {
    if (!this.push) return 0;
    const subs = await this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.accountId, accountId));
    let sent = 0;
    for (const sub of subs) {
      try {
        await this.push.send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, message);
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
        else console.error("push failed", status ?? err);
      }
    }
    return sent;
  }

  // Waits for push and mail in flight; tests use it, the server never needs to.
  async settle() {
    while (this.outgoing.size) await Promise.all(this.outgoing);
  }

  // ---- background sweep -------------------------------------------------

  // Applies expired deadlines, retries dispatch, polls for payment and detects lost listeners.
  async tick() {
    const now = this.now();
    const expired = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(lte(orders.deadline, now), ne(orders.status, "COMPLETED")));
    for (const { id } of expired) {
      const row = await this.loadOrder(id);
      const event = expiryEvent(rowToOrder(row), now);
      if (event) await this.apply(id, event);
      if (event?.type === "offer_expired") await this.dispatch(id);
    }

    await this.redispatchWaiting();

    const awaiting = await this.db.select({ id: orders.id }).from(orders).where(eq(orders.status, "AWAITING_PAYMENT"));
    for (const { id } of awaiting) await this.detectPayment(id);

    // Fully automatic sellers must keep polling while they hold a paid order; anything a person
    // works on (approved or by hand) runs on its deadline alone.
    const quiet = new Date(now.getTime() - HEARTBEAT_LOST_MS);
    const lost = await this.db
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(accounts, eq(accounts.id, orders.sellerAccountId))
      .innerJoin(listings, eq(listings.id, orders.listingId))
      .where(
        and(
          inArray(orders.status, RESERVING),
          eq(listings.acceptMode, "auto"),
          eq(listings.workMode, "agent"),
          sql`coalesce(${accounts.listenerSeenAt}, 'epoch'::timestamptz) < ${quiet}`,
        ),
      );
    for (const { id } of lost) await this.apply(id, { type: "work_failed", reason: "heartbeat_lost" });
  }

  private async redispatchWaiting() {
    const waiting = await this.db.select({ id: orders.id }).from(orders).where(eq(orders.status, "DISPATCHING"));
    for (const { id } of waiting) await this.dispatch(id);
  }

  // ---- internals --------------------------------------------------------

  private async loadOrder(id: string) {
    const [row] = await this.db.select().from(orders).where(eq(orders.id, id));
    if (!row) throw new HiveError(404, "order_not_found", "order not found");
    return row;
  }

  private async requireBuyer(p: Principal, id: string) {
    const row = await this.loadOrder(id);
    if (row.buyerAccountId !== p.accountId) throw new HiveError(404, "order_not_found", "order not found");
    return row;
  }

  private async requireSeller(p: Principal, id: string) {
    const row = await this.loadOrder(id);
    if (row.sellerAccountId !== p.accountId) throw new HiveError(404, "order_not_found", "order not found");
    return row;
  }

  private async listingFor(row: OrderRow) {
    if (!row.listingId) throw new Error(`order ${row.id} has no listing`);
    const [listing] = await this.db.select().from(listings).where(eq(listings.id, row.listingId));
    if (!listing) throw new Error(`listing ${row.listingId} missing`);
    return listing;
  }

  // Applies one event under a row lock, then notifies whoever needs to know.
  private async apply(id: string, event: OrderEvent, extra: Partial<OrderRow> = {}): Promise<OrderRow> {
    const now = this.now();
    const saved = await this.db.transaction(async (tx) => {
      const row = await lockOrder(tx, id);
      if (!row) throw new HiveError(404, "order_not_found", "order not found");
      const result = transition(rowToOrder(row), event, now);
      if (!result.ok) throw new HiveError(409, "invalid_transition", result.error);
      return saveTransition(tx, row, result.order, event, now, extra);
    });
    await this.announce(saved, event);
    return saved;
  }

  private async dispatch(id: string) {
    const row = await this.loadOrder(id);
    if (row.status !== "DISPATCHING") return;
    const candidates = await this.candidateListings(row.category);
    const offer = nextOffer(candidates, {
      category: row.category,
      text: `${row.brief}\n${row.input === null ? "" : JSON.stringify(row.input)}`,
      buyerAccountId: row.buyerAccountId,
      maxPriceFen: row.maxPriceFen === null ? null : fen(row.maxPriceFen),
      passedBy: row.passedBy,
    });
    if (!offer) {
      await this.apply(id, { type: "no_candidates" });
      return;
    }
    await this.apply(id, { type: "offer", sellerAccountIds: offer.sellerAccountIds, kind: offer.kind });
    if (offer.platformAccepts) await this.acceptFor(offer.sellerAccountIds[0]!, id);
  }

  private async candidateListings(category: string): Promise<Listing[]> {
    const now = this.now();
    const rows = await this.db
      .select({ listing: listings, account: accounts })
      .from(listings)
      .innerJoin(accounts, eq(accounts.id, listings.sellerAccountId))
      .where(and(eq(listings.category, category), eq(listings.active, true), eq(listings.paymentStatus, "ENABLED")));
    const today = startOfShanghaiDay(now);
    const out: Listing[] = [];
    for (const { listing, account } of rows) {
      if (listing.priceFen === null) continue;
      const online = this.isOnline(listing, account);
      const stats = await this.sellerStats(listing.sellerAccountId, category, today);
      out.push({
        sellerAccountId: listing.sellerAccountId,
        category,
        tags: listing.tags,
        priceFen: fen(listing.priceFen),
        acceptMode: listing.acceptMode,
        workMode: listing.workMode,
        online,
        dailyLimit: listing.dailyLimit,
        ordersToday: stats.ordersToday,
        passRate: stats.passRate,
      });
    }
    return out;
  }

  // Fully automatic sellers are online while `hive serve` polls. Listings that need a person are
  // online while the seller's switch is on and they used hive recently; they don't need a listener.
  private isOnline(listing: typeof listings.$inferSelect, account: typeof accounts.$inferSelect) {
    const ago = (ms: number) => new Date(this.now().getTime() - ms);
    if (needsListener(listing)) return (account.listenerSeenAt ?? new Date(0)) > ago(PRESENCE_TTL_MS);
    return account.humanAccepting && (account.activeAt ?? new Date(0)) > ago(ACTIVE_TTL_MS);
  }

  private async sellerStats(sellerAccountId: string, category: string, today: Date) {
    const [today_] = (await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(
          eq(orders.sellerAccountId, sellerAccountId),
          eq(orders.category, category),
          ne(orders.status, "CANCELLED"),
          gte(orders.createdAt, today),
        ),
      )) as [{ n: number }];
    const [rate] = (await this.db
      .select({
        total: sql<number>`count(*)::int`,
        passed: sql<number>`count(*) filter (where ${orders.verdict} <> 'rejected')::int`,
      })
      .from(orders)
      .where(and(eq(orders.sellerAccountId, sellerAccountId), eq(orders.status, "COMPLETED")))) as [
      { total: number; passed: number },
    ];
    return { ordersToday: today_.n, completed: rate.total, passRate: rate.total ? rate.passed / rate.total : null };
  }

  // Leftover credit (e.g. from an earlier rejected purchase) pays immediately; otherwise create a purchase.
  private async requestPayment(id: string) {
    const row = await this.loadOrder(id);
    if (row.status !== "ACCEPTED") return;
    const listing = await this.listingFor(row);
    const requestNo = `purchase_${id}`;
    const purchase = await this.payments.createPurchase({
      requestNo,
      product: await this.productRef(listing),
      skuId: listing.skuId,
      buyerId: row.buyerAccountId,
    });
    await this.apply(
      id,
      { type: "payment_requested", purchaseUrl: purchase.purchaseUrl },
      { purchaseRequestNo: requestNo, purchaseQrCode: purchase.purchaseQrCode },
    );
    await this.detectPayment(id);
  }

  // 即刻收 has no payment notification: a count is "ours" once the buyer's remaining quota
  // exceeds the counts already reserved by other paid, undelivered orders on the same product.
  private async detectPayment(id: string) {
    const row = await this.loadOrder(id);
    if (row.status !== "AWAITING_PAYMENT") return;
    const listing = await this.listingFor(row);
    const remaining = await this.payments.remainingQuota({ product: await this.productRef(listing), buyerId: row.buyerAccountId });
    const [{ reserved }] = (await this.db
      .select({ reserved: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(
          eq(orders.listingId, listing.id),
          eq(orders.buyerAccountId, row.buyerAccountId),
          inArray(orders.status, RESERVING),
        ),
      )) as [{ reserved: number }];
    if (remaining - reserved < 1) return;
    await this.apply(id, { type: "payment_confirmed", paymentRef: row.purchaseRequestNo ?? id }, { paidAt: this.now() });
  }

  // Every notification goes to the in-app inbox; `reach` also sends it by push and mail to the
  // person, off the request path so a slow or broken channel never affects the order.
  private async notify(accountId: string, kind: string, orderId: string, body: string, reach = true) {
    await this.db.insert(notifications).values({ accountId, kind, orderId, body, createdAt: this.now() });
    this.bus.emit(accountId);
    if (!reach) return;
    const job = this.reach(accountId, kind, orderId, body)
      .catch((err) => console.error("notification delivery failed", err))
      .finally(() => this.outgoing.delete(job));
    this.outgoing.add(job);
  }

  private async reach(accountId: string, kind: string, orderId: string, body: string) {
    const title = NOTICE_TITLE[kind] ?? "hive 订单更新";
    const path = `/orders/${orderId}`;
    const { email } = await this.getAccount(accountId);
    await Promise.all([
      this.pushTo(accountId, { title, body, url: path, tag: `${orderId}:${kind}` }),
      email &&
        this.mailer
          .send({ to: email, subject: `hive：${title}`, text: `${body}\n\n查看订单：${this.webUrl}${path}\n\n—— hive` })
          .catch((err) => console.error("mail failed", err)),
    ]);
  }

  private async announce(row: OrderRow, event: OrderEvent) {
    const title = (await this.listCategories()).find((c) => c.id === row.category)?.title ?? row.category;
    const price = row.priceFen === null ? "" : `${(row.priceFen / 100).toFixed(2)} 元`;
    const buyer = row.buyerAccountId;
    const seller = row.sellerAccountId;
    // A fully automatic seller's person isn't pinged for routine steps their agent handles; only failures.
    const listing = row.listingId ? await this.listingFor(row) : null;
    const sellerReach = !(listing?.acceptMode === "auto" && listing.workMode === "agent");
    switch (event.type) {
      case "offer":
        for (const s of event.sellerAccountIds) {
          if (event.kind === "human") await this.notify(s, "offer", row.id, `新任务：${title}，${TIMEOUTS.offer.human / 60_000} 分钟内有效`);
          else this.bus.emit(s);
        }
        break;
      case "payment_requested":
        await this.notify(buyer, "payment_required", row.id, `请在支付宝确认付款：${title} ${price}`);
        break;
      case "payment_confirmed":
        if (seller) await this.notify(seller, "paid", row.id, `买家已付款，可以开始：${title} ${price}`, sellerReach);
        break;
      case "delivery_submitted":
        if (row.status === "DELIVERED") await this.notify(buyer, "delivered", row.id, `已交付，请验收：${title}`);
        break;
      case "work_failed":
        await this.notify(buyer, "failed", row.id, `${title}：${FAIL_TEXT[event.reason] ?? event.reason}`);
        if (seller) await this.notify(seller, "failed", row.id, `${title}：${FAIL_TEXT[event.reason] ?? event.reason}`);
        break;
      case "buyer_verdict":
      case "acceptance_expired":
        if (seller) await this.notify(seller, "completed", row.id, `${title}：${VERDICT_TEXT[row.verdict ?? ""] ?? "订单完成"}`, sellerReach);
        break;
      case "no_candidates":
      case "payment_expired":
        await this.notify(buyer, "cancelled", row.id, `${title}：${CANCEL_TEXT[row.cancelReason ?? ""] ?? "订单已取消"}`);
        break;
      default:
        break;
    }
  }
}

// Order as exposed over the API.
// Delivered files carry a download link relative to the API's origin.
export const fileRef = (f: DeliveredFile) => ({ ...f, url: `/v1/files/${f.id}` });

export function publicOrder(r: OrderRow) {
  const output = r.output as Delivery | null;
  return {
    id: r.id,
    category: r.category,
    status: r.status,
    buyerAccountId: r.buyerAccountId,
    sellerAccountId: r.sellerAccountId,
    createdByActor: r.createdByActor,
    brief: r.brief,
    input: r.input,
    deliverySpec: r.deliverySpec,
    output: output && { ...output, files: (output.files ?? []).map(fileRef) },
    priceFen: r.priceFen,
    deadline: r.deadline,
    offerKind: r.offerKind,
    purchaseUrl: r.purchaseUrl,
    purchaseQrCode: r.purchaseQrCode,
    paidAt: r.paidAt,
    deliveryAttempts: r.deliveryAttempts,
    lastDeliveryError: r.lastDeliveryError,
    verdict: r.verdict,
    cancelReason: r.cancelReason,
    failReason: r.failReason,
    refundEligible: r.refundEligible,
    createdAt: r.createdAt,
  };
}
