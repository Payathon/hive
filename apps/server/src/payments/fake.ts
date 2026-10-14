import { fen, type Fen } from "@hive/core";
import {
  RefundNotImplemented,
  type ChargeState,
  type ConsumeStatus,
  type PaymentProvider,
  type ProductRef,
  type Purchase,
} from "./provider.ts";

const quotaKey = (productId: string, buyerId: string) => `${productId}\u0000${buyerId}`;

// In-memory stand-in for 即刻收, used in tests and local runs without Alipay credentials.
// Products are ENABLED immediately at a default price; purchases complete via completePurchase().
export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake";
  private prices = new Map<string, Fen>();
  private purchases = new Map<string, { productId: string; buyerId: string; completed: boolean }>();
  private quota = new Map<string, number>();
  private consumed = new Map<string, ConsumeStatus>();

  constructor(
    private readonly baseUrl: string,
    private readonly defaultPriceFen: Fen = fen(500),
  ) {}

  setPrice(productId: string, priceFen: Fen) {
    this.prices.set(productId, priceFen);
  }

  async setupProduct(product: ProductRef): Promise<ChargeState> {
    return {
      status: "ENABLED",
      priceFen: this.prices.get(product.productId) ?? this.defaultPriceFen,
      skuId: `fake-sku-${product.productId}`,
      configurationUrl: null,
      configurationQrCode: null,
      managementUrl: `${this.baseUrl}/v1/dev/fake-pay/products/${product.productId}`,
    };
  }

  async createPurchase(p: { requestNo: string; product: ProductRef; buyerId: string }): Promise<Purchase> {
    if (!this.purchases.has(p.requestNo)) {
      this.purchases.set(p.requestNo, { productId: p.product.productId, buyerId: p.buyerId, completed: false });
    }
    return {
      purchaseUrl: `${this.baseUrl}/v1/dev/fake-pay/${encodeURIComponent(p.requestNo)}`,
      purchaseQrCode: null,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    };
  }

  // What the buyer's tap in Alipay would do: credit one count to the buyer.
  completePurchase(requestNo: string): boolean {
    const purchase = this.purchases.get(requestNo);
    if (!purchase) return false;
    if (!purchase.completed) {
      purchase.completed = true;
      const k = quotaKey(purchase.productId, purchase.buyerId);
      this.quota.set(k, (this.quota.get(k) ?? 0) + 1);
    }
    return true;
  }

  async remainingQuota(p: { product: ProductRef; buyerId: string }): Promise<number> {
    return this.quota.get(quotaKey(p.product.productId, p.buyerId)) ?? 0;
  }

  async consume(p: { requestNo: string; product: ProductRef; buyerId: string }): Promise<ConsumeStatus> {
    const prior = this.consumed.get(p.requestNo);
    if (prior) return prior;
    const k = quotaKey(p.product.productId, p.buyerId);
    const left = this.quota.get(k) ?? 0;
    const status: ConsumeStatus = left >= 1 ? "SUCCEEDED" : "INSUFFICIENT";
    if (status === "SUCCEEDED") this.quota.set(k, left - 1);
    this.consumed.set(p.requestNo, status);
    return status;
  }

  async refund(): Promise<never> {
    throw new RefundNotImplemented();
  }
}
