import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NowPayError } from "./nowpay.ts";
import { NowPayDirectProvider, directOption, type NowPayDirectConfig } from "./nowpay-direct.ts";

const product = { productId: "lst_1", ownerId: "acct_seller", category: "data.market", productName: "hive · 竞品门店数据" };
const M = (m: string) => `alipay.aipay.nowpaydirect.${m}`;

type Reply = Record<string, unknown> | (() => Record<string, unknown>);

function provider(responses: Record<string, Reply>, config: Partial<NowPayDirectConfig> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const p = new NowPayDirectProvider({
    appId: "2021000000000000",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    alipayPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    product: { productId: "np_d_main" },
    ...config,
  });
  const calls: { method: string; bizContent: Record<string, unknown> }[] = [];
  // Stub the gateway: no network in tests.
  (p as unknown as { sdk: unknown }).sdk = {
    exec: async (method: string, params: { bizContent: Record<string, unknown> }) => {
      calls.push({ method, bizContent: params.bizContent });
      const r = responses[method];
      if (typeof r === "function") return r();
      return r ?? { code: "40004", msg: "Business Failed", sub_code: "UNEXPECTED" };
    },
  };
  return { p, calls };
}

const enabled = {
  code: "10000",
  capability_status: "ENABLED",
  billing_mode: "QUANTITY",
  quota_unit: "COUNT",
  management_url: "alipays://manage",
  charging_options: [
    { sku_id: "S20", display_name: "20次包", price: "15.00", quota_amount: 20 },
    { sku_id: "S1", display_name: "1次", price: "5.00", quota_amount: 1 },
  ],
};

it("picks the single-count tier, or the pinned sku", () => {
  expect(directOption(enabled.charging_options)?.sku_id).toBe("S1");
  expect(directOption(enabled.charging_options, "S20")?.sku_id).toBe("S20");
  expect(directOption(enabled.charging_options.slice(0, 1))).toBeNull();
});

it("maps every listing to the configured product, with per-category overrides", () => {
  const { p } = provider({}, { byCategory: { "design.chart": { productId: "np_d_chart" } } });
  expect(p.quotaKey(product)).toBe("np_d_main");
  expect(p.quotaKey({ ...product, productId: "lst_2", ownerId: "acct_other" })).toBe("np_d_main");
  expect(p.quotaKey({ ...product, category: "design.chart" })).toBe("np_d_chart");
});

describe("setupProduct", () => {
  it("reads price and tier with charge.query only, sending just the product id", async () => {
    const { p, calls } = provider({ [M("charge.query")]: enabled });
    const state = await p.setupProduct(product);
    expect(state).toMatchObject({ status: "ENABLED", priceFen: 500, skuId: "S1", managementUrl: "alipays://manage", configurationUrl: null });
    expect(calls).toEqual([{ method: M("charge.query"), bizContent: { out_product_id: "np_d_main" } }]);
    // Shared by every listing: a second listing reuses the cached answer.
    await p.setupProduct({ ...product, productId: "lst_2" });
    expect(calls).toHaveLength(1);
  });

  it("never initializes: an unconfigured product explains instead of linking", async () => {
    const { p, calls } = provider({ [M("charge.query")]: { code: "10000", capability_status: "PENDING", charging_options: [] } });
    const state = await p.setupProduct(product);
    expect(state.status).toBe("PENDING");
    expect(state.configurationUrl).toBeNull();
    expect(state.note).toContain("PENDING");
    expect(calls.map((c) => c.method)).toEqual([M("charge.query")]);
  });

  it("refuses an enabled product hive can't sell one count at a time", async () => {
    const points = provider({ [M("charge.query")]: { ...enabled, quota_unit: "POINT" } });
    expect(await points.p.setupProduct(product)).toMatchObject({ status: "ACTION_REQUIRED" });
    const noSingle = provider({ [M("charge.query")]: { ...enabled, charging_options: enabled.charging_options.slice(0, 1) } });
    expect(await noSingle.p.setupProduct(product)).toMatchObject({ status: "ACTION_REQUIRED", priceFen: null });
  });
});

