import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  capabilityTypes,
  checkInput,
  checkOutput,
  expiryEvent,
  fen,
  isCapabilityType,
  newOrder,
  nextOffer,
  transition,
  type CapabilityType,
  type Fen,
  type Listing,
  type OrderEvent,
} from "@hive/core";
import type { Db } from "./db/client.ts";
import { accounts, deviceLogins, listings, notifications, orderEvents, orders, tokens } from "./db/schema.ts";
import { lockOrder, orderColumns, rowToOrder, saveTransition, type OrderRow } from "./orders-repo.ts";
import type { PaymentProvider, ProductRef } from "./payments/provider.ts";

export type Actor = "human" | "agent";
export interface Principal {
  accountId: string;
  actor: Actor;
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

// A listener or human that hasn't checked in for this long is offline.
export const PRESENCE_TTL_MS = 60_000;
// An agent seller whose listener goes quiet this long mid-order has abandoned it (design §3, #12).
export const HEARTBEAT_LOST_MS = 2 * 60_000;
const DEVICE_LOGIN_TTL_MS = 10 * 60_000;

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
  clock?: () => Date;
}

export class Hive {
  readonly db: Db;
  readonly payments: PaymentProvider;
  private readonly clock: () => Date;
  // Wakes long-polls for an account when something it cares about changes.
  private readonly bus = new EventEmitter().setMaxListeners(0);

