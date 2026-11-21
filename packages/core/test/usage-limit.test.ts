import { PLANS, type PlanRow } from "@nd-factory/contracts/data";
import { describe, expect, it } from "vitest";
import { createClock } from "../src/clock.ts";
import { expressionsOf, writeAtomically } from "../src/conditional-write.ts";
import { judgeUsage, usageAddItem, type UsageInput } from "../src/usage-limit.ts";
import { fakeTable } from "./fakes/table.ts";

// プランの名前で分けず、行の値だけで決まることを、作り物のプランの行で照らす

const usd = (amount_minor: number) => ({ amount_minor, currency: "USD" });

const limited: PlanRow = { name: "acme_small", places: ["hosted"], inference: ["managed"], concurrency: 2, monthly_cap: usd(10_000) };

const input = (over: Partial<UsageInput> = {}): UsageInput => ({ moment: "start", place: "hosted", inference: "managed", used: usd(0), cap: null, runningLanes: 0, ...over });

describe("judgeUsage", () => {
  it("上限の内なら allowed", () => {
    for (const moment of ["start", "assign", "segment_boundary"] as const) expect(judgeUsage(input({ moment, used: usd(9_999), runningLanes: 1 }), limited)).toEqual({ allowed: true });
  });

  it("使った額が上限額ちょうどで monthly_cap_reached。始めるでは待っても解けず、区間の境では待てば解ける", () => {
    expect(judgeUsage(input({ used: usd(10_000) }), limited)).toEqual({ allowed: false, reason: "monthly_cap_reached", waitable: false });
    expect(judgeUsage(input({ moment: "segment_boundary", used: usd(10_000) }), limited)).toEqual({ allowed: false, reason: "monthly_cap_reached", waitable: true });
  });

  it("チームが決めた上限額をプランの既定より先に使う", () => {
    expect(judgeUsage(input({ used: usd(500), cap: usd(500) }), limited)).toMatchObject({ allowed: false, reason: "monthly_cap_reached" });
    expect(judgeUsage(input({ used: usd(10_000), cap: usd(20_000) }), limited)).toEqual({ allowed: true });
  });

  it("実行の場所と推論の手段が許されないと始められない（待っても解けない）", () => {
    expect(judgeUsage(input({ place: "machine" }), limited)).toEqual({ allowed: false, reason: "place_not_allowed", waitable: false });
    expect(judgeUsage(input({ inference: "byok" }), limited)).toEqual({ allowed: false, reason: "inference_not_allowed", waitable: false });
  });

  it("同時の数がちょうど満ちると concurrency_full（待てば解ける）", () => {
    expect(judgeUsage(input({ moment: "assign", runningLanes: 1 }), limited)).toEqual({ allowed: true });
    expect(judgeUsage(input({ moment: "assign", runningLanes: 2 }), limited)).toEqual({ allowed: false, reason: "concurrency_full", waitable: true });
  });

  it("使った額と上限額の通貨が違うと currency_mismatch（換算しない）", () => {
    expect(judgeUsage(input({ used: { amount_minor: 1, currency: "JPY" } }), limited)).toEqual({ allowed: false, reason: "currency_mismatch", waitable: false });
    expect(judgeUsage(input({ moment: "segment_boundary", used: usd(1), cap: { amount_minor: 100, currency: "EUR" } }), limited)).toMatchObject({ reason: "currency_mismatch" });
  });

  it("上限なしの行は同時の数と上限額を照らさない", () => {
    const unlimited = PLANS.find((p) => p.name === "unlimited");
    if (unlimited === undefined) throw new Error("上限なしの行が無い");
    expect(judgeUsage(input({ moment: "assign", runningLanes: 1_000 }), unlimited)).toEqual({ allowed: true });
    expect(judgeUsage(input({ place: "machine", inference: "byok", used: usd(10 ** 9) }), unlimited)).toEqual({ allowed: true });
    // 持ち主が決めた上限額は上限なしの行でも効く
    expect(judgeUsage(input({ used: usd(100), cap: usd(100) }), unlimited)).toMatchObject({ reason: "monthly_cap_reached" });
  });

  it("名前だけ違う同じ値のプランは同じ結果になる", () => {
    const renamed = { ...limited, name: "acme_other" };
    expect(judgeUsage(input({ used: usd(10_000) }), renamed)).toEqual(judgeUsage(input({ used: usd(10_000) }), limited));
  });
});

describe("usageAddItem", () => {
  const TEAM = "team_01890a5d-ac96-774b-bcce-b302099a8057";
  const clock = createClock(() => Date.parse("2026-11-30T23:59:59.999Z"));
  const key = { pk: `TEAM#${TEAM}`, sk: "USAGE#2026-11" };

  it("通貨の条件と加算を持つ 1 件で、行が無ければ作る", async () => {
    const item = usageAddItem(TEAM, usd(120), clock);
    expect(item).toMatchObject({ table: "teams", op: "update", key });
    expect(expressionsOf(item.condition, item.update).ConditionExpression).toBe("(attribute_not_exists(#n0) OR #n1 = :v0)");
    const table = fakeTable();
    expect(await writeAtomically(table.db, [item])).toEqual({ ok: true });
    expect(await writeAtomically(table.db, [usageAddItem(TEAM, usd(30), clock)])).toEqual({ ok: true });
    expect(table.row("teams", key)).toMatchObject({ team_id: TEAM, month: "2026-11", used_amount_minor: 150, used_currency: "USD", version: 2, schema_version: 1 });
  });

  it("UTC の年月で行を分ける", () => {
    const next = createClock(() => Date.parse("2026-12-01T00:00:00.000Z"));
    expect(usageAddItem(TEAM, usd(1), next).key).toEqual({ pk: `TEAM#${TEAM}`, sk: "USAGE#2026-12" });
  });

  it("金額 0 でも行を作る", async () => {
    const table = fakeTable();
    expect(await writeAtomically(table.db, [usageAddItem(TEAM, usd(0), clock)])).toEqual({ ok: true });
    expect(table.row("teams", key)).toMatchObject({ used_amount_minor: 0 });
  });

  it("通貨の違いで条件が外れ、加算しない", async () => {
    const table = fakeTable();
    await writeAtomically(table.db, [usageAddItem(TEAM, usd(100), clock)]);
    const outcome = await writeAtomically(table.db, [usageAddItem(TEAM, { amount_minor: 5, currency: "EUR" }, clock)]);
    expect(outcome).toEqual({ ok: false, failed: [{ index: 0, onConflict: "state_mismatch" }] });
    expect(table.row("teams", key)).toMatchObject({ used_amount_minor: 100, used_currency: "USD" });
  });

  it("負の金額と整数でない金額は投げる", () => {
    expect(() => usageAddItem(TEAM, usd(-1), clock)).toThrow(RangeError);
    expect(() => usageAddItem(TEAM, usd(1.5), clock)).toThrow(RangeError);
  });
});