it("creates a purchase without external_owner_id, with an https callback only", async () => {
  const reply = { code: "10000", purchase_url: "alipays://buy", purchase_qr_code: "https://qr", expire_time: "2026-10-14 10:30:00" };
  const { p, calls } = provider({ [M("purchase.create")]: reply }, { callbackUrl: "https://hive.example/orders" });
  const purchase = await p.createPurchase({ requestNo: "purchase_o1", product, skuId: "S1", buyerId: "acct_buyer" });
  expect(purchase).toMatchObject({ purchaseUrl: "alipays://buy", purchaseQrCode: "https://qr" });
  expect(purchase.expiresAt.toISOString()).toBe("2026-10-14T02:30:00.000Z");
  expect(calls[0]!.bizContent).toEqual({
    out_request_no: "purchase_o1",
    out_product_id: "np_d_main",
    external_buyer_id: "acct_buyer",
    sku_id: "S1",
    callback_url: "https://hive.example/orders",
  });
  const local = provider({ [M("purchase.create")]: reply }, { callbackUrl: "http://localhost:5173/orders" });
  await local.p.createPurchase({ requestNo: "purchase_o1", product, skuId: null, buyerId: "acct_buyer" });
  expect(local.calls[0]!.bizContent).not.toHaveProperty("callback_url");
  expect(local.calls[0]!.bizContent).not.toHaveProperty("sku_id");
});

it("reads remaining quota and never treats a failed query as zero", async () => {
  const { p, calls } = provider({ [M("quota.query")]: { code: "10000", quota_unit: "COUNT", total: 3, used: 1, remaining: 2 } });
  expect(await p.remainingQuota({ product, buyerId: "acct_buyer" })).toBe(2);
  expect(calls[0]!.bizContent).toEqual({ out_product_id: "np_d_main", external_buyer_id: "acct_buyer" });
  const down = provider({ [M("quota.query")]: { code: "20000", msg: "Service Currently Unavailable" } });
  await expect(down.p.remainingQuota({ product, buyerId: "acct_buyer" })).rejects.toBeInstanceOf(NowPayError);
});

describe("consume", () => {
  const args = { requestNo: "consume_o1", product, buyerId: "acct_buyer", reason: "hive order" };
  const ids = { out_request_no: "consume_o1", out_product_id: "np_d_main", external_buyer_id: "acct_buyer" };

  it("consumes exactly one count", async () => {
    const { p, calls } = provider({ [M("quota.verify")]: { code: "10000", consume_status: "SUCCEEDED", consumed: 1, remaining: 0 } });
    expect(await p.consume(args)).toBe("SUCCEEDED");
    expect(calls[0]!.bizContent).toEqual({ ...ids, amount: 1, consume_reason: "hive order" });
  });

  it("maps insufficient quota, in either form", async () => {
    const err = provider({ [M("quota.verify")]: { code: "40004", msg: "Business Failed", sub_code: "NOW_PAY_QUOTA_INSUFFICIENT" } });
    expect(await err.p.consume(args)).toBe("INSUFFICIENT");
    const failed = provider({ [M("quota.verify")]: { code: "10000", consume_status: "FAILED" } });
    expect(await failed.p.consume(args)).toBe("FAILED");
  });

  it("recovers PROCESSING and unknown results with quota.refresh on the original request number", async () => {
    const processing = provider({
      [M("quota.verify")]: { code: "10000", consume_status: "PROCESSING" },
      [M("quota.refresh")]: { code: "10000", consume_status: "SUCCEEDED", consumed: 1 },
    });
    expect(await processing.p.consume(args)).toBe("SUCCEEDED");
    expect(processing.calls[1]).toEqual({ method: M("quota.refresh"), bizContent: ids });

    const timeout = provider({
      [M("quota.verify")]: () => {
        throw new Error("socket hang up");
      },
      [M("quota.refresh")]: { code: "40004", sub_code: "CONSUME_REQUEST_NOT_FOUND" },
    });
    // Not found doesn't prove it didn't run: stay pending, the retry repeats verify with the same number.
    expect(await timeout.p.consume(args)).toBe("PROCESSING");

    const busy = provider({
      [M("quota.verify")]: { code: "20000", msg: "Service Currently Unavailable" },
      [M("quota.refresh")]: { code: "20000", msg: "Service Currently Unavailable" },
    });
    expect(await busy.p.consume(args)).toBe("PROCESSING");
  });

  it("surfaces definite gateway errors", async () => {
    const broken = provider({ [M("quota.verify")]: { code: "40004", msg: "Business Failed", sub_code: "NOW_PAY_BINDING_INVALID" } });
    await expect(broken.p.consume(args)).rejects.toBeInstanceOf(NowPayError);
    expect(broken.calls).toHaveLength(1);
  });
});
