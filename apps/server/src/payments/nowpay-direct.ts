import { AlipaySdk, type AlipaySdkCommonResult } from "alipay-sdk";
import { yuanToFen, type Fen } from "@hive/core";
import { NowPayError, parseShanghaiTime, privateKeyType } from "./nowpay.ts";
import {
  RefundNotImplemented,
  type ChargeState,
  type ChargeStatus,
  type ConsumeStatus,
  type PaymentProvider,
  type ProductRef,
  type Purchase,
} from "./provider.ts";

// Alipay Vibe Pay 即刻收, direct mode (直连模式). Field names follow
// https://aipay.alipay.com/docs/vibe-pay/nowpay/direct/nowpay-direct.md and its api-list pages.
//
// Differences from platform mode (nowpay.ts) that shape this file:
// - One merchant: the hive operator's own Alipay account. Products and tiers are made by hand in the
//   即刻收 management mini-program; there is no charge.initialize and no per-seller onboarding.
//   Every listing's payments go to that merchant (fine for the demo: the operator owns every seller).
// - No external_owner_id anywhere. Requests carry out_product_id (copied from the mini-program) and
//   external_buyer_id (hive buyer account id).
// - charge.query returns billing_mode / quota_unit at the top level, not per charging option, and
//   options have display_name instead of billing_mode/quota_unit.
// - Consumption results are recovered with alipay.aipay.nowpaydirect.quota.refresh (the doc page is
//   named quota-verify-query.md, the method is quota.refresh).
// Not yet exercised against the live gateway: direct mode is whitelist-only and has no sandbox.

export interface DirectProduct {
  productId: string; // out_product_id from the mini-program's product detail page
  skuId?: string | null; // pin a tier; otherwise the option with quota_amount = 1
}

export interface NowPayDirectConfig {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  gateway?: string;
  // Default product for every category, and optional per-category overrides (different prices).
  product: DirectProduct;
  byCategory?: Record<string, DirectProduct>;
  // Page the buyer returns to after paying. Docs: must be HTTPS if passed, so http URLs are dropped.
  callbackUrl?: string;
}

const METHOD = {
  chargeQuery: "alipay.aipay.nowpaydirect.charge.query",
  purchaseCreate: "alipay.aipay.nowpaydirect.purchase.create",
  quotaQuery: "alipay.aipay.nowpaydirect.quota.query",
  quotaVerify: "alipay.aipay.nowpaydirect.quota.verify",
  quotaRefresh: "alipay.aipay.nowpaydirect.quota.refresh",
} as const;

interface DirectChargingOption {
  sku_id: string;
  display_name?: string;
  price: string;
  quota_amount?: number;
}

const CONSUME_STATES = new Set(["SUCCEEDED", "FAILED", "PROCESSING"]);
// charge.query is cheap but hive calls it per listing; all listings share a product, so cache briefly.
const CHARGE_CACHE_MS = 30_000;

// The tier hive sells: the pinned sku if configured, else the single-count option.
export function directOption(options: readonly DirectChargingOption[], skuId?: string | null): DirectChargingOption | null {
  if (skuId) return options.find((o) => o.sku_id === skuId) ?? null;
  return options.find((o) => Number(o.quota_amount) === 1) ?? null;
}

export class NowPayDirectProvider implements PaymentProvider {
  readonly name = "nowpay-direct";
  private sdk: AlipaySdk;
  private charges = new Map<string, { at: number; state: Promise<ChargeState> }>();

  constructor(private readonly config: NowPayDirectConfig) {
    this.sdk = new AlipaySdk({
      appId: config.appId,
      privateKey: config.privateKey,
      keyType: privateKeyType(config.privateKey),
      alipayPublicKey: config.alipayPublicKey,
      ...(config.gateway ? { gateway: config.gateway } : {}),
      camelcase: false,
    });
  }

  private productFor(category: string): DirectProduct {
    return this.config.byCategory?.[category] ?? this.config.product;
  }

  // Every configured product, for the startup check.
  products(): DirectProduct[] {
    const all = [this.config.product, ...Object.values(this.config.byCategory ?? {})];
    return [...new Map(all.map((p) => [`${p.productId}#${p.skuId ?? ""}`, p])).values()];
  }

  quotaKey(product: ProductRef): string {
    return this.productFor(product.category).productId;
  }

  private async call(method: string, bizContent: Record<string, unknown>): Promise<AlipaySdkCommonResult> {
    const result = await this.sdk.exec(method, { bizContent });
    if (result.code !== "10000") throw new NowPayError(method, result);
    return result;
  }

