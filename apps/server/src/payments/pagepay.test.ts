import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { AlipaySdk, type AlipaySdkCommonResult } from "alipay-sdk";
import { fen } from "@hive/core";
import { describe, expect, it } from "vitest";
import { refunds } from "../db/schema.ts";
import { DATA, orders, setup, validDelivery } from "../test-helpers.ts";
import { ALIPAY_SANDBOX_GATEWAY, PagePayProvider, beijingTime, type AlipayClient } from "./pagepay.ts";

const APP_ID = "9021000000000000";
const NOTIFY_URL = "https://hive.example/v1/payments/alipay/notify";

// Base64 body of a PEM, the form Alipay hands out keys in.
const bare = (pem: string) => pem.replace(/-----[^-]+-----|\s/g, "");
const pair = () =>
  generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
// Our app's keys, and the keys Alipay signs its notifications with.
const app = pair();
const alipay = pair();

const sdk = new AlipaySdk({ appId: APP_ID, privateKey: bare(app.privateKey), alipayPublicKey: bare(alipay.publicKey), gateway: ALIPAY_SANDBOX_GATEWAY });

// Alipay's side, in memory: which trades buyers opened and paid, refunds, and what we asked of it.
class Gateway {
  trades = new Map<string, string>();
  refunded = new Set<string>();
  calls: { method: string; biz: Record<string, string> }[] = [];
  fail: AlipaySdkCommonResult | null = null;
  // The next refund calls' answers, in order; afterwards refunds succeed.
  refundAnswers: AlipaySdkCommonResult[] = [];

  client: AlipayClient = {
    pageExec: sdk.pageExec.bind(sdk),
    checkNotifySignV2: sdk.checkNotifySignV2.bind(sdk),
    exec: async (method, params) => {
      const biz = params!.bizContent as Record<string, string>;
      this.calls.push({ method, biz });
      if (this.fail) return this.fail;
      const status = this.trades.get(biz.out_trade_no!);
      if (method === "alipay.trade.refund") {
        const next = this.refundAnswers.shift();
        if (next) return next;
        const repeat = this.refunded.has(biz.out_request_no!);
        this.refunded.add(biz.out_request_no!);
        // A repeat of a finished refund moves no money.
        return { code: "10000", msg: "Success", fundChange: repeat ? "N" : "Y" };
      }
      if (method === "alipay.trade.fastpay.refund.query") {
        return this.refunded.has(biz.out_request_no!) ? { code: "10000", msg: "Success", refundStatus: "REFUND_SUCCESS" } : { code: "10000", msg: "Success" };
      }
      if (!status) return { code: "40004", msg: "Business Failed", subCode: "ACQ.TRADE_NOT_EXIST", subMsg: "交易不存在" };
      if (method === "alipay.trade.query") return { code: "10000", msg: "Success", tradeStatus: status, tradeNo: `2026${biz.out_trade_no}` };
      if (method === "alipay.trade.close") {
        if (status !== "WAIT_BUYER_PAY") return { code: "40004", msg: "Business Failed", subCode: "ACQ.TRADE_STATUS_ERROR", subMsg: "交易状态不合法" };
        this.trades.set(biz.out_trade_no!, "TRADE_CLOSED");
      }
      return { code: "10000", msg: "Success" };
    },
  };

  count(method: string) {
    return this.calls.filter((c) => c.method === method).length;
  }
}

const provider = (gw = new Gateway()) => ({ gw, pagePay: new PagePayProvider({ appId: APP_ID, privateKey: "", alipayPublicKey: "", notifyUrl: NOTIFY_URL }, gw.client) });

// Signs like Alipay does: every field but sign and sign_type, sorted, as k=v joined by &.
function signed(params: Record<string, string>): Record<string, string> {
  const content = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const sign = createSign("RSA-SHA256").update(content).sign(alipay.privateKey, "base64");
  return { ...params, sign_type: "RSA2", sign };
}

