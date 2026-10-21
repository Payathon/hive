import { afterEach, describe, expect, it } from "vitest";
import { HiveClient } from "@hive/client/api";
import { Listener } from "./listener.ts";
import { competitorOrder, startTestServer } from "./test-server.ts";

const DATA = "data.market";
const good = JSON.stringify({ stores: [{ name: "一点点", area: "湖滨", address: "平海路 1 号" }], source: "seed" });

let stop: (() => void) | undefined;
afterEach(() => stop?.());

async function start() {
  const env = await startTestServer();
  stop = env.stop;
  return env;
}

async function sellerWith(run: string | undefined) {
  // Work done by hand needs a delivery time instead of a run command.
  const env = await start();
  const sellerToken = await env.signup("seller");
  const logs: string[] = [];
  const listener = new Listener(
    new HiveClient(env.base, sellerToken),
    [{ category: DATA, tags: [], accept: "auto", daily_limit: 10, ...(run ? { run } : { delivery_hours: 2 }) }],
    (m) => logs.push(m),
  );
  await listener.sync();
  await listener.pollOnce(0); // goes online
  const buyer = new HiveClient(env.base, await env.signup("buyer"));
  return { ...env, listener, buyer, logs };
}

// Drives one order: offer -> auto-accept -> buyer pays -> listener works.
async function runOrder(t: Awaited<ReturnType<typeof sellerWith>>, order: Parameters<HiveClient["createOrder"]>[0] = competitorOrder) {
  const created = await t.buyer.createOrder(order);
  await t.listener.pollOnce(0);
  const accepted = await t.buyer.order(created.id);
  expect(accepted.status).toBe("AWAITING_PAYMENT");
  await t.pay(accepted.purchaseUrl!);
  expect((await t.buyer.orderAction(created.id, "check-payment")).status).toBe("PAID");
  await t.listener.pollOnce(0);
  await t.listener.drain();
  return t.buyer.order(created.id);
}

describe("hive serve", () => {
  it("syncs listings with the price from payment setup", async () => {
    const t = await sellerWith(`printf '%s' '${good}'`);
    expect(t.logs[0]).toBe(`listed ${DATA} at ¥5.00 (auto)`);
  });

  it("accepts, waits for payment, runs the agent and delivers", async () => {
    const t = await sellerWith(`printf '%s' '${good}'`);
    const done = await runOrder(t);
    expect(done.status).toBe("DELIVERED");
    expect(done.output).toEqual({ note: null, data: JSON.parse(good), files: [] });
  });

  it("uploads the files the command leaves in $HIVE_OUTPUT_DIR, with its reply as the note", async () => {
    const t = await sellerWith(`printf 'svg' > "$HIVE_OUTPUT_DIR/chart.svg"; printf 'x' > "$HIVE_OUTPUT_DIR/b.png"; echo 'two images'`);
    const done = await runOrder(t, { category: DATA, brief: "two images", delivery: { kind: "files", accept: "image/*", count: 2 } });
    expect(done.status).toBe("DELIVERED");
    expect(done.output!.note).toBe("two images");
    expect(done.output!.files.map((f) => [f.name, f.mime, f.size])).toEqual([
      ["b.png", "image/png", 1],
      ["chart.svg", "image/svg+xml", 3],
    ]);
    const res = await fetch(t.buyer.fileUrl(done.output!.files[1]!));
    expect(await res.text()).toBe("svg");
  });

  it("retries with the format error until the delivery fits", async () => {
    // First run prints junk-shaped JSON, the second prints the real thing.
    const counter = `${process.env.TMPDIR ?? "/tmp"}/hive-attempt-${Date.now()}`;
    const t = await sellerWith(
      `if [ -f ${counter} ]; then printf '%s' '${good}'; else touch ${counter}; echo '{"wrong":true}'; fi`,
    );
    const done = await runOrder(t);
    expect(done.status).toBe("DELIVERED");
    expect(done.deliveryAttempts).toBe(2);
  });

  it("leaves paid orders without a run command to the owner", async () => {
    const t = await sellerWith(undefined);
    expect(t.logs[0]).toBe(`listed ${DATA} at ¥5.00 (auto, by hand within 2h)`);
    const paid = await runOrder(t);
    await t.listener.pollOnce(0);
    expect(paid.status).toBe("PAID");
    expect(t.logs.filter((m) => m.includes("hive_deliver"))).toHaveLength(1);
  });

  it("abandons the order after repeated failures", async () => {
    const t = await sellerWith("exit 1");
    const done = await runOrder(t);
    expect(done.status).toBe("FAILED");
    expect(done.failReason).toBe("seller_abandoned");
  });
});
