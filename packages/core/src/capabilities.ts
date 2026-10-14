import { z } from "zod";

const MINUTE = 60_000;

// Platform-defined capability types. Dispatch, delivery validation and
// reassignment all rely on every seller of a type sharing these schemas.
export const capabilityTypes = {
  "market-data.competitors": {
    title: "竞品门店数据",
    input: z.object({
      city: z.string().min(1),
      areas: z.array(z.string().min(1)).min(1),
      category: z.string().min(1),
    }),
    output: z.object({
      stores: z.array(
        z.object({
          name: z.string(),
          area: z.string(),
          address: z.string(),
          priceLevel: z.number().optional(),
          rating: z.number().optional(),
        }),
      ),
      source: z.string(),
    }),
    workTimeoutMs: 10 * MINUTE,
  },
  "chart.compare": {
    title: "对比图表",
    input: z.object({
      title: z.string().min(1),
      data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1),
      instructions: z.string().optional(),
    }),
    output: z.object({
      imageUrl: z.url(),
      caption: z.string(),
    }),
    workTimeoutMs: 10 * MINUTE,
  },
  "photo.onsite": {
    title: "实地拍照",
    input: z.object({
      location: z.string().min(1),
      subject: z.string().min(1),
      count: z.number().int().min(1).max(20),
    }),
    output: z.object({
      photos: z.array(z.object({ url: z.url(), note: z.string().optional() })).min(1),
    }),
    workTimeoutMs: 120 * MINUTE,
  },
} as const;

export type CapabilityType = keyof typeof capabilityTypes;

export function isCapabilityType(s: string): s is CapabilityType {
  return Object.hasOwn(capabilityTypes, s);
}

export type CheckResult = { ok: true; value: unknown } | { ok: false; error: string };

function check(schema: z.ZodType, value: unknown): CheckResult {
  const r = schema.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: z.prettifyError(r.error) };
}

export function checkInput(type: CapabilityType, input: unknown): CheckResult {
  return check(capabilityTypes[type].input, input);
}

export function checkOutput(type: CapabilityType, output: unknown): CheckResult {
  return check(capabilityTypes[type].output, output);
}
