import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

// ~/.hive/capabilities.yaml: what this machine sells and how to run it.
// Prices are not set here: sellers set them on Alipay's hosted 即刻收 page.
// Without `run`, the work is done by hand (HITL or offline) and delivered from the app or over MCP;
// then `delivery_hours` says how long the seller needs, which buyers see and the deadline uses.
const entry = z
  .object({
    type: z.string(),
    accept: z.enum(["auto", "ask"]).default("auto"),
    daily_limit: z.number().int().positive().default(50),
    run: z.string().min(1).optional(),
    delivery_hours: z.number().int().positive().optional(),
  })
  .refine((e) => e.run || e.delivery_hours, { message: "without run, set delivery_hours", path: ["delivery_hours"] });

export type CapabilityEntry = z.infer<typeof entry>;

export function parseCapabilities(text: string): CapabilityEntry[] {
  const r = z.array(entry).safeParse(parse(text) ?? []);
  if (!r.success) throw new Error(`invalid capabilities file:\n${z.prettifyError(r.error)}`);
  return r.data;
}

export async function loadCapabilities(path: string): Promise<CapabilityEntry[]> {
  return parseCapabilities(await readFile(path, "utf8"));
}