  // charge.query on one configured product. Never initializes anything: direct mode has no such API.
  async queryProduct(direct: DirectProduct): Promise<ChargeState> {
    const q = await this.call(METHOD.chargeQuery, { out_product_id: direct.productId });
    const reported = q.capability_status as ChargeStatus;
    const option = directOption((q.charging_options ?? []) as DirectChargingOption[], direct.skuId);
    const countProduct = q.billing_mode === "QUANTITY" && q.quota_unit === "COUNT";
    const state: ChargeState = {
      status: reported,
      priceFen: option ? (yuanToFen(option.price) as Fen) : null,
      skuId: option?.sku_id ?? null,
      configurationUrl: null,
      configurationQrCode: null,
      managementUrl: q.management_url ?? null,
      note: null,
    };
    if (reported === "ENABLED" && (!countProduct || !option)) {
      // Sellable, but not something hive can sell one order at a time.
      return {
        ...state,
        status: "ACTION_REQUIRED",
        note: !countProduct
          ? `即刻收商品 ${direct.productId} 不是次数包（billing_mode=${q.billing_mode ?? "-"}, quota_unit=${q.quota_unit ?? "-"}），hive 需要「次数包」`
          : direct.skuId
            ? `即刻收商品 ${direct.productId} 没有档位 ${direct.skuId}`
            : `即刻收商品 ${direct.productId} 没有「1 次」档位，请在管理小程序里加一个`,
      };
    }
    if (reported !== "ENABLED") {
      state.note = `收款由 hive 运营方统一配置（即刻收直连），商品 ${direct.productId} 当前状态 ${reported}，不需要你操作`;
    }
    return state;
  }

  async setupProduct(product: ProductRef): Promise<ChargeState> {
    const direct = this.productFor(product.category);
    const key = `${direct.productId}#${direct.skuId ?? ""}`;
    const hit = this.charges.get(key);
    if (hit && Date.now() - hit.at < CHARGE_CACHE_MS) return hit.state;
    const state = this.queryProduct(direct);
    this.charges.set(key, { at: Date.now(), state });
    state.catch(() => this.charges.delete(key));
    return state;
  }

  async createPurchase(p: { requestNo: string; product: ProductRef; skuId: string | null; buyerId: string }): Promise<Purchase> {
    const callback = this.config.callbackUrl?.startsWith("https://") ? this.config.callbackUrl : null;
    const r = await this.call(METHOD.purchaseCreate, {
      out_request_no: p.requestNo,
      out_product_id: this.productFor(p.product.category).productId,
      external_buyer_id: p.buyerId,
      ...(p.skuId ? { sku_id: p.skuId } : {}),
      ...(callback ? { callback_url: callback } : {}),
    });
    return {
      purchaseUrl: r.purchase_url,
      purchaseQrCode: r.purchase_qr_code ?? null,
      expiresAt: parseShanghaiTime(r.expire_time),
    };
  }

  // A failed query must not read as zero (docs): it throws, and hive keeps the order waiting.
  async remainingQuota(p: { product: ProductRef; buyerId: string }): Promise<number> {
    const r = await this.call(METHOD.quotaQuery, {
      out_product_id: this.productFor(p.product.category).productId,
      external_buyer_id: p.buyerId,
    });
    const remaining = Number(r.remaining);
    if (!Number.isFinite(remaining)) throw new NowPayError(METHOD.quotaQuery, r);
    return remaining;
  }

  async consume(p: { requestNo: string; product: ProductRef; buyerId: string; reason: string }): Promise<ConsumeStatus> {
    const ids = {
      out_request_no: p.requestNo,
      out_product_id: this.productFor(p.product.category).productId,
      external_buyer_id: p.buyerId,
    };
    let result: AlipaySdkCommonResult;
    try {
      result = await this.sdk.exec(METHOD.quotaVerify, {
        bizContent: { ...ids, amount: 1, consume_reason: p.reason.slice(0, 256) },
      });
    } catch {
      // Timeout or transport error: the count may or may not be gone. Ask for the original result.
      return this.recover(ids);
    }
    if (result.sub_code === "NOW_PAY_QUOTA_INSUFFICIENT") return "INSUFFICIENT";
    if (result.code === "10000" && CONSUME_STATES.has(result.consume_status as string)) {
      const status = result.consume_status as ConsumeStatus;
      return status === "PROCESSING" ? this.recover(ids) : status;
    }
    // 20000 (service unavailable) is an unknown result; other codes (bad params, permissions,
    // business errors) are definite failures that a retry won't fix.
    if (result.code === "20000") return this.recover(ids);
    throw new NowPayError(METHOD.quotaVerify, result);
  }

  // quota.refresh with the original request number; never a new consumption. Anything short of a
  // final answer is PROCESSING: hive answers "retry shortly", and the retry repeats quota.verify
  // with the same request number and reason, which the docs allow and which can't consume twice.
  // CONSUME_REQUEST_NOT_FOUND also lands here: per the docs it doesn't prove the verify never ran.
  private async recover(ids: Record<string, string>): Promise<ConsumeStatus> {
    try {
      const r = await this.sdk.exec(METHOD.quotaRefresh, { bizContent: ids });
      if (r.sub_code === "NOW_PAY_QUOTA_INSUFFICIENT") return "INSUFFICIENT";
      if (r.code === "10000" && CONSUME_STATES.has(r.consume_status as string)) return r.consume_status as ConsumeStatus;
    } catch {
      // Still unknown.
    }
    return "PROCESSING";
  }

  async refund(): Promise<never> {
    throw new RefundNotImplemented();
  }
}
