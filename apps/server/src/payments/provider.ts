import type { Fen } from "@hive/core";

// One 即刻收 product per (seller × capability type), configured as a QUANTITY/COUNT
// product with a "1 次" tier. hive never holds funds: buyers pay sellers directly.
export interface ProductRef {
  productId: string; // out_product_id: our listing id
  ownerId: string; // external_owner_id: seller account id
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
}

export interface Purchase {
  purchaseUrl: string;
  purchaseQrCode: string | null;
  expiresAt: Date;
}

export type ConsumeStatus = "SUCCEEDED" | "FAILED" | "PROCESSING" | "INSUFFICIENT";

export interface PaymentProvider {
  readonly name: string;
  // charge.query, then charge.initialize while the product isn't configured yet.
  setupProduct(product: ProductRef): Promise<ChargeState>;
  // purchase.create for the single-count tier. Retries must reuse requestNo.
  createPurchase(p: { requestNo: string; product: ProductRef; skuId: string | null; buyerId: string }): Promise<Purchase>;
  // quota.query: there is no payment notification, so payment is detected by polling this.
  remainingQuota(p: { product: ProductRef; buyerId: string }): Promise<number>;
  // quota.verify with amount 1. Idempotent on requestNo.
  consume(p: { requestNo: string; product: ProductRef; buyerId: string; reason: string }): Promise<ConsumeStatus>;
  refund(): Promise<never>;
}

export class RefundNotImplemented extends Error {
  constructor() {
    super("refunds are not implemented yet (see docs/design.md §3)");
  }
}
