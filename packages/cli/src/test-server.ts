import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { expect } from "vitest";
import { createApp } from "@hive/server/app";
import { connectTestDb } from "@hive/server/db";
import { Hive } from "@hive/server/hive";
import { FakePaymentProvider } from "@hive/server/payments/fake";
import { HiveClient } from "@hive/client/api";

// What a buyer agent asks for when it wants competitor data (the SKILL.md example).
export const competitorSchema = {
  type: "object",
  required: ["stores", "source"],
  properties: {
    stores: {
      type: "array",
      minItems: 1,
      items: { type: "object", required: ["name", "area", "address"], properties: { name: { type: "string" }, area: { type: "string" }, address: { type: "string" } } },
    },
    source: { type: "string" },
  },
};

export const competitorOrder = {
  category: "data.market",
  brief: "杭州湖滨的奶茶竞品门店",
  input: { city: "杭州", areas: ["湖滨"], category: "奶茶" },
  delivery: { kind: "json" as const, schema: competitorSchema },
};

// A real HTTP server (PGlite + fake payments) so CLI code runs exactly as in production.
export async function startTestServer() {
  const payments = new FakePaymentProvider("http://placeholder");
  const hive = new Hive({ db: await connectTestDb(), payments });
  const app = createApp(hive);
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signup = async (name: string) =>
    (await new HiveClient(base, null).request<{ token: string }>("POST", "/v1/accounts", { name })).token;
  // Fake purchase URLs point at the placeholder host; rewrite to the test server.
  const pay = (purchaseUrl: string) =>
    fetch(purchaseUrl.replace("http://placeholder", base), { method: "POST" }).then((r) => expect(r.status).toBe(200));
  return { base, signup, pay, stop: () => server.close() };
}
