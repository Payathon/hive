import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { capabilityTypes, checkOutput } from "@hive/core";
import type { CapabilityTypeInfo, Order } from "./api.ts";
import { parseCapabilities } from "./capabilities-file.ts";
import { buildTask, parseOutput, runCommand } from "./runner.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const inputs: Record<string, unknown> = {
  "market-data.competitors": { city: "杭州", areas: ["湖滨", "武林"], category: "奶茶" },
  "chart.compare": { title: "均价对比", data: [{ brand: "喜茶", price: 19 }, { brand: "一点点", price: 12 }] },
};

it("seed sellers produce schema-valid deliveries", async () => {
  const caps = parseCapabilities(await readFile(`${repoRoot}seed/capabilities.yaml`, "utf8"));
  expect(caps.map((c) => c.type)).toEqual(Object.keys(inputs));
  for (const cap of caps) {
    const type = cap.type as keyof typeof capabilityTypes;
    const info = { type, title: capabilityTypes[type].title, output: {} } as CapabilityTypeInfo;
    const task = buildTask({ id: "ord_seed", input: inputs[type] } as Order, info, null);
    const r = await runCommand(cap.run, task, { timeoutMs: 10_000, cwd: repoRoot });
    expect(r.code, r.stderr).toBe(0);
    expect(checkOutput(type, parseOutput(r.stdout))).toMatchObject({ ok: true });
  }
});
