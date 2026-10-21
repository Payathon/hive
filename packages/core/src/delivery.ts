import { z } from "zod";

// Categories (数据采集, 剪辑, 线下拍照, ...) live in the database and only steer dispatch.
// What to deliver is the buyer's call, made per order: one of these three formats.

// "image/*", "video/mp4", or several separated by commas.
const mimePattern = z
  .string()
  .regex(/^[\w.+-]+\/(\*|[\w.+-]+)(\s*,\s*[\w.+-]+\/(\*|[\w.+-]+))*$/, "a MIME type such as image/* or video/mp4");

export const deliverySpec = z.discriminatedUnion("kind", [
  // hive checks the delivered data against the buyer's JSON Schema.
  z.object({ kind: z.literal("json"), schema: z.record(z.string(), z.unknown()) }),
  // hive checks only the files' types and count; the buyer judges the rest.
  z.object({
    kind: z.literal("files"),
    accept: mimePattern.optional(),
    // At least this many files.
    count: z.number().int().min(1).max(50).optional(),
  }),
  // Anything non-empty; the buyer judges it.
  z.object({ kind: z.literal("any") }),
]);

export type DeliverySpec = z.infer<typeof deliverySpec>;

export interface DeliveredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

// A delivery: a note for the buyer, optional structured data and optional files.
export interface Delivery {
  note: string | null;
  data: unknown;
  files: DeliveredFile[];
}

export type CheckResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

function compile(schema: Record<string, unknown>): CheckResult<z.ZodType> {
  try {
    return { ok: true, value: z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) };
  } catch (err) {
    return { ok: false, error: `the JSON Schema can't be used: ${(err as Error).message}` };
  }
}

// Validates a spec as the buyer sends it, including that a JSON Schema actually compiles.
export function checkDeliverySpec(raw: unknown): CheckResult<DeliverySpec> {
  const r = deliverySpec.safeParse(raw);
  if (!r.success) return { ok: false, error: z.prettifyError(r.error) };
  if (r.data.kind === "json") {
    const compiled = compile(r.data.schema);
    if (!compiled.ok) return compiled;
  }
  return { ok: true, value: r.data };
}

export function mimeMatches(pattern: string, mime: string): boolean {
  const m = mime.toLowerCase().split(";")[0]!.trim();
  return pattern.split(",").some((p) => {
    const want = p.trim().toLowerCase();
    if (want === "*/*") return true;
    if (want.endsWith("/*")) return m.startsWith(want.slice(0, -1));
    return m === want;
  });
}

const hasData = (d: unknown) => d !== undefined && d !== null;

// The platform's only check on a delivery: does it have the format the buyer asked for.
export function checkDelivery(spec: DeliverySpec, delivery: Delivery): CheckResult<Delivery> {
  const note = delivery.note?.trim() || null;
  const value: Delivery = { note, data: hasData(delivery.data) ? delivery.data : null, files: delivery.files };
  switch (spec.kind) {
    case "json": {
      if (!hasData(delivery.data)) return { ok: false, error: "this order needs JSON data matching the buyer's schema" };
      const compiled = compile(spec.schema);
      if (!compiled.ok) return compiled;
      const r = compiled.value.safeParse(delivery.data);
      return r.success ? { ok: true, value: { ...value, data: r.data } } : { ok: false, error: z.prettifyError(r.error) };
    }
    case "files": {
      const need = spec.count ?? 1;
      if (delivery.files.length < need) return { ok: false, error: `this order needs at least ${need} file(s), got ${delivery.files.length}` };
      const wrong = spec.accept ? delivery.files.filter((f) => !mimeMatches(spec.accept!, f.mime)) : [];
      if (wrong.length) {
        return { ok: false, error: `files must be ${spec.accept}: ${wrong.map((f) => `${f.name} is ${f.mime}`).join(", ")}` };
      }
      return { ok: true, value };
    }
    case "any":
      if (!note && !hasData(delivery.data) && delivery.files.length === 0) {
        return { ok: false, error: "the delivery is empty: add a note, data or files" };
      }
      return { ok: true, value };
  }
}

// One line a person or agent can read, e.g. "文件 · image/* · 至少 3 个".
export function describeSpec(spec: DeliverySpec): string {
  switch (spec.kind) {
    case "json":
      return "JSON（按买家给的 JSON Schema 校验）";
    case "files":
      return ["文件", spec.accept, spec.count ? `至少 ${spec.count} 个` : null].filter(Boolean).join(" · ");
    case "any":
      return "不限格式";
  }
}