const notification = (orderId: string, extra: Record<string, string> = {}) =>
  signed({ app_id: APP_ID, out_trade_no: orderId, trade_no: "2026101522001400000000000001", trade_status: "TRADE_SUCCESS", total_amount: "5.00", notify_time: "2026-10-15 10:05:00", ...extra });

describe("电脑网站支付", () => {
  it("signs a GET cashier link that expires with the payment window", async () => {
    const { pagePay } = provider();
    const { purchaseUrl } = await pagePay.createTrade({
      outTradeNo: "ord_1",
      amountFen: fen(1),
      subject: "hive · 竞品/市场数据&",
      expiresAt: new Date("2026-10-15T02:15:00Z"),
      returnUrl: "https://hive.example/orders/ord_1",
    });

    const url = new URL(purchaseUrl);
    expect(`${url.origin}${url.pathname}`).toBe(ALIPAY_SANDBOX_GATEWAY);
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({ app_id: APP_ID, method: "alipay.trade.page.pay", sign_type: "RSA2", return_url: "https://hive.example/orders/ord_1", notify_url: NOTIFY_URL });
    expect(JSON.parse(q.biz_content!)).toEqual({
      out_trade_no: "ord_1",
      total_amount: "0.01",
      subject: "hive · 竞品 市场数据 ",
      product_code: "FAST_INSTANT_TRADE_PAY",
      time_expire: "2026-10-15 10:15:00",
    });
    const { sign, ...rest } = q;
    const content = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("&");
    expect(createVerify("RSA-SHA256").update(content).verify(app.publicKey, sign!, "base64")).toBe(true);
  });

  it("reads the trade status", async () => {
    const { gw, pagePay } = provider();
    expect((await pagePay.queryTrade("ord_1")).state).toBe("pending"); // cashier not opened yet
    for (const [status, state] of [["WAIT_BUYER_PAY", "pending"], ["TRADE_SUCCESS", "paid"], ["TRADE_FINISHED", "paid"], ["TRADE_CLOSED", "closed"]]) {
      gw.trades.set("ord_1", status!);
      expect((await pagePay.queryTrade("ord_1")).state).toBe(state);
    }
    gw.fail = { code: "20000", msg: "Service Currently Unavailable", subCode: "isp.unknow-error", subMsg: "系统繁忙" };
    await expect(pagePay.queryTrade("ord_1")).rejects.toThrow("isp.unknow-error");
  });

  it("closes an open trade and lets a missing or settled one be", async () => {
    const { gw, pagePay } = provider();
    await pagePay.closeTrade("never-opened");
    gw.trades.set("paid", "TRADE_SUCCESS");
    await pagePay.closeTrade("paid");
    expect(gw.trades.get("paid")).toBe("TRADE_SUCCESS");
    gw.trades.set("open", "WAIT_BUYER_PAY");
    await pagePay.closeTrade("open");
    expect(gw.trades.get("open")).toBe("TRADE_CLOSED");
  });

  it("refunds under one request number and tells unknown from failed", async () => {
    const { gw, pagePay } = provider();
    const req = { outTradeNo: "ord_1", requestNo: "ord_1-refund", amountFen: fen(500), reason: "x" };
    expect(await pagePay.refund(req)).toEqual({ status: "SUCCEEDED" });
    // A repeat moves no money; the refund query says it already went through.
    expect(await pagePay.refund(req)).toEqual({ status: "SUCCEEDED" });
    expect(gw.calls.filter((c) => c.method === "alipay.trade.refund").map((c) => c.biz.out_request_no)).toEqual(["ord_1-refund", "ord_1-refund"]);
    gw.refundAnswers.push({ code: "20000", msg: "Service Currently Unavailable", subCode: "isp.unknow-error", subMsg: "系统繁忙" });
    expect((await pagePay.refund(req)).status).toBe("PROCESSING");
    gw.refundAnswers.push({ code: "40004", msg: "Business Failed", subCode: "ACQ.SELLER_BALANCE_NOT_ENOUGH", subMsg: "卖家余额不足" });
    expect(await pagePay.refund(req)).toMatchObject({ status: "FAILED", error: expect.stringContaining("ACQ.SELLER_BALANCE_NOT_ENOUGH") });
  });

  it("trusts only notifications Alipay signed for this app", () => {
    const { pagePay } = provider();
    expect(pagePay.verifyNotification(notification("ord_1"))).toBe("ord_1");
    expect(pagePay.verifyNotification({ ...notification("ord_1"), total_amount: "0.01" })).toBeNull();
    expect(pagePay.verifyNotification(notification("ord_1", { app_id: "2021000000000001" }))).toBeNull();
    const { sign: _, ...unsigned } = notification("ord_1");
    expect(pagePay.verifyNotification(unsigned)).toBeNull();
  });

  it("formats times in Beijing time", () => {
    expect(beijingTime(new Date("2026-12-31T16:30:05Z"))).toBe("2027-01-01 00:30:05");
  });
});