  constructor(opts: HiveOptions) {
    this.db = opts.db;
    this.payments = opts.payments;
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
      await tx.insert(tokens).values({ tokenHash: sha256(token), accountId: id, actor: "human", label: "signup" });
    });
    return { accountId: id, token };
  }

  async authenticate(token: string): Promise<Principal | null> {
    const [row] = await this.db
      .select({ accountId: tokens.accountId, actor: tokens.actor })
      .from(tokens)
      .where(and(eq(tokens.tokenHash, sha256(token)), isNull(tokens.revokedAt)));
    return row ?? null;
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
    await this.db.insert(tokens).values({ tokenHash: sha256(key), accountId: p.accountId, actor: "agent", label });
    return { key };
  }

  // Called by a signed-in human to bind the waiting CLI to their account as an agent.
  async approveDeviceLogin(p: Principal, userCode: string) {
    if (p.actor !== "human") throw new HiveError(403, "humans_only", "only the account owner can approve an agent");
    const token = newToken();
    await this.db.transaction(async (tx) => {
      const [dl] = await tx.select().from(deviceLogins).where(eq(deviceLogins.userCode, userCode.toUpperCase())).for("update");
      if (!dl || dl.expiresAt < this.now()) throw new HiveError(404, "login_not_found", "unknown or expired code");
      if (dl.accountId) throw new HiveError(409, "login_used", "this code was already approved");
      await tx.insert(tokens).values({ tokenHash: sha256(token), accountId: p.accountId, actor: "agent", label: dl.label });
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

  // ---- listings ---------------------------------------------------------

  async upsertListing(p: Principal, type: string, opts: { acceptMode: "auto" | "ask"; dailyLimit: number; active?: boolean }) {
    if (!isCapabilityType(type)) throw new HiveError(404, "unknown_type", `unknown capability type ${type}`);
    const values = { acceptMode: opts.acceptMode, dailyLimit: opts.dailyLimit, active: opts.active ?? true };
    const [row] = await this.db
      .insert(listings)
      .values({ id: newId("lst"), sellerAccountId: p.accountId, capabilityType: type, ...values })
      .onConflictDoUpdate({ target: [listings.sellerAccountId, listings.capabilityType], set: values })
      .returning();
    return row!;
  }

  async myListings(accountId: string) {
    return this.db.select().from(listings).where(eq(listings.sellerAccountId, accountId));
  }

  private productRef(listing: typeof listings.$inferSelect): ProductRef {
    const type = listing.capabilityType as CapabilityType;
    return {
      productId: listing.id,
      ownerId: listing.sellerAccountId,
      productName: `hive · ${capabilityTypes[type]?.title ?? type}`,
    };
  }

  // Walks the seller through 即刻收 configuration and syncs the price they set there.
  async setupListingPayment(p: Principal, type: string) {
    const [listing] = await this.db
      .select()
      .from(listings)
      .where(and(eq(listings.sellerAccountId, p.accountId), eq(listings.capabilityType, type)));
    if (!listing) throw new HiveError(404, "listing_not_found", "list this capability first");
    const state = await this.payments.setupProduct(this.productRef(listing));
    await this.db
      .update(listings)
      .set({ paymentStatus: state.status, priceFen: state.priceFen, skuId: state.skuId })
      .where(eq(listings.id, listing.id));
    return state;
  }

  // ---- presence ---------------------------------------------------------

  async setHumanAccepting(p: Principal, on: boolean) {
    if (p.actor !== "human") throw new HiveError(403, "humans_only", "agents go online with `hive serve`");
    await this.db
      .update(accounts)
      .set({ humanAccepting: on, humanSeenAt: this.now() })
      .where(eq(accounts.id, p.accountId));
  }

  // `hive serve` polls as a listener even with an owner token; other polls default by actor.
  private async touchPresence(p: Principal, asListener: boolean) {
    const set = asListener ? { listenerSeenAt: this.now() } : { humanSeenAt: this.now() };
    await this.db.update(accounts).set(set).where(eq(accounts.id, p.accountId));
  }

  // ---- orders: buyer side -----------------------------------------------

  async createOrder(p: Principal, type: string, input: unknown) {
    if (!isCapabilityType(type)) throw new HiveError(404, "unknown_type", `unknown capability type ${type}`);
    const checked = checkInput(type, input);
    if (!checked.ok) throw new HiveError(422, "invalid_input", checked.error);

    const account = await this.getAccount(p.accountId);
    if (account.paused) throw new HiveError(403, "account_paused", "this account is paused by its owner");
    const maxPriceFen = await this.budgetFor(account);
    if (maxPriceFen !== null && maxPriceFen <= 0) {
      throw new HiveError(403, "daily_cap_reached", "today's spending cap is used up");
    }

    const order = newOrder({ id: newId("ord"), capabilityType: type, buyerAccountId: p.accountId, input: checked.value });
    await this.db.insert(orders).values({
      id: order.id,
      capabilityType: type,
      buyerAccountId: p.accountId,
      createdByActor: p.actor,
      input: order.input as object,
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
    const row = await this.loadOrder(orderId);
    const [listing] = await this.db
      .select()
      .from(listings)
      .where(and(eq(listings.sellerAccountId, p.accountId), eq(listings.capabilityType, row.capabilityType)));
    if (!listing || listing.priceFen === null) throw new HiveError(409, "listing_not_ready", "no priced listing for this type");
    await this.apply(
      orderId,
      { type: "seller_accept", sellerAccountId: p.accountId, priceFen: fen(listing.priceFen) },
      { listingId: listing.id },
    );
    await this.requestPayment(orderId);
    return this.getOrder(p, orderId);
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

  async deliver(p: Principal, orderId: string, output: unknown) {
    const row = await this.requireSeller(p, orderId);
    if (row.status !== "IN_PROGRESS") throw new HiveError(409, "not_in_progress", `order is ${row.status}`);
    const order = rowToOrder(row);
    if (!checkOutput(order.capabilityType, output).ok) {
      // Records the attempt and error; the seller may resubmit before the deadline.
      await this.apply(orderId, { type: "delivery_submitted", output });
      const saved = await this.loadOrder(orderId);
      throw new HiveError(422, "invalid_output", saved.lastDeliveryError ?? "output does not match the schema");
    }
    // Consume the paid count before accepting the delivery; quota.verify is idempotent on the request number.
    const listing = await this.listingFor(row);
    const status = await this.payments.consume({
      requestNo: `consume_${orderId}`,
      product: this.productRef(listing),
      buyerId: row.buyerAccountId,
      reason: `hive ${order.capabilityType} ${orderId}`,
    });
    if (status === "PROCESSING") throw new HiveError(409, "consume_processing", "payment consumption pending, retry shortly");
    if (status !== "SUCCEEDED") throw new HiveError(502, "consume_failed", `could not consume the paid count: ${status}`);
    await this.apply(orderId, { type: "delivery_submitted", output });
    return this.getOrder(p, orderId);
  }

  // Long-poll for `hive serve` and the human 接单台: offers to answer and paid orders to work on.
  async pollSeller(p: Principal, waitMs: number, asListener = p.actor === "agent") {
    await this.touchPresence(p, asListener);
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
    return { ...order, sellerName: seller?.name ?? null, events };
  }

  // Public catalog: every capability type with its sellable listings, cheapest and most reliable first.
  async market() {
    const fresh = new Date(this.now().getTime() - PRESENCE_TTL_MS);
    const today = startOfShanghaiDay(this.now());
    const rows = await this.db
      .select({ listing: listings, account: accounts })
      .from(listings)
      .innerJoin(accounts, eq(accounts.id, listings.sellerAccountId))
      .where(and(eq(listings.active, true), eq(listings.paymentStatus, "ENABLED")));
    const sellers = new Map<string, Array<Record<string, unknown> & { priceFen: number; passRate: number | null }>>();
    for (const { listing, account } of rows) {
      if (listing.priceFen === null) continue;
      const stats = await this.sellerStats(listing.sellerAccountId, listing.capabilityType, today);
      const list = sellers.get(listing.capabilityType) ?? [];
      list.push({
        name: account.name,
        kind: listing.acceptMode === "auto" ? "agent" : "human",
        priceFen: listing.priceFen,
        online: isOnline(listing, account, fresh),
        passRate: stats.passRate,
        completed: stats.completed,
      });
      sellers.set(listing.capabilityType, list);
    }
    return Object.entries(capabilityTypes).map(([type, t]) => ({
      type,
      title: t.title,
      workTimeoutMs: t.workTimeoutMs,
      sellers: (sellers.get(type) ?? []).sort((a, b) => a.priceFen - b.priceFen || (b.passRate ?? 1) - (a.passRate ?? 1)),
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
      capabilityType: r.capabilityType,
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

    // Agent sellers must keep polling while they hold a paid order; humans are out doing the job.
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
    const candidates = await this.candidateListings(row.capabilityType as CapabilityType);
    const offer = nextOffer(candidates, {
      capabilityType: row.capabilityType as CapabilityType,
      buyerAccountId: row.buyerAccountId,
      maxPriceFen: row.maxPriceFen === null ? null : fen(row.maxPriceFen),
      passedBy: row.passedBy,
    });
    if (!offer) {
      await this.apply(id, { type: "no_candidates" });
      return;
    }
    await this.apply(id, { type: "offer", sellerAccountIds: offer.sellerAccountIds, kind: offer.kind });
  }

  private async candidateListings(type: CapabilityType): Promise<Listing[]> {
    const now = this.now();
    const fresh = new Date(now.getTime() - PRESENCE_TTL_MS);
    const rows = await this.db
      .select({ listing: listings, account: accounts })
      .from(listings)
      .innerJoin(accounts, eq(accounts.id, listings.sellerAccountId))
      .where(and(eq(listings.capabilityType, type), eq(listings.active, true), eq(listings.paymentStatus, "ENABLED")));
    const today = startOfShanghaiDay(now);
    const out: Listing[] = [];
    for (const { listing, account } of rows) {
      if (listing.priceFen === null) continue;
      const online = isOnline(listing, account, fresh);
      const stats = await this.sellerStats(listing.sellerAccountId, type, today);
      out.push({
        sellerAccountId: listing.sellerAccountId,
        capabilityType: type,
        priceFen: fen(listing.priceFen),
        acceptMode: listing.acceptMode,
        online,
        dailyLimit: listing.dailyLimit,
        ordersToday: stats.ordersToday,
        passRate: stats.passRate,
      });
    }
    return out;
  }

  private async sellerStats(sellerAccountId: string, type: string, today: Date) {
    const [today_] = (await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(
          eq(orders.sellerAccountId, sellerAccountId),
          eq(orders.capabilityType, type),
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
      product: this.productRef(listing),
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
    const remaining = await this.payments.remainingQuota({ product: this.productRef(listing), buyerId: row.buyerAccountId });
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

  private async notify(accountId: string, kind: string, orderId: string, body: string) {
    await this.db.insert(notifications).values({ accountId, kind, orderId, body, createdAt: this.now() });
    this.bus.emit(accountId);
  }

  private async announce(row: OrderRow, event: OrderEvent) {
    const title = capabilityTypes[row.capabilityType as CapabilityType]?.title ?? row.capabilityType;
    const price = row.priceFen === null ? "" : `${(row.priceFen / 100).toFixed(2)} 元`;
    const buyer = row.buyerAccountId;
    const seller = row.sellerAccountId;
    switch (event.type) {
      case "offer":
        for (const s of event.sellerAccountIds) {
          if (event.kind === "human") await this.notify(s, "offer", row.id, `新任务：${title}，3 分钟内有效`);
          else this.bus.emit(s);
        }
        break;
      case "payment_requested":
        await this.notify(buyer, "payment_required", row.id, `请在支付宝确认付款：${title} ${price}`);
        break;
      case "payment_confirmed":
        if (seller) await this.notify(seller, "paid", row.id, `买家已付款，可以开始：${title} ${price}`);
        break;
      case "delivery_submitted":
        if (row.status === "DELIVERED") await this.notify(buyer, "delivered", row.id, `已交付，请验收：${title}`);
        break;
      case "work_failed":
        await this.notify(buyer, "failed", row.id, `订单失败（${event.reason}）：${title}`);
        if (seller) await this.notify(seller, "failed", row.id, `订单失败（${event.reason}）：${title}`);
        break;
      case "buyer_verdict":
      case "acceptance_expired":
        if (seller) await this.notify(seller, "completed", row.id, `订单完成（${row.verdict}）：${title}`);
        break;
      case "no_candidates":
      case "payment_expired":
        await this.notify(buyer, "cancelled", row.id, `订单已取消（${row.cancelReason}）：${title}`);
        break;
      default:
        break;
    }
  }
}

// Agent sellers are online while `hive serve` polls; human sellers while they keep the 接单台 open.
function isOnline(listing: typeof listings.$inferSelect, account: typeof accounts.$inferSelect, fresh: Date) {
  return listing.acceptMode === "auto"
    ? (account.listenerSeenAt ?? new Date(0)) > fresh
    : account.humanAccepting && (account.humanSeenAt ?? new Date(0)) > fresh;
}

// Order as exposed over the API.
export function publicOrder(r: OrderRow) {
  return {
    id: r.id,
    capabilityType: r.capabilityType,
    status: r.status,
    buyerAccountId: r.buyerAccountId,
    sellerAccountId: r.sellerAccountId,
    createdByActor: r.createdByActor,
    input: r.input,
    output: r.output,
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
