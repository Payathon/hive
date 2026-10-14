import { expect, it } from "vitest";
import { startOfShanghaiDay } from "./hive.ts";

it("starts the day at midnight China time", () => {
  // 01:30 on Oct 15 in Shanghai is still 17:30 UTC on Oct 14.
  expect(startOfShanghaiDay(new Date("2026-10-14T17:30:00Z")).toISOString()).toBe("2026-10-14T16:00:00.000Z");
  expect(startOfShanghaiDay(new Date("2026-10-14T15:59:00Z")).toISOString()).toBe("2026-10-13T16:00:00.000Z");
});
