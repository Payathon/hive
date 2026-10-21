import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { checkDelivery, type DeliverySpec } from "@hive/core";
import { guessMime, type Order } from "@hive/client/api";
import { parseCapabilities } from "./capabilities-file.ts";
import { buildTask, outputFiles, readReply, runCommand } from "./runner.ts";
import { competitorSchema } from "./test-server.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// The demo's orders: what the buyer agent sends to each seed seller.
const orders: Record<string, { brief: string; input: unknown; deliverySpec: DeliverySpec }> = {
  "data.market": {
    brief: "杭州湖滨、武林的奶茶竞品门店",
    input: { city: "杭州", areas: ["湖滨", "武林"], category: "奶茶" },
    deliverySpec: { kind: "json", schema: competitorSchema },
  },
  "design.chart": {
    brief: "各品牌均价对比图",
    input: { title: "均价对比", data: [{ brand: "喜茶", price: 19 }, { brand: "一点点", price: 12 }] },
    deliverySpec: { kind: "files", accept: "image/*", count: 1 },
  },
};

it("seed sellers deliver in the format the demo's orders ask for", async () => {
  const caps = parseCapabilities(await readFile(`${repoRoot}seed/capabilities.yaml`, "utf8"));
  expect(caps.map((c) => c.category)).toEqual(Object.keys(orders));
  for (const cap of caps) {
    const order = { id: "ord_seed", ...orders[cap.category] } as Order;
    const outputDir = await mkdtemp(join(tmpdir(), "hive-seed-"));
    const task = buildTask(order, { id: cap.category, title: cap.category }, null, outputDir);
    expect(cap.run, `seed ${cap.category} needs a run command`).toBeDefined();
    const r = await runCommand(cap.run!, task, { timeoutMs: 10_000, cwd: repoRoot, outputDir });
    expect(r.code, r.stderr).toBe(0);
    const files = (await outputFiles(outputDir)).map((f, i) => ({ id: `f${i}`, name: f.name, mime: guessMime(f.name), size: f.bytes.length }));
    const delivery = { ...readReply(r.stdout, order.deliverySpec), files };
    expect(checkDelivery(order.deliverySpec, delivery)).toMatchObject({ ok: true });
  }
});
