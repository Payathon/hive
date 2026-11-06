import { AlipaySdk, type AlipaySdkCommonResult } from "alipay-sdk";
import { fenToYuan, type Fen } from "@hive/core";
import { privateKeyType } from "./nowpay.ts";
import type { Purchase, RefundStatus, TradePaymentProvider, TradeState } from "./provider.ts";

// Alipay Vibe Pay 基础收款, 电脑网站支付 (alipay.trade.page.pay), ported from OpenShop's tested
// provider. One trade per order at the order's own price; all money goes to the operator's account,
// as with 即刻收直连. The order id is out_trade_no. Results come from the signed notification when
// hive has a public https address, and from alipay.trade.query either way.

export const ALIPAY_SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
export const ALIPAY_GATEWAY = "https://openapi.alipay.com/gateway.do";

export interface PagePayConfig {
  appId: string;
  // The app's private key, bare base64 (PKCS#1 or PKCS#8) or PEM.
  privateKey: string;
  // Alipay's public key, used to verify responses and notifications.
  alipayPublicKey: string;
  // Defaults to the sandbox; real money needs ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do.
  gateway?: string | undefined;
  // Public HTTPS address Alipay posts payment results to. Without it results come only from query.
  notifyUrl?: string | undefined;
}

// What the provider needs from the SDK; tests pass a stand-in.
export type AlipayClient = Pick<AlipaySdk, "pageExec" | "exec" | "checkNotifySignV2">;

export class PagePayProvider implements TradePaymentProvider {
  readonly kind = "trade";
  readonly name = "pagepay";
  private readonly sdk: AlipayClient;

  constructor(
    private readonly config: PagePayConfig,
    sdk?: AlipayClient,
  ) {
    this.sdk =
      sdk ??
      new AlipaySdk({
        appId: config.appId,
        privateKey: config.privateKey,
        keyType: privateKeyType(config.privateKey),
        alipayPublicKey: config.alipayPublicKey,
        gateway: this.gateway,
        signType: "RSA2",
        timeout: 10_000,
      });
  }

  get gateway() {
    return this.config.gateway ?? ALIPAY_SANDBOX_GATEWAY;
  }

  // Signs locally without calling Alipay, so accepting an order never waits on the gateway. A GET
  // link rather than the auto-submitting form: agents need a URL to pass on to their person.
  async createTrade(p: { outTradeNo: string; amountFen: Fen; subject: string; expiresAt: Date; returnUrl?: string | undefined }): Promise<Purchase> {
    const purchaseUrl = this.sdk.pageExec("alipay.trade.page.pay", "GET", {
      bizContent: {
        out_trade_no: p.outTradeNo,
        total_amount: fenToYuan(p.amountFen),
        subject: cleanSubject(p.subject),
        product_code: "FAST_INSTANT_TRADE_PAY",
        // Alipay stops taking payment when hive's payment window closes.
        time_expire: beijingTime(p.expiresAt),
      },
      ...(p.returnUrl ? { returnUrl: p.returnUrl } : {}),
      ...(this.config.notifyUrl ? { notifyUrl: this.config.notifyUrl } : {}),
    });
    return { purchaseUrl, purchaseQrCode: null, expiresAt: p.expiresAt };
  }

  async queryTrade(outTradeNo: string): Promise<{ state: TradeState; tradeNo: string | null }> {
    const r = await this.sdk.exec("alipay.trade.query", { bizContent: { out_trade_no: outTradeNo } });
    // Not opened at Alipay yet: still payable until time_expire.
    if (r.subCode === "ACQ.TRADE_NOT_EXIST") return { state: "pending", tradeNo: null };
    check("alipay.trade.query", r);
    const tradeNo = (r.tradeNo as string | undefined) ?? null;
    switch (r.tradeStatus) {
      case "TRADE_SUCCESS":
      case "TRADE_FINISHED":
        return { state: "paid", tradeNo };
      case "WAIT_BUYER_PAY":
        return { state: "pending", tradeNo };
      case "TRADE_CLOSED":
        return { state: "closed", tradeNo };
      default:
        throw new Error(`alipay.trade.query: unknown trade_status ${r.tradeStatus}`);
    }
  }

  async closeTrade(outTradeNo: string) {
    const r = await this.sdk.exec("alipay.trade.close", { bizContent: { out_trade_no: outTradeNo } });
    // Never opened (time_expire keeps it shut) or already paid or closed: the caller queries next.
    if (r.subCode === "ACQ.TRADE_NOT_EXIST" || r.subCode === "ACQ.TRADE_STATUS_ERROR") return;
    check("alipay.trade.close", r);
  }

  // Orders are refunded in full, once, under one request number, so a retry after a timeout repeats
  // the same request instead of refunding twice. fund_change N doesn't mean failure (it is also
  // what a repeat of a finished refund says), so the refund query decides.
  async refund(p: { outTradeNo: string; requestNo: string; amountFen: Fen; reason: string }): Promise<{ status: RefundStatus; error?: string }> {
    let r: AlipaySdkCommonResult;
    try {
      r = await this.sdk.exec("alipay.trade.refund", {
        bizContent: {
          out_trade_no: p.outTradeNo,
          refund_amount: fenToYuan(p.amountFen),
          out_request_no: p.requestNo,
          refund_reason: cleanSubject(p.reason),
        },
      });
    } catch (err) {
      return { status: "PROCESSING", error: (err as Error).message };
    }
    if (r.code === "10000") {
      if (r.fundChange === "Y") return { status: "SUCCEEDED" };
      return { status: await this.queryRefund(p) };
    }
    // Unknown outcome: ask again later with the same request number.
    if (r.code === "20000" || r.subCode === "ACQ.SYSTEM_ERROR") return { status: "PROCESSING", error: describe(r) };
    return { status: "FAILED", error: describe(r) };
  }

  async queryRefund(p: { outTradeNo: string; requestNo: string }): Promise<RefundStatus> {
    try {
      const r = await this.sdk.exec("alipay.trade.fastpay.refund.query", {
        bizContent: { out_trade_no: p.outTradeNo, out_request_no: p.requestNo },
      });
      return r.code === "10000" && r.refundStatus === "REFUND_SUCCESS" ? "SUCCEEDED" : "PROCESSING";
    } catch {
      return "PROCESSING";
    }
  }

  // A payment notification we can trust: signed by Alipay and meant for this app. Returns the
  // order id it is about; the caller confirms the state with queryTrade.
  verifyNotification(params: Record<string, string>): string | null {
    if (params.app_id !== this.config.appId || !params.out_trade_no) return null;
    try {
      return this.sdk.checkNotifySignV2(params) ? params.out_trade_no : null;
    } catch {
      return null;
    }
  }
}

const describe = (r: AlipaySdkCommonResult) => `${r.code} ${r.subCode ?? ""} ${r.subMsg ?? r.msg}`.replace(/\s+/g, " ").trim();

function check(method: string, r: AlipaySdkCommonResult) {
  if (r.code !== "10000") throw new Error(`${method}: ${describe(r)}`);
}

// Alipay rejects / = & in subject.
const cleanSubject = (s: string) => s.replace(/[/=&]/g, " ").slice(0, 256);

// "yyyy-MM-dd HH:mm:ss" in Beijing time, whatever the server's own time zone.
export const beijingTime = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
