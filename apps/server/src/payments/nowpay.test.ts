import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NowPayError, NowPayProvider, parseShanghaiTime, singleCountOption } from "./nowpay.ts";

const product = { productId: "lst_1", ownerId: "acct_seller", productName: "hive · 竞品门店数据" };

function provider(responses: Record<string, Record<string, unknown>>) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const p = new NowPayProvider({
    appId: "2021000000000000",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    alipayPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  const calls: { method: string; bizContent: Record<string, unknown> }[] = [];
  // Stub the gateway: no network in tests.
  (p as unknown as { sdk: unknown }).sdk = {
    exec: async (method: string, params: { bizContent: Record<string, unknown> }) => {
      calls.push({ method, bizContent: params.bizContent });
      return responses[method] ?? { code: "40004", msg: "Business Failed", sub_code: "UNEXPECTED" };
    },
  };
  return { p, calls };
}

it("parses Asia/Shanghai gateway timestamps", () => {
  expect(parseShanghaiTime("2026-09-07 10:30:00").toISOString()).toBe("2026-09-07T02:30:00.000Z");
});

it("picks the single-count tier", () => {
  const opts = [
    { sku_id: "S20", price: "15.00", billing_mode: "QUANTITY", quota_unit: "COUNT", quota_amount: 20 },
    { sku_id: "S1", price: "1.00", billing_mode: "QUANTITY", quota_unit: "COUNT", quota_amount: 1 },
  ];
  expect(singleCountOption(opts)?.sku_id).toBe("S1");
  expect(singleCountOption(opts.slice(0, 1))).toBeNull();
});

describe("setupProduct", () => {
  it("returns price and management link for an enabled product", async () => {
    const { p, calls } = provider({
      "alipay.aipay.nowpay.charge.query": {
        code: "10000",
        capability_status: "ENABLED",
        management_url: "alipays://manage",
        charging_options: [{ sku_id: "S1", price: "5.00", billing_mode: "QUANTITY", quota_unit: "COUNT", quota_amount: 1 }],
      },
    });
    const state = await p.setupProduct(product);
    expect(state).toMatchObject({ status: "ENABLED", priceFen: 500, skuId: "S1", managementUrl: "alipays://manage" });
    expect(calls.map((c) => c.method)).toEqual(["alipay.aipay.nowpay.charge.query"]);
  });

  it("initializes a COUNT product while it isn't configured", async () => {
    const { p, calls } = provider({
      "alipay.aipay.nowpay.charge.query": { code: "10000", capability_status: "NOT_CONFIGURED", charging_options: [] },
      "alipay.aipay.nowpay.charge.initialize": { code: "10000", configuration_url: "alipays://config" },
    });
    const state = await p.setupProduct(product);
    expect(state.configurationUrl).toBe("alipays://config");
    expect(state.priceFen).toBeNull();
    expect(calls[1]!.bizContent).toMatchObject({
      out_product_id: "lst_1",
      external_owner_id: "acct_seller",
      pricing_mode_list: [{ billing_mode: "QUANTITY", quota_unit: "COUNT" }],
    });
  });
});

it("creates a purchase for the buyer on the single-count tier", async () => {
  const { p, calls } = provider({
    "alipay.aipay.nowpay.purchase.create": {
      code: "10000",
      purchase_url: "alipays://buy",
      expire_time: "2026-10-14 10:30:00",
    },
  });
  const purchase = await p.createPurchase({ requestNo: "purchase_o1", product, skuId: "S1", buyerId: "acct_buyer" });
  expect(purchase.purchaseUrl).toBe("alipays://buy");
  expect(purchase.expiresAt.toISOString()).toBe("2026-10-14T02:30:00.000Z");
  expect(calls[0]!.bizContent).toEqual({
    out_request_no: "purchase_o1",
    out_product_id: "lst_1",
    external_owner_id: "acct_seller",
    external_buyer_id: "acct_buyer",
    sku_id: "S1",
  });
});

describe("consume", () => {
  const args = { requestNo: "consume_o1", product, buyerId: "acct_buyer", reason: "hive order" };

  it("consumes exactly one count", async () => {
    const { p, calls } = provider({ "alipay.aipay.nowpay.quota.verify": { code: "10000", consume_status: "SUCCEEDED" } });
    expect(await p.consume(args)).toBe("SUCCEEDED");
    expect(calls[0]!.bizContent).toMatchObject({ out_request_no: "consume_o1", amount: 1 });
  });

  it("maps insufficient quota and surfaces gateway errors", async () => {
    const insufficient = provider({
      "alipay.aipay.nowpay.quota.verify": { code: "40004", msg: "Business Failed", sub_code: "NOW_PAY_QUOTA_INSUFFICIENT" },
    });
    expect(await insufficient.p.consume(args)).toBe("INSUFFICIENT");
    const broken = provider({});
    await expect(broken.p.consume(args)).rejects.toBeInstanceOf(NowPayError);
  });
});
