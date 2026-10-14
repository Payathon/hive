import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { HiveClient } from "./api.ts";
import { Listener } from "./listener.ts";
import { startTestServer } from "./test-server.ts";

const exec = promisify(execFile);
const main = fileURLToPath(new URL("./main.ts", import.meta.url));
const good = JSON.stringify({ stores: [{ name: "一点点", area: "湖滨", address: "平海路 1 号" }], source: "seed" });
const orderArgs = ["order", "market-data.competitors", "--input", JSON.stringify({ city: "杭州", areas: ["湖滨"], category: "奶茶" })];

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function env() {
  const server = await startTestServer();
  cleanups.push(server.stop);
  const home = await mkdtemp(join(tmpdir(), "hive-cli-"));
  // Runs the real CLI entry point as an agent would.
  const hive = async (...args: string[]) => {
    const r = await exec(process.execPath, ["--import", "tsx", main, ...args], {
      env: { ...process.env, HIVE_HOME: home, HIVE_SERVER: server.base, HIVE_ORDER_WAIT_MS: "10000" },
    });
    return r.stdout;
  };
  return { ...server, hive };
}

// A seed seller listening in-process so orders get accepted.
async function listeningSeller(base: string, token: string) {
  const listener = new Listener(
    new HiveClient(base, token),
    [{ type: "market-data.competitors", accept: "auto", daily_limit: 10, run: `printf '%s' '${good}'` }],
    () => {},
    1,
  );
  await listener.sync();
  await listener.pollOnce(0); // online before any order is placed
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
  return listener;
}

it("login prints the code without blocking, and whoami picks up the token once approved", async () => {
  const t = await env();
  const ownerToken = await t.signup("owner");
  const out = await t.hive("login");
  const code = /hive approve ([A-F0-9]{8})/.exec(out)?.[1];
  expect(code).toBeTruthy();
  await expect(t.hive("whoami")).rejects.toThrow(/unauthorized/);
  await new HiveClient(t.base, ownerToken).request("POST", "/v1/device-logins/approve", { userCode: code });
  expect(JSON.parse(await t.hive("whoami", "--json")).actor).toBe("agent");
});

it("order waits for an agent seller and returns the payment link", async () => {
  const t = await env();
  await listeningSeller(t.base, await t.signup("seller"));
  const buyerToken = await t.signup("buyer");
  const out = await exec(process.execPath, ["--import", "tsx", main, ...orderArgs, "--json"], {
    env: { ...process.env, HIVE_HOME: await mkdtemp(join(tmpdir(), "hive-cli-")), HIVE_SERVER: t.base, HIVE_TOKEN: buyerToken },
  });
  const order = JSON.parse(out.stdout);
  expect(order.status).toBe("AWAITING_PAYMENT");
  expect(order.purchaseUrl).toContain("/v1/dev/fake-pay/");
});

it("status --wait stops when payment is needed instead of running past it", async () => {
  const t = await env();
  const buyerToken = await t.signup("buyer");
  const buyer = new HiveClient(t.base, buyerToken);
  await listeningSeller(t.base, await t.signup("seller"));
  // Raw API create returns while still OFFERED; status --wait has to carry it to the payment step.
  const created = await buyer.createOrder("market-data.competitors", { city: "杭州", areas: ["湖滨"], category: "奶茶" });
  const out = await exec(process.execPath, ["--import", "tsx", main, "status", created.id, "--wait", "--json"], {
    env: { ...process.env, HIVE_HOME: await mkdtemp(join(tmpdir(), "hive-cli-")), HIVE_SERVER: t.base, HIVE_TOKEN: buyerToken },
  });
  expect(JSON.parse(out.stdout).status).toBe("AWAITING_PAYMENT");
});
