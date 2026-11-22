import { PLANS, type PlanRow } from "@nd-factory/contracts/data";
import { readRow } from "@nd-factory/contracts/row-codec";
import { usageMonthCodec } from "@nd-factory/contracts/rows/teams";
import { describe, expect, it } from "vitest";
import { createClock } from "../src/clock.ts";
import { expressionsOf, writeAtomically } from "../src/conditional-write.ts";
import { judgeUsage, usageAddItem, type UsageInput } from "../src/usage-limit.ts";
import { fakeTable, type FakeTable } from "./fakes/table.ts";

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

  // ハンドラーと同じく、月の使った量の行を強い整合で読み、行の版の読み手で今の形にする（無ければ null）
  async function readUsage(table: FakeTable, at = key) {
    const raw = await table.db.get("teams", at, true);
    if (raw === null) return null;
    const read = readRow(usageMonthCodec, raw);
    if (!read.ok) throw new Error(read.reason);
    return { raw, row: read.row };
  }

  async function add(table: FakeTable, cost: { amount_minor: number; currency: string }) {
    const built = usageAddItem(await readUsage(table), TEAM, cost, clock);
    if (!built.ok) return built;
    return { ...built, outcome: await writeAtomically(table.db, [built.item]) };
  }

  it("行の無い月は、費用を使った額にした行を putIfAbsent（rebuild）で組み、足した後の行を返す", async () => {
    const built = usageAddItem(null, TEAM, usd(120), clock);
    if (!built.ok) throw new Error("ok でない");
    expect(built.item).toMatchObject({ table: "teams", op: "put", key, onConflict: "rebuild" });
    expect(expressionsOf(built.item.condition).ConditionExpression).toBe("attribute_not_exists(#n0)");
    expect(built.row).toMatchObject({ team_id: TEAM, month: "2026-11", used_amount_minor: 120, used_currency: "USD", version: 1, schema_version: 1 });
    expect(built.row.incarnation).toBe(built.item.item?.["incarnation"]);
    const table = fakeTable();
    expect(await writeAtomically(table.db, [built.item])).toEqual({ ok: true });
    expect(table.row("teams", key)).toEqual({ ...key, ...built.row });
  });

  it("読んだ行に費用を足した行全体を、読んだ version と incarnation を条件に replaceIfVersion（rebuild）で組む", async () => {
    const table = fakeTable();
    const created = await add(table, usd(120));
    if (!created.ok) throw new Error("ok でない");
    const added = await add(table, usd(30));
    if (!added.ok) throw new Error("ok でない");
    expect(added.item).toMatchObject({ table: "teams", op: "put", key, onConflict: "rebuild" });
    expect(expressionsOf(added.item.condition)).toMatchObject({
      ConditionExpression: "(attribute_exists(#n0) AND #n1 = :v0 AND #n2 = :v1)",
      ExpressionAttributeValues: { ":v0": 1, ":v1": created.row.incarnation },
    });
    expect(added.outcome).toEqual({ ok: true });
    // 使える量の判定は組んだ行の加算の後の値で行う（確定した値と同じ）
    expect(added.row).toMatchObject({ used_amount_minor: 150, version: 2, incarnation: created.row.incarnation });
    expect(table.row("teams", key)).toEqual({ ...key, ...added.row });
  });

  it("並んだ加算が先に確定すると外れ、rebuild の件として返る（足し直しは読み直して組む）", async () => {
    const table = fakeTable();
    await add(table, usd(100));
    const read = await readUsage(table);
    const first = usageAddItem(read, TEAM, usd(10), clock);
    const second = usageAddItem(read, TEAM, usd(20), clock);
    if (!first.ok || !second.ok) throw new Error("ok でない");
    expect(await writeAtomically(table.db, [first.item])).toEqual({ ok: true });
    expect(await writeAtomically(table.db, [second.item])).toEqual({ ok: false, failed: [{ index: 0, onConflict: "rebuild" }] });
    const again = await add(table, usd(20));
    expect(again.ok && again.outcome).toEqual({ ok: true });
    expect(table.row("teams", key)).toMatchObject({ used_amount_minor: 130, version: 3 });
  });

  it("並んだ 2 つの作成は後の方が外れ、rebuild の件として返る", async () => {
    const table = fakeTable();
    const a = usageAddItem(null, TEAM, usd(10), clock);
    const b = usageAddItem(null, TEAM, usd(20), clock);
    if (!a.ok || !b.ok) throw new Error("ok でない");
    expect(await writeAtomically(table.db, [a.item])).toEqual({ ok: true });
    expect(await writeAtomically(table.db, [b.item])).toEqual({ ok: false, failed: [{ index: 0, onConflict: "rebuild" }] });
    expect(table.row("teams", key)).toMatchObject({ used_amount_minor: 10 });
  });

  it("U3b より前の書き手が保存した行（incarnation の無い行）にも足せ、足した行は incarnation を保存する", async () => {
    const table = fakeTable();
    table.seed("teams", { ...key, schema_version: 1, version: 4, team_id: TEAM, month: "2026-11", used_amount_minor: 100, used_currency: "USD" });
    const read = await readUsage(table);
    const added = await add(table, usd(5));
    if (!added.ok) throw new Error("ok でない");
    expect(added.outcome).toEqual({ ok: true });
    expect(expressionsOf(added.item.condition).ConditionExpression).toBe("(attribute_exists(#n0) AND #n1 = :v0 AND attribute_not_exists(#n2))");
    expect(table.row("teams", key)).toMatchObject({ used_amount_minor: 105, version: 5, incarnation: read?.row.incarnation });
  });

  it("読んだ行に残る知らない列（書き手の版に無い列）は置き換えで消える", async () => {
    const table = fakeTable();
    await add(table, usd(1));
    table.seed("teams", { ...table.row("teams", key), used: { amount_minor: 1, currency: "USD" } });
    await add(table, usd(1));
    expect(table.row("teams", key)).not.toHaveProperty("used");
  });

  it("UTC の年月で行を分ける", () => {
    const next = createClock(() => Date.parse("2026-12-01T00:00:00.000Z"));
    const built = usageAddItem(null, TEAM, usd(1), next);
    expect(built.ok && built.item.key).toEqual({ pk: `TEAM#${TEAM}`, sk: "USAGE#2026-12" });
  });

  it("金額 0 でも行を作る", async () => {
    const table = fakeTable();
    const built = await add(table, usd(0));
    expect(built.ok && built.outcome).toEqual({ ok: true });
    expect(table.row("teams", key)).toMatchObject({ used_amount_minor: 0 });
  });

  it("通貨が違えば書き込みを組まずに state_mismatch を返す", async () => {
    const table = fakeTable();
    await add(table, usd(100));
    const before = table.transactions.length;
    expect(usageAddItem(await readUsage(table), TEAM, { amount_minor: 5, currency: "EUR" }, clock)).toEqual({ ok: false, onConflict: "state_mismatch" });
    expect(table.transactions).toHaveLength(before);
    expect(table.row("teams", key)).toMatchObject({ used_amount_minor: 100, used_currency: "USD" });
  });

  it("負の金額と整数でない金額は投げる", () => {
    expect(() => usageAddItem(null, TEAM, usd(-1), clock)).toThrow(RangeError);
    expect(() => usageAddItem(null, TEAM, usd(1.5), clock)).toThrow(RangeError);
  });

  it("読んだ行のチームが違うと投げる（書き手の誤り）", async () => {
    const table = fakeTable();
    await add(table, usd(1));
    const read = await readUsage(table);
    if (read === null) throw new Error("行が無い");
    expect(() => usageAddItem(read, "team_01890a5d-ac96-774b-bcce-b302099a8058", usd(1), clock)).toThrow(RangeError);
  });

  it("読んだ後に月が替わっても、読んだ行の年月の行へ足す（読みと加算で年月を取り直さない）", async () => {
    const table = fakeTable();
    await add(table, usd(1));
    const read = await readUsage(table);
    if (read === null) throw new Error("行が無い");
    const next = createClock(() => Date.parse("2026-12-01T00:00:00.000Z"));
    const built = usageAddItem(read, TEAM, usd(2), next);
    if (!built.ok) throw new Error("組めない");
    expect(built.row).toMatchObject({ month: read.row.month, used_amount_minor: 3 });
    expect(built.item.key).toEqual({ pk: `TEAM#${TEAM}`, sk: `USAGE#${read.row.month}` });
    expect(await writeAtomically(table.db, [built.item])).toEqual({ ok: true });
  });
});
