import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import { HiveClient } from "@hive/client/api";
import { Listener } from "./listener.ts";
import { createMcpServer } from "./mcp.ts";
import { competitorOrder, startTestServer } from "./test-server.ts";

const good = { stores: [{ name: "一点点", area: "湖滨", address: "平海路 1 号" }], source: "seed" };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function env() {
  const server = await startTestServer();
  cleanups.push(server.stop);
  process.env.HIVE_HOME = await mkdtemp(join(tmpdir(), "hive-mcp-"));
  process.env.HIVE_SERVER = server.base;
  process.env.HIVE_MCP_WAIT_MS = "10000";
  delete process.env.HIVE_TOKEN;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverSide);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientSide);
  cleanups.push(() => mcp.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]!.text, isError: r.isError ?? false };
  };
  return { ...server, mcp, call };
}

// Without a run command the seller delivers by hand, here through its agent over MCP.
async function listeningSeller(base: string, token: string, run: string | null = `printf '%s' '${JSON.stringify(good)}'`) {
  const listener = new Listener(
    new HiveClient(base, token),
    [{ category: "data.market", tags: [], accept: "auto", daily_limit: 10, ...(run ? { run } : { delivery_hours: 2 }) }],
    () => {},
    1,
  );
  await listener.sync();
  await listener.pollOnce(0);
  const loop = (async () => {
    while (true) {
      try {
        await listener.pollOnce();
      } catch {
        return;
      }
    }
  })();
  cleanups.push(async () => {
    await listener.stop();
    await loop;
  });
}

it("offers the buying tools but no way to approve a login", async () => {
  const t = await env();
  const names = (await t.mcp.listTools()).tools.map((x) => x.name);
  expect(names).toContain("hive_order");
  expect(names.some((n) => n.includes("approve"))).toBe(false);
});

it("logs in through the owner and buys an order end to end", async () => {
  const t = await env();
  await listeningSeller(t.base, await t.signup("seller"));
  const ownerToken = await t.signup("owner");

  const unauthorized = await t.call("hive_whoami");
  expect(unauthorized.isError).toBe(true);
  expect(unauthorized.text).toMatch(/hive_login/);

  const code = /\/approve\?code=([A-F0-9]{8})/.exec((await t.call("hive_login")).text)?.[1];
  await new HiveClient(t.base, ownerToken).request("POST", "/v1/device-logins/approve", { userCode: code });
  expect(JSON.parse((await t.call("hive_whoami")).text).actor).toBe("agent");

  const ordered = await t.call("hive_order", competitorOrder);
  expect(ordered.text).toContain("AWAITING_PAYMENT");
  const id = ordered.text.split(/\s+/)[0]!;
  const url = /^\s+(http\S+)$/m.exec(ordered.text)![1]!;

  await t.pay(url);
  expect((await t.call("hive_pay", { order_id: id, wait: true })).text).not.toContain("AWAITING_PAYMENT");
  const delivered = await t.call("hive_status", { order_id: id, wait: true });
  expect(delivered.text).toContain("DELIVERED");
  expect(delivered.text).toContain("hive_accept");
  expect((await t.call("hive_accept", { order_id: id })).text).toContain("COMPLETED");
});

it("lets the seller's agent read a paid order and deliver it", async () => {
  const t = await env();
  const sellerToken = await t.signup("seller");
  await listeningSeller(t.base, sellerToken, null);
  const code = /\/approve\?code=([A-F0-9]{8})/.exec((await t.call("hive_login")).text)?.[1];
  await new HiveClient(t.base, sellerToken).request("POST", "/v1/device-logins/approve", { userCode: code });

  const buyer = new HiveClient(t.base, await t.signup("buyer"));
  let order = await buyer.createOrder(competitorOrder);
  for (let i = 0; i < 50 && order.status !== "AWAITING_PAYMENT"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    order = await buyer.order(order.id);
  }
  await t.pay(order.purchaseUrl!);
  expect((await buyer.orderAction(order.id, "check-payment")).status).toBe("PAID");

  expect((await t.call("hive_seller_orders")).text).toContain(order.id);
  const work = await t.call("hive_seller_order", { order_id: order.id });
  expect(work.text).toContain("<buyer_input>");
  expect(work.text).toContain("杭州");

  expect(work.text).toContain('"minItems":1');

  const bad = await t.call("hive_deliver", { order_id: order.id, data: { wrong: true } });
  expect(bad.isError).toBe(true);
  expect(bad.text).toMatch(/invalid_output[\s\S]*hive_deliver again/);

  // A local file by path rides along with the data.
  const photo = join(process.env.HIVE_HOME!, "shop.jpg");
  await writeFile(photo, "jpeg");
  expect((await t.call("hive_deliver", { order_id: order.id, data: good, files: [{ path: photo }] })).text).toContain("delivered");
  const delivered = await buyer.order(order.id);
  expect(delivered.output!.files.map((f) => [f.name, f.mime])).toEqual([["shop.jpg", "image/jpeg"]]);
  expect((await t.call("hive_status", { order_id: order.id })).text).toMatch(/shop\.jpg\s+image\/jpeg\s+4 bytes\s+http/);
  expect(delivered.status).toBe("DELIVERED");
  expect((await t.call("hive_seller_orders")).text).toBe("nothing to deliver right now");
});
