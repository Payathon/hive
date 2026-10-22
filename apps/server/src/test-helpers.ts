import { fen } from "@hive/core";
import { createApp } from "./app.ts";
import { connectPglite } from "./db/client.ts";
import { Hive, type HiveOptions } from "./hive.ts";
import { FakePaymentProvider } from "./payments/fake.ts";

export const BASE = "http://hive.test";

export const DATA = "data.market";
export const PHOTO = "onsite.photo";

// The buyer's own JSON Schema for competitor data.
export const competitorSchema = {
  type: "object",
  required: ["stores", "source"],
  properties: {
    stores: { type: "array", minItems: 1, items: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
    source: { type: "string" },
  },
};

// Order bodies as a buyer (or their agent) posts them.
export const orders = {
  [DATA]: {
    category: DATA,
    brief: "杭州湖滨的奶茶竞品门店",
    input: { city: "杭州", areas: ["湖滨"], category: "奶茶" },
    delivery: { kind: "json", schema: competitorSchema },
  },
  [PHOTO]: { category: PHOTO, brief: "去湖滨银泰拍奶茶店门面", delivery: { kind: "files", accept: "image/*", count: 1 } },
} as const;

export const validDelivery = { data: { stores: [{ name: "一点点", area: "湖滨", address: "平海路 1 号" }], source: "seed" } };

export async function setup(opts: Pick<HiveOptions, "mailer" | "push"> = {}) {
  let now = new Date("2026-10-14T02:00:00Z");
  const payments = new FakePaymentProvider(BASE);
  const hive = new Hive({ db: await connectPglite(), payments, clock: () => now, webUrl: "http://web.test", ...opts });
  const app = createApp(hive);

  async function call(method: string, path: string, token?: string, body?: unknown) {
    const res = await app.request(`${BASE}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  // Asserts a 2xx and returns the body.
  async function ok(method: string, path: string, token?: string, body?: unknown) {
    const r = await call(method, path, token, body);
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  async function account(name: string) {
    const { token, accountId } = await ok("POST", "/v1/accounts", undefined, { name });
    return { token: token as string, id: accountId as string };
  }

  // Binds an agent token to the account through the `hive login` device flow.
  async function agentToken(humanToken: string) {
    const dl = await ok("POST", "/v1/device-logins", undefined, { label: "test agent" });
    await ok("POST", "/v1/device-logins/approve", humanToken, { userCode: dl.userCode });
    const r = await ok("POST", `/v1/device-logins/${dl.id}/poll`, undefined, { secret: dl.secret });
    return r.token as string;
  }

  // Raw file upload, as the web and CLI send it.
  async function upload(token: string, orderId: string, name: string, mime: string, body: string) {
    const res = await app.request(`${BASE}/v1/orders/${orderId}/files?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": mime },
      body,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  // An agent seller with a priced, enabled listing whose listener is online.
  async function agentSeller(name: string, category: string, priceFen = 500, tags: string[] = []) {
    const human = await account(name);
    const agent = await agentToken(human.token);
    const listing = await ok("PUT", `/v1/listings/${category}`, agent, { acceptMode: "auto", dailyLimit: 10, tags });
    payments.setPrice(listing.id, fen(priceFen));
    await ok("POST", `/v1/listings/${category}/payment-setup`, agent);
    await ok("GET", "/v1/seller/poll", agent);
    return { ...human, agent, listingId: listing.id as string };
  }

  // A person who approves each order and does the work by hand, as listed from the web 接单台.
  async function humanSeller(
    name: string,
    category: string,
    priceFen = 1500,
    opts: { acceptMode?: "auto" | "ask"; deliveryHours?: number } = {},
  ) {
    const human = await account(name);
    const listing = await ok("PUT", `/v1/listings/${category}`, human.token, {
      acceptMode: opts.acceptMode ?? "ask",
      workMode: "manual",
      deliveryHours: opts.deliveryHours ?? 2,
      dailyLimit: 5,
    });
    payments.setPrice(listing.id, fen(priceFen));
    await ok("POST", `/v1/listings/${category}/payment-setup`, human.token);
    await ok("POST", "/v1/seller/accepting", human.token, { on: true });
    return { ...human, listingId: listing.id as string };
  }

  // What the buyer's tap in Alipay does in the fake provider.
  async function pay(order: { purchaseUrl: string }) {
    const res = await app.request(order.purchaseUrl, { method: "POST" });
    if (res.status !== 200) throw new Error(`fake pay failed: ${res.status}`);
  }

  return {
    hive,
    app,
    payments,
    call,
    ok,
    upload,
    account,
    agentToken,
    agentSeller,
    humanSeller,
    pay,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}
