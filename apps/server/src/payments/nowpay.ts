import { AlipaySdk, type AlipaySdkCommonResult } from "alipay-sdk";
import { yuanToFen, type Fen } from "@hive/core";
import {
  RefundNotImplemented,
  type ChargeState,
  type ChargeStatus,
  type ConsumeStatus,
  type PaymentProvider,
  type ProductRef,
  type Purchase,
} from "./provider.ts";

// Alipay Vibe Pay 即刻收, platform mode. Field names follow
// https://aipay.alipay.com/docs/vibe-pay/nowpay/platform/platfrom-guide.md
// Not yet exercised against the live gateway: hive still needs partner-platform access.

export interface NowPayConfig {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  gateway?: string;
  // Page the seller returns to after the hosted configuration page.
  callbackUrl?: string;
}

export class NowPayError extends Error {
  constructor(
    readonly method: string,
    readonly result: AlipaySdkCommonResult,
  ) {
    super(`${method} failed: ${result.code} ${result.sub_code ?? ""} ${result.sub_msg ?? result.msg}`);
  }
}

interface ChargingOption {
  sku_id: string;
  price: string;
  billing_mode: string;
  quota_unit?: string;
  quota_amount?: number;
}

// "yyyy-MM-dd HH:mm:ss" in Asia/Shanghai (UTC+8, no DST).
export function parseShanghaiTime(s: string): Date {
  return new Date(`${s.replace(" ", "T")}+08:00`);
}

export function singleCountOption(options: readonly ChargingOption[]): ChargingOption | null {
  return (
    options.find((o) => o.billing_mode === "QUANTITY" && o.quota_unit === "COUNT" && Number(o.quota_amount) === 1) ??
    null
  );
}

export class NowPayProvider implements PaymentProvider {
  readonly name = "nowpay";
  private sdk: AlipaySdk;

  constructor(private readonly config: NowPayConfig) {
    this.sdk = new AlipaySdk({
      appId: config.appId,
      privateKey: config.privateKey,
      alipayPublicKey: config.alipayPublicKey,
      ...(config.gateway ? { gateway: config.gateway } : {}),
      camelcase: false,
    });
  }

  private async call(method: string, bizContent: Record<string, unknown>): Promise<AlipaySdkCommonResult> {
    const result = await this.sdk.exec(method, { bizContent });
    if (result.code !== "10000") throw new NowPayError(method, result);
    return result;
  }

  async setupProduct(product: ProductRef): Promise<ChargeState> {
    const ids = { out_product_id: product.productId, external_owner_id: product.ownerId };
    const q = await this.call("alipay.aipay.nowpay.charge.query", ids);
    const status = q.capability_status as ChargeStatus;
    const option = singleCountOption((q.charging_options ?? []) as ChargingOption[]);
    const state: ChargeState = {
      status,
      priceFen: option ? (yuanToFen(option.price) as Fen) : null,
      skuId: option?.sku_id ?? null,
      configurationUrl: null,
      configurationQrCode: null,
      managementUrl: q.management_url ?? null,
    };
    if (status !== "NOT_CONFIGURED" && status !== "CONFIGURING") return state;

    const init = await this.call("alipay.aipay.nowpay.charge.initialize", {
      ...ids,
      product_name: product.productName,
      ...(this.config.callbackUrl ? { callback_url: this.config.callbackUrl } : {}),
      pricing_mode_list: [{ billing_mode: "QUANTITY", quota_unit: "COUNT" }],
    });
    return {
      ...state,
      configurationUrl: init.configuration_url ?? null,
      configurationQrCode: init.configuration_qr_code ?? null,
    };
  }

  async createPurchase(p: { requestNo: string; product: ProductRef; skuId: string | null; buyerId: string }): Promise<Purchase> {
    const r = await this.call("alipay.aipay.nowpay.purchase.create", {
      out_request_no: p.requestNo,
      out_product_id: p.product.productId,
      external_owner_id: p.product.ownerId,
      external_buyer_id: p.buyerId,
      ...(p.skuId ? { sku_id: p.skuId } : {}),
    });
    return {
      purchaseUrl: r.purchase_url,
      purchaseQrCode: r.purchase_qr_code ?? null,
      expiresAt: parseShanghaiTime(r.expire_time),
    };
  }

  async remainingQuota(p: { product: ProductRef; buyerId: string }): Promise<number> {
    const r = await this.call("alipay.aipay.nowpay.quota.query", {
      out_product_id: p.product.productId,
      external_owner_id: p.product.ownerId,
      external_buyer_id: p.buyerId,
    });
    return Number(r.remaining ?? 0);
  }

  async consume(p: { requestNo: string; product: ProductRef; buyerId: string; reason: string }): Promise<ConsumeStatus> {
    const method = "alipay.aipay.nowpay.quota.verify";
    const result = await this.sdk.exec(method, {
      bizContent: {
        out_request_no: p.requestNo,
        out_product_id: p.product.productId,
        external_owner_id: p.product.ownerId,
        external_buyer_id: p.buyerId,
        amount: 1,
        consume_reason: p.reason.slice(0, 256),
      },
    });
    if (result.sub_code === "NOW_PAY_QUOTA_INSUFFICIENT") return "INSUFFICIENT";
    if (result.code !== "10000") throw new NowPayError(method, result);
    const status = result.consume_status as string;
    if (status === "SUCCEEDED" || status === "FAILED" || status === "PROCESSING") return status;
    throw new NowPayError(method, result);
  }

  async refund(): Promise<never> {
    throw new RefundNotImplemented();
  }
}
