import { describe, expect, it } from "vitest";
import { checkDelivery, checkDeliverySpec, describeSpec, mimeMatches, type Delivery, type DeliveredFile } from "./delivery.ts";

const file = (name: string, mime: string): DeliveredFile => ({ id: `f_${name}`, name, mime, size: 10 });
const delivery = (over: Partial<Delivery>): Delivery => ({ note: null, data: null, files: [], ...over });

describe("checkDeliverySpec", () => {
  it("accepts the three formats and rejects a schema that doesn't compile", () => {
    expect(checkDeliverySpec({ kind: "any" }).ok).toBe(true);
    expect(checkDeliverySpec({ kind: "files", accept: "image/*", count: 3 }).ok).toBe(true);
    expect(checkDeliverySpec({ kind: "json", schema: { type: "object" } }).ok).toBe(true);
    expect(checkDeliverySpec({ kind: "json", schema: { type: "nope" } })).toMatchObject({ ok: false });
    expect(checkDeliverySpec({ kind: "files", accept: "pictures" }).ok).toBe(false);
    expect(checkDeliverySpec({ kind: "email" }).ok).toBe(false);
  });
});

describe("checkDelivery", () => {
  it("checks JSON data against the buyer's schema", () => {
    const spec = { kind: "json" as const, schema: { type: "object", required: ["n"], properties: { n: { type: "number" } } } };
    expect(checkDelivery(spec, delivery({ data: { n: 1 } })).ok).toBe(true);
    expect(checkDelivery(spec, delivery({ data: { n: "1" } }))).toMatchObject({ ok: false });
    expect(checkDelivery(spec, delivery({ note: "done", files: [file("a.png", "image/png")] }))).toMatchObject({ ok: false });
  });

  it("checks only the count and type of files", () => {
    const spec = { kind: "files" as const, accept: "image/*", count: 2 };
    expect(checkDelivery(spec, delivery({ files: [file("a.jpg", "image/jpeg"), file("b.png", "image/png")] })).ok).toBe(true);
    expect(checkDelivery(spec, delivery({ files: [file("a.jpg", "image/jpeg")] }))).toMatchObject({ ok: false });
    const wrong = checkDelivery(spec, delivery({ files: [file("a.jpg", "image/jpeg"), file("c.mp4", "video/mp4")] }));
    expect(wrong).toMatchObject({ ok: false });
    expect(!wrong.ok && wrong.error).toContain("c.mp4");
    expect(checkDelivery({ kind: "files" }, delivery({}))).toMatchObject({ ok: false });
  });

  it("takes anything non-empty when the format is open", () => {
    expect(checkDelivery({ kind: "any" }, delivery({ note: "  " }))).toMatchObject({ ok: false });
    expect(checkDelivery({ kind: "any" }, delivery({ note: "here it is " }))).toEqual({ ok: true, value: delivery({ note: "here it is" }) });
    expect(checkDelivery({ kind: "any" }, delivery({ data: [1] })).ok).toBe(true);
  });
});

it("matches MIME patterns", () => {
  expect(mimeMatches("image/*", "image/png")).toBe(true);
  expect(mimeMatches("video/mp4, video/quicktime", "video/quicktime")).toBe(true);
  expect(mimeMatches("video/mp4", "video/webm")).toBe(false);
  expect(mimeMatches("*/*", "application/pdf")).toBe(true);
});

it("describes a format in one line", () => {
  expect(describeSpec({ kind: "files", accept: "image/*", count: 3 })).toBe("文件 · image/* · 至少 3 个");
  expect(describeSpec({ kind: "any" })).toBe("不限格式");
});
