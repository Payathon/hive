import { expect, it } from "vitest";
import { fen, fenToYuan, yuanToFen } from "./money.ts";

it("converts between yuan strings and fen", () => {
  expect(yuanToFen("12.5")).toBe(1250);
  expect(yuanToFen("0.01")).toBe(1);
  expect(yuanToFen("15")).toBe(1500);
  expect(fenToYuan(fen(1250))).toBe("12.50");
  expect(fenToYuan(fen(1))).toBe("0.01");
});

it("rejects amounts that would need rounding or are negative", () => {
  expect(() => yuanToFen("1.234")).toThrow();
  expect(() => yuanToFen("-1")).toThrow();
  expect(() => fen(1.5)).toThrow();
});