describe("orders paid with 电脑网站支付", () => {
  async function world() {
    const { gw, pagePay } = provider();
    const t = await setup({ payments: pagePay, webUrl: "https://hive.example" });
    const seller = await t.agentSeller("data-agent", DATA, 500);
    const buyer = await t.account("xiaowang");
    const buyerAgent = await t.agentToken(buyer.token);
    // An order the seller has taken, waiting for the buyer to pay.
    async function awaiting() {
      const created = await t.ok("POST", "/v1/orders", buyerAgent, orders[DATA]);
      await t.ok("POST", `/v1/orders/${created.id}/accept-offer`, seller.agent);
      return (await t.ok("GET", `/v1/orders/${created.id}`, buyer.token)) as { id: string; status: string; purchaseUrl: string; priceFen: number };
    }
    async function paid() {
      const order = await awaiting();
      gw.trades.set(order.id, "TRADE_SUCCESS");
      await t.ok("POST", `/v1/orders/${order.id}/check-payment`, buyerAgent);
      return order;
    }
    async function notify(params: Record<string, string>) {
      const res = await t.app.request("http://hive.test/v1/payments/alipay/notify", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
      });
      return res.text();
    }
    const refundRows = (orderId: string) => t.hive.db.select().from(refunds).where(eq(refunds.orderId, orderId));
    return { t, gw, seller, buyer, buyerAgent, awaiting, paid, notify, refundRows };
  }

  it("lists at the seller's own price and charges the order's price at the cashier", async () => {
    const { t, gw, seller, buyer, buyerAgent, awaiting } = await world();
    const market = await t.ok("GET", "/v1/categories");
    expect(market.find((c: { id: string }) => c.id === DATA).sellers[0].priceFen).toBe(500);

    const order = await awaiting();
    expect(order.status).toBe("AWAITING_PAYMENT");
    const q = Object.fromEntries(new URL(order.purchaseUrl).searchParams);
    const biz = JSON.parse(q.biz_content!);
    expect(biz).toMatchObject({ out_trade_no: order.id, total_amount: "5.00", subject: "hive · 竞品 市场数据" });
    // The brief stays off the payer's Alipay bill.
    expect(q.biz_content).not.toContain("奶茶");
    expect(q.return_url).toBe(`https://hive.example/orders/${order.id}`);

    expect((await t.ok("POST", `/v1/orders/${order.id}/check-payment`, buyerAgent)).status).toBe("AWAITING_PAYMENT");
    gw.trades.set(order.id, "TRADE_SUCCESS");
    const paid = await t.ok("POST", `/v1/orders/${order.id}/check-payment`, buyerAgent);
    expect(paid.status).toBe("PAID");

    // Nothing to consume on delivery.
    const calls = gw.calls.length;
    expect((await t.ok("POST", `/v1/orders/${order.id}/deliver`, seller.agent, validDelivery)).status).toBe("DELIVERED");
    expect(gw.calls.length).toBe(calls);
    expect((await t.ok("POST", `/v1/orders/${order.id}/verdict`, buyerAgent, { verdict: "accepted" })).status).toBe("COMPLETED");
    expect((await t.ok("GET", "/v1/me/bill", buyer.token)).spentFen).toBe(500);
  });

  it("confirms payment from a signed notification and ignores forged ones", async () => {
    const { t, gw, buyer, awaiting, notify } = await world();
    const order = await awaiting();
    gw.trades.set(order.id, "TRADE_SUCCESS");
    const { sign: _, ...unsigned } = notification(order.id);
    expect(await notify({ ...unsigned, sign: "AAAA", sign_type: "RSA2" })).toBe("fail");
    expect((await t.ok("GET", `/v1/orders/${order.id}`, buyer.token)).status).toBe("AWAITING_PAYMENT");
    expect(await notify(notification(order.id))).toBe("success");
    expect((await t.ok("GET", `/v1/orders/${order.id}`, buyer.token)).status).toBe("PAID");
    // Alipay resends until it hears success; a repeat changes nothing.
    expect(await notify(notification(order.id))).toBe("success");
    // A signed notification about a trade that isn't hive's is acknowledged and dropped.
    expect(await notify(notification("someone-elses-order"))).toBe("success");
  });

  it("closes the trade when payment times out, unless the buyer paid at the last second", async () => {
    const { t, gw, seller, buyer, awaiting } = await world();
    const open = await awaiting();
    const late = await awaiting();
    gw.trades.set(open.id, "WAIT_BUYER_PAY");
    t.advance(16 * 60_000);
    await t.ok("GET", "/v1/seller/poll", seller.agent); // the seller's listener is still there
    gw.trades.set(late.id, "TRADE_SUCCESS");
    // The sweeper's own payment check runs after expiry, so only closing finds the late payment.
    await t.hive.tick();
    expect((await t.ok("GET", `/v1/orders/${open.id}`, buyer.token)).status).toBe("CANCELLED");
    expect(gw.trades.get(open.id)).toBe("TRADE_CLOSED");
    expect((await t.ok("GET", `/v1/orders/${late.id}`, buyer.token)).status).toBe("PAID");
  });

  it("keeps an unpaid order while the gateway can't close its trade", async () => {
    const { t, gw, buyer, awaiting } = await world();
    const order = await awaiting();
    t.advance(16 * 60_000);
    gw.fail = { code: "20000", msg: "Service Currently Unavailable", subCode: "isp.unknow-error", subMsg: "系统繁忙" };
    await t.hive.tick();
    expect((await t.ok("GET", `/v1/orders/${order.id}`, buyer.token)).status).toBe("AWAITING_PAYMENT");
    gw.fail = null;
    await t.hive.tick();
    expect((await t.ok("GET", `/v1/orders/${order.id}`, buyer.token)).status).toBe("CANCELLED");
  });

  it("won't cancel an order the buyer already paid", async () => {
    const { t, gw, buyerAgent, awaiting } = await world();
    const order = await awaiting();
    gw.trades.set(order.id, "TRADE_SUCCESS");
    const r = await t.call("POST", `/v1/orders/${order.id}/cancel`, buyerAgent);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("already_paid");
    const unpaid = await awaiting();
    gw.trades.set(unpaid.id, "WAIT_BUYER_PAY");
    expect((await t.ok("POST", `/v1/orders/${unpaid.id}/cancel`, buyerAgent)).status).toBe("CANCELLED");
    expect(gw.trades.get(unpaid.id)).toBe("TRADE_CLOSED");
  });

  it("refunds a paid order the seller gives up on, once", async () => {
    const { t, gw, seller, buyer, paid, refundRows } = await world();
    const order = await paid();
    expect((await t.ok("POST", `/v1/orders/${order.id}/abandon`, seller.agent)).status).toBe("FAILED");
    expect(await refundRows(order.id)).toMatchObject([{ status: "SUCCEEDED", amountFen: 500, reason: "seller_abandoned" }]);
    await t.hive.tick();
    expect(gw.count("alipay.trade.refund")).toBe(1);
    expect(gw.calls.find((c) => c.method === "alipay.trade.refund")!.biz).toMatchObject({ out_trade_no: order.id, out_request_no: `${order.id}-refund`, refund_amount: "5.00" });
    const notes = await t.ok("GET", "/v1/notifications", buyer.token);
    expect(notes[0]).toMatchObject({ kind: "refunded", orderId: order.id });
    expect((await t.ok("GET", `/v1/orders/${order.id}`, buyer.token)).refund).toMatchObject({ status: "SUCCEEDED", amountFen: 500 });
    // The seller doesn't see the buyer's refund.
    expect((await t.ok("GET", `/v1/orders/${order.id}`, seller.token)).refund).toBeNull();
  });

  it("retries a refund with an unknown outcome under the same request number", async () => {
    const { t, gw, seller, paid, refundRows } = await world();
    const order = await paid();
    gw.refundAnswers.push({ code: "20000", msg: "Service Currently Unavailable", subCode: "isp.unknow-error", subMsg: "系统繁忙" });
    await t.ok("POST", `/v1/orders/${order.id}/abandon`, seller.agent);
    expect((await refundRows(order.id))[0]!.status).toBe("PROCESSING");
    await t.hive.tick();
    expect((await refundRows(order.id))[0]!.status).toBe("SUCCEEDED");
    expect(gw.calls.filter((c) => c.method === "alipay.trade.refund").map((c) => c.biz.out_request_no)).toEqual([`${order.id}-refund`, `${order.id}-refund`]);
    await t.hive.tick();
    expect(gw.count("alipay.trade.refund")).toBe(2);
  });

  it("records a refused refund and stops trying", async () => {
    const { t, gw, seller, paid, refundRows } = await world();
    const order = await paid();
    gw.refundAnswers.push({ code: "40004", msg: "Business Failed", subCode: "ACQ.SELLER_BALANCE_NOT_ENOUGH", subMsg: "卖家余额不足" });
    await t.ok("POST", `/v1/orders/${order.id}/abandon`, seller.agent);
    const [row] = await refundRows(order.id);
    expect(row).toMatchObject({ status: "FAILED" });
    expect(row!.reason).toContain("ACQ.SELLER_BALANCE_NOT_ENOUGH");
    await t.hive.tick();
    expect(gw.count("alipay.trade.refund")).toBe(1);
  });

  it("doesn't refund a buyer's rejection on its own", async () => {
    const { t, gw, seller, buyerAgent, paid, refundRows } = await world();
    const order = await paid();
    await t.ok("POST", `/v1/orders/${order.id}/deliver`, seller.agent, validDelivery);
    const done = await t.ok("POST", `/v1/orders/${order.id}/verdict`, buyerAgent, { verdict: "rejected" });
    expect(done.refundEligible).toBe(true);
    expect(await refundRows(order.id)).toEqual([]);
    expect(gw.count("alipay.trade.refund")).toBe(0);
  });

  it("takes payment only for listings with a price", async () => {
    const { t } = await world();
    const human = await t.account("unpriced");
    const agent = await t.agentToken(human.token);
    await t.ok("PUT", `/v1/listings/content.translation`, agent, { acceptMode: "auto", dailyLimit: 5 });
    const state = await t.ok("POST", "/v1/listings/content.translation/payment-setup", agent);
    expect(state).toMatchObject({ status: "NOT_CONFIGURED", priceFen: null });
    expect(state.note).toContain("价格");
    const priced = await t.ok("PUT", `/v1/listings/content.translation`, agent, { acceptMode: "auto", dailyLimit: 5, priceFen: 1 });
    expect(priced).toMatchObject({ priceFen: 1, paymentStatus: "ENABLED" });
    // Re-saving without a price keeps it.
    expect(await t.ok("PUT", `/v1/listings/content.translation`, agent, { acceptMode: "ask", dailyLimit: 5 })).toMatchObject({ priceFen: 1, paymentStatus: "ENABLED" });
    expect((await t.call("PUT", `/v1/listings/content.translation`, agent, { acceptMode: "auto", dailyLimit: 5, priceFen: 0 })).status).toBe(400);
  });
});
