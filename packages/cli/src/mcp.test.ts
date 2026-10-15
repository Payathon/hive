import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import { HiveClient } from "@hive/client/api";
import { Listener } from "./listener.ts";
import { createMcpServer } from "./mcp.ts";
import { startTestServer } from "./test-server.ts";

const good = { stores: [{ name: "一点点", area: "湖滨", address: "平海路 1 号" }], source: "seed" };
const input = { city: "杭州", areas: ["湖滨"], category: "奶茶" };

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

async function listeningSeller(base: string, token: string) {
  const listener = new Listener(
    new HiveClient(base, token),
    [{ type: "market-data.competitors", accept: "auto", daily_limit: 10, run: `printf '%s' '${JSON.stringify(good)}'` }],
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

  const code = /hive approve ([A-F0-9]{8})/.exec((await t.call("hive_login")).text)?.[1];
  await new HiveClient(t.base, ownerToken).request("POST", "/v1/device-logins/approve", { userCode: code });
  expect(JSON.parse((await t.call("hive_whoami")).text).actor).toBe("agent");

  const ordered = await t.call("hive_order", { type: "market-data.competitors", input });
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
