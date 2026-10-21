import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Owner rules (design §4). Null cap means unlimited.
  perOrderCapFen: integer("per_order_cap_fen"),
  dailyCapFen: integer("daily_cap_fen"),
  paused: boolean("paused").notNull().default(false),
  // The 接单台 switch: listings that need a person are only dispatched while it's on.
  humanAccepting: boolean("human_accepting").notNull().default(true),
  // Last authenticated request from any client (app, CLI, MCP); "active" for listings that need a person.
  activeAt: ts("active_at"),
  // Fully automatic presence: the `hive serve` listener's last poll.
  listenerSeenAt: ts("listener_seen_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tokens = pgTable("tokens", {
  tokenHash: text("token_hash").primaryKey(),
  // Public handle for listing and revoking without exposing the hash.
  id: text("id").notNull().unique(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  // Who drives the account with this token; orders record it ("由 agent 发起").
  actor: text("actor", { enum: ["human", "agent"] }).notNull(),
  label: text("label"),
  // How an agent token was issued; null for owner tokens.
  source: text("source", { enum: ["login", "api_key"] }),
  createdAt: ts("created_at").notNull().defaultNow(),
  revokedAt: ts("revoked_at"),
});

// `hive login` device flow: the CLI polls with a secret until a human approves the user code.
export const deviceLogins = pgTable("device_logins", {
  id: text("id").primaryKey(),
  userCode: text("user_code").notNull().unique(),
  secretHash: text("secret_hash").notNull(),
  label: text("label"),
  accountId: text("account_id").references(() => accounts.id),
  // Plain token handed to the CLI exactly once, then cleared.
  pendingToken: text("pending_token"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// The coarse catalogue dispatch matches on. Adding one is a row, not a code change.
export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  blurb: text("blurb").notNull(),
  // Two-character label and colour for the icon tile.
  icon: text("icon").notNull(),
  color: text("color").notNull(),
  // Default work time when the seller's agent does the job, and when a person does (who may set their own).
  workTimeoutMs: integer("work_timeout_ms").notNull(),
  manualTimeoutMs: integer("manual_timeout_ms").notNull(),
  // Suggested listing tags, offered when a seller lists here.
  tags: text("tags").array().notNull().default(sql`'{}'`),
  sort: integer("sort").notNull().default(0),
});

export const listings = pgTable(
  "listings",
  {
    id: text("id").primaryKey(),
    sellerAccountId: text("seller_account_id")
      .notNull()
      .references(() => accounts.id),
    category: text("category")
      .notNull()
      .references(() => categories.id),
    // Free keywords matched against an order's text, and a line about the seller.
    tags: text("tags").array().notNull().default(sql`'{}'`),
    intro: text("intro"),
    acceptMode: text("accept_mode", { enum: ["auto", "ask"] }).notNull(),
    // Who does the work once paid (design §2); `manual` work is timed by the seller's own promise.
    workMode: text("work_mode", { enum: ["agent", "manual"] }).notNull().default("agent"),
    deliveryHours: integer("delivery_hours"),
    dailyLimit: integer("daily_limit").notNull(),
    active: boolean("active").notNull().default(true),
    // Synced from the payment provider: the seller sets the price on Alipay's hosted page.
    priceFen: integer("price_fen"),
    skuId: text("sku_id"),
    paymentStatus: text("payment_status").notNull().default("NOT_CONFIGURED"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("listings_seller_category").on(t.sellerAccountId, t.category)],
);

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    version: integer("version").notNull().default(0),
    category: text("category")
      .notNull()
      .references(() => categories.id),
    buyerAccountId: text("buyer_account_id")
      .notNull()
      .references(() => accounts.id),
    createdByActor: text("created_by_actor", { enum: ["human", "agent"] }).notNull(),
    // tokens.id of the caller, so the owner can see what each agent ordered.
    createdByToken: text("created_by_token"),
    // What the buyer wants in words, optional structured input, and the delivery format they asked for.
    brief: text("brief").notNull().default(""),
    input: jsonb("input"),
    deliverySpec: jsonb("delivery_spec").notNull().default({ kind: "any" }),
    maxPriceFen: integer("max_price_fen"),
    status: text("status").notNull(),
    deadline: ts("deadline"),
    offeredTo: text("offered_to").array().notNull().default(sql`'{}'`),
    offerKind: text("offer_kind", { enum: ["agent", "human"] }),
    passedBy: text("passed_by").array().notNull().default(sql`'{}'`),
    sellerAccountId: text("seller_account_id").references(() => accounts.id),
    listingId: text("listing_id").references(() => listings.id),
    priceFen: integer("price_fen"),
    workTimeoutMs: integer("work_timeout_ms"),
    purchaseRequestNo: text("purchase_request_no"),
    purchaseUrl: text("purchase_url"),
    purchaseQrCode: text("purchase_qr_code"),
    paymentRef: text("payment_ref"),
    paidAt: ts("paid_at"),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    lastDeliveryError: text("last_delivery_error"),
    output: jsonb("output"),
    verdict: text("verdict", { enum: ["accepted", "rejected", "auto_accepted"] }),
    cancelReason: text("cancel_reason"),
    failReason: text("fail_reason"),
    refundEligible: boolean("refund_eligible").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("orders_status_deadline").on(t.status, t.deadline),
    index("orders_buyer").on(t.buyerAccountId),
    index("orders_seller").on(t.sellerAccountId),
  ],
);

// Files a seller uploaded for an order; the bytes live in the file store under the same id.
export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("files_order").on(t.orderId)],
);

// Append-only audit trail of applied transitions.
export const orderEvents = pgTable("order_events", {
  id: serial("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id),
  type: text("type").notNull(),
  payload: jsonb("payload"),
  at: ts("at").notNull().defaultNow(),
});

// Reserved for refunds (design §3); nothing writes here yet.
export const refunds = pgTable("refunds", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id),
  status: text("status", { enum: ["REQUESTED", "PROCESSING", "SUCCEEDED", "FAILED"] }).notNull(),
  amountFen: integer("amount_fen").notNull(),
  reason: text("reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    kind: text("kind").notNull(),
    orderId: text("order_id").references(() => orders.id),
    body: text("body").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    readAt: ts("read_at"),
  },
  (t) => [index("notifications_account").on(t.accountId, t.id)],
);
