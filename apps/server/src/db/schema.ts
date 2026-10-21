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
  // Human seller presence: they explicitly start accepting and keep a heartbeat.
  humanAccepting: boolean("human_accepting").notNull().default(false),
  humanSeenAt: ts("human_seen_at"),
  // Agent seller presence: the `hive serve` listener's last poll.
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

export const listings = pgTable(
  "listings",
  {
    id: text("id").primaryKey(),
    sellerAccountId: text("seller_account_id")
      .notNull()
      .references(() => accounts.id),
    capabilityType: text("capability_type").notNull(),
    acceptMode: text("accept_mode", { enum: ["auto", "ask"] }).notNull(),
    dailyLimit: integer("daily_limit").notNull(),
    active: boolean("active").notNull().default(true),
    // Synced from the payment provider: the seller sets the price on Alipay's hosted page.
    priceFen: integer("price_fen"),
    skuId: text("sku_id"),
    paymentStatus: text("payment_status").notNull().default("NOT_CONFIGURED"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("listings_seller_type").on(t.sellerAccountId, t.capabilityType)],
);

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    version: integer("version").notNull().default(0),
    capabilityType: text("capability_type").notNull(),
    buyerAccountId: text("buyer_account_id")
      .notNull()
      .references(() => accounts.id),
    createdByActor: text("created_by_actor", { enum: ["human", "agent"] }).notNull(),
    // tokens.id of the caller, so the owner can see what each agent ordered.
    createdByToken: text("created_by_token"),
    input: jsonb("input").notNull(),
    maxPriceFen: integer("max_price_fen"),
    status: text("status").notNull(),
    deadline: ts("deadline"),
    offeredTo: text("offered_to").array().notNull().default(sql`'{}'`),
    offerKind: text("offer_kind", { enum: ["agent", "human"] }),
    passedBy: text("passed_by").array().notNull().default(sql`'{}'`),
    sellerAccountId: text("seller_account_id").references(() => accounts.id),
    listingId: text("listing_id").references(() => listings.id),
    priceFen: integer("price_fen"),
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
