import type { Fen } from "@hive/core";

// What hive sells: one listing (seller × category). Each provider maps it to a 即刻收 product,
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

export interface PaymentProvider {
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

export class RefundNotImplemented extends Error {
  constructor() {
    super("refunds are not implemented yet (see docs/design.md §3)");
  }
}
