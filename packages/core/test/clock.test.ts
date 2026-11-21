import { describe, expect, it } from "vitest";
import { createClock } from "../src/clock.ts";

describe("createClock", () => {
  it("差し替えた元の時刻を Date と iso とミリ秒で返す", () => {
    const clock = createClock(() => Date.UTC(2026, 10, 21, 9, 30, 15, 123));
    expect(clock.now()).toEqual(new Date("2026-11-21T09:30:15.123Z"));
    expect(clock.iso()).toBe("2026-11-21T09:30:15.123Z");
    expect(clock.epochMs()).toBe(Date.UTC(2026, 10, 21, 9, 30, 15, 123));
  });

  it("ミリ秒が 0 でも iso は 3 桁で末尾が Z", () => {
    const clock = createClock(() => Date.UTC(2026, 0, 1, 0, 0, 0, 0));
    expect(clock.iso()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.iso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("元の時刻が戻っても、同じ時計から得た値は減らない", () => {
    const times = [2_000, 1_000, 3_000];
    const clock = createClock(() => times.shift() ?? 0);
    expect([clock.epochMs(), clock.epochMs(), clock.epochMs()]).toEqual([2_000, 2_000, 3_000]);
  });

  it("元を渡さなければ今の時刻を返す", () => {
    const before = Date.now();
    const ms = createClock().epochMs();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(Date.now());
  });
});
