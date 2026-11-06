import type { Fen } from "@hive/core";

// What hive sells: one listing (seller × category). Each 即刻收 provider maps it to a product,
// configured as a QUANTITY/COUNT product with a "1 次" tier. hive never holds funds.
// - platform mode: one product per listing (out_product_id = listing id, external_owner_id = seller)
// - direct mode: the merchant's own hand-made product(s), shared by every listing
export interface ProductRef {
  productId: string; // our listing id
  ownerId: string; // seller account id
  category: string;
  productName: string;
}

export type ChargeStatus =
  | "NOT_CONFIGURED"
  | "CONFIGURING"
  | "PENDING"
  | "ACTION_REQUIRED"
  | "ENABLED"
  | "DISABLED"
  | "TERMINATED";

export interface ChargeState {
  status: ChargeStatus;
  // Price and tier of the single-count option, once the seller has configured one.
  priceFen: Fen | null;
  skuId: string | null;
  // Where the seller goes next: finish configuration, or manage the product.
  configurationUrl: string | null;
  configurationQrCode: string | null;
  managementUrl: string | null;
  // Why the listing can't take payment yet and what to do, when there is no configuration link.
  note?: string | null;
}

export interface Purchase {
  purchaseUrl: string;
  purchaseQrCode: string | null;
  expiresAt: Date;
}

export type ConsumeStatus = "SUCCEEDED" | "FAILED" | "PROCESSING" | "INSUFFICIENT";

// 即刻收: buyers buy counts of a pre-configured product, and an order consumes one on delivery.
export interface QuotaPaymentProvider {
  readonly kind: "quota";
  readonly name: string;
  // Which buyer quota a listing's payments land in. Listings with the same key share one
  // 即刻收 product, so payment detection must count reservations across all of them.
  quotaKey(product: ProductRef): string;
  // charge.query (platform mode: then charge.initialize while the product isn't configured yet).
  setupProduct(product: ProductRef): Promise<ChargeState>;
  // purchase.create for the single-count tier. Retries must reuse requestNo.
  createPurchase(p: { requestNo: string; product: ProductRef; skuId: string | null; buyerId: string }): Promise<Purchase>;
  // quota.query: there is no payment notification, so payment is detected by polling this.
  remainingQuota(p: { product: ProductRef; buyerId: string }): Promise<number>;
  // quota.verify with amount 1. Idempotent on requestNo: a retry with the same requestNo and
  // reason never consumes twice. PROCESSING means "ask again later with the same requestNo".
  consume(p: { requestNo: string; product: ProductRef; buyerId: string; reason: string }): Promise<ConsumeStatus>;
  refund(): Promise<never>;
}

// 电脑网站支付: one trade per order at the order's own price, confirmed by notification or query.
export type TradeState = "pending" | "paid" | "closed";
// SUCCEEDED and FAILED are final; PROCESSING means "ask again later with the same request number".
export type RefundStatus = "SUCCEEDED" | "FAILED" | "PROCESSING";

export interface TradePaymentProvider {
  readonly kind: "trade";
  readonly name: string;
  // Signs a cashier link locally; the trade exists at Alipay once the buyer opens it.
  createTrade(p: { outTradeNo: string; amountFen: Fen; subject: string; expiresAt: Date; returnUrl?: string | undefined }): Promise<Purchase>;
  queryTrade(outTradeNo: string): Promise<{ state: TradeState; tradeNo: string | null }>;
  // Shuts an unpaid trade; a missing or already settled one is left alone.
  closeTrade(outTradeNo: string): Promise<void>;
  // Idempotent on requestNo: a retry never refunds twice.
  refund(p: { outTradeNo: string; requestNo: string; amountFen: Fen; reason: string }): Promise<{ status: RefundStatus; error?: string }>;
  queryRefund(p: { outTradeNo: string; requestNo: string }): Promise<RefundStatus>;
  // The order id a signed notification is about, or null if it isn't Alipay's or not for this app.
  verifyNotification(params: Record<string, string>): string | null;
}

export type PaymentProvider = QuotaPaymentProvider | TradePaymentProvider;

export class RefundNotImplemented extends Error {
  constructor() {
    super("refunds are not implemented yet (see docs/design.md §3)");
  }
}
