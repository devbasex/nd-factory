import { IDEMPOTENCY_TTL_SECONDS } from "@nd-factory/contracts/operation";
import { describe, expect, it } from "vitest";
import { createClock } from "../src/clock.ts";
import { expressionsOf, WriteUnavailableError, writeAtomically } from "../src/conditional-write.ts";
import {
  claimIdempotency,
  IDEMPOTENCY_LEASE_MS,
  idempotencyKeyOf,
  releaseIdempotency,
  settleIdempotency,
  type IdempotencyClaim,
  type IdempotencyClaimInput,
} from "../src/idempotency.ts";
import { SECRET_SAMPLES } from "./fixtures/secrets.ts";
import { fakeTable } from "./fakes/table.ts";

// DynamoDB は呼ばない。偽の表で借りと済みの行を照らす

const T0 = Date.parse("2026-11-21T00:00:00.000Z");

function clockAt(ms: number) {
  let now = ms;
  return { clock: createClock(() => now), set: (next: number) => (now = next) };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// fresh のときに返る借りの行
function leasedOf(claimed: IdempotencyClaim) {
  if (claimed.kind !== "fresh") throw new Error(`fresh でない: ${claimed.kind}`);
  return claimed.leased;
}

const claim = (over: Partial<IdempotencyClaimInput> = {}): IdempotencyClaimInput => ({
  principalKey: "usr_01890a5d-ac96-774b-bcce-b302099a8057",
  operation: "sprints.create",
  key: "4a6f1f0e-1f8b-4c7e-9a52-6b8f0f0e1f8b",
  fingerprint: "a".repeat(64),
  requestId: "req-1",
  ...over,
});

describe("claimIdempotency", () => {
  it("1 回目は fresh で、借りの行がある", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    leasedOf(await claimIdempotency(table.db, claim(), clock));
    const stored = table.row("idempotency", idempotencyKeyOf(claim()));
    expect(stored).toMatchObject({
      state: "leased",
      owner_request_id: "req-1",
      fingerprint: "a".repeat(64),
      lease_until: new Date(T0 + IDEMPOTENCY_LEASE_MS).toISOString(),
      expire_at: Math.floor(T0 / 1000) + IDEMPOTENCY_TTL_SECONDS,
      schema_version: 1,
      version: 1,
    });
    expect(stored?.["incarnation"]).toMatch(UUID_V4);
  });

  it("fresh は書いた借りの行（version 1 と putIfAbsent が入れた incarnation）を返す", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    const leased = leasedOf(await claimIdempotency(table.db, claim(), clock));
    const { pk: _pk, ...stored } = table.row("idempotency", idempotencyKeyOf(claim())) ?? {};
    expect(leased).toEqual(stored);
    expect(leased).toMatchObject({ version: 1, state: "leased", principal_key: claim().principalKey, operation: "sprints.create", key: claim().key });
  });

  it("処理中は in_progress、中身の違いは reused", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock)).toEqual({ kind: "in_progress" });
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2", fingerprint: "b".repeat(64) }), clock)).toEqual({ kind: "reused" });
  });

  it("借りの期限ちょうどの前は in_progress、ちょうどからは fresh で持ち主が替わる", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    set(T0 + IDEMPOTENCY_LEASE_MS - 1);
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock)).toEqual({ kind: "in_progress" });
    set(T0 + IDEMPOTENCY_LEASE_MS);
    const leased = leasedOf(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock));
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ owner_request_id: "req-2", state: "leased" });
    expect(leased).toMatchObject({ owner_request_id: "req-2", lease_until: new Date(T0 + 2 * IDEMPOTENCY_LEASE_MS).toISOString() });
  });

  it("取り直しは新しい借りの行全体を、読んだ version と incarnation を条件に置き換え、version を 1 上げて incarnation を保ち、書いた行を返す", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    const first = leasedOf(await claimIdempotency(table.db, claim(), clock));
    set(T0 + IDEMPOTENCY_LEASE_MS);
    const taken = leasedOf(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock));
    expect(taken).toMatchObject({ version: 2, incarnation: first.incarnation, owner_request_id: "req-2" });
    const retake = table.transactions.at(-1)?.[0];
    expect(retake).toMatchObject({ table: "idempotency", op: "put" });
    expect(expressionsOf(retake?.condition ?? { kind: "and", of: [] }).ExpressionAttributeValues).toEqual({ ":v0": 1, ":v1": first.incarnation });
    const { pk: _pk, ...stored } = table.row("idempotency", idempotencyKeyOf(claim())) ?? {};
    expect(taken).toEqual(stored);
  });

  it("中身の違う送り直しは、借りの期限を過ぎた借りでも reused で、行を書き換えない", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    set(T0 + IDEMPOTENCY_LEASE_MS * 10);
    const before = table.transactions.length;
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2", fingerprint: "b".repeat(64) }), clock)).toEqual({ kind: "reused" });
    // 借りの行の putIfAbsent の 1 回だけで、取り直しを書かない
    expect(table.transactions.length).toBe(before + 1);
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ owner_request_id: "req-1", fingerprint: "a".repeat(64), version: 1 });
  });

  it("U3b より前の書き手が保存した行（version と incarnation の無い行）を読み、取り直しで incarnation を保存する", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0 + IDEMPOTENCY_LEASE_MS);
    const key = idempotencyKeyOf(claim());
    // 区切りの鍵だけの表の行は sk の列を持たない（DynamoDB が返す行と同じ形にする）
    table.seed("idempotency", {
      pk: key.pk,
      schema_version: 1,
      principal_key: claim().principalKey,
      operation: "sprints.create",
      key: claim().key,
      fingerprint: "a".repeat(64),
      state: "leased",
      owner_request_id: "req-1",
      lease_until: new Date(T0).toISOString(),
      expire_at: Math.floor(T0 / 1000) + IDEMPOTENCY_TTL_SECONDS,
    });
    const taken = leasedOf(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock));
    expect(taken.version).toBe(2);
    expect(table.row("idempotency", key)).toMatchObject({ version: 2, incarnation: taken.incarnation, owner_request_id: "req-2" });
  });

  it("読めない行（形を外れた行）は投げる（呼び手が 503 にする）", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    table.seed("idempotency", { ...idempotencyKeyOf(claim()), schema_version: 1, state: "unknown" });
    await expect(claimIdempotency(table.db, claim(), clock)).rejects.toThrow();
  });

  it("期限を過ぎた借りを 2 つが同時に取り直すと、1 つだけが fresh", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    set(T0 + IDEMPOTENCY_LEASE_MS);
    const results = await Promise.all([claimIdempotency(table.db, claim({ requestId: "req-2" }), clock), claimIdempotency(table.db, claim({ requestId: "req-3" }), clock)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["fresh", "in_progress"]);
  });

  it("済みの行で中身が同じなら replay で前の要素の結果を返す", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    const leased = leasedOf(await claimIdempotency(table.db, claim(), clock));
    const result = { ok: true, item: { sprint_id: "spr_01890a5d-ac96-774b-bcce-b302099a8057" } };
    expect(await writeAtomically(table.db, [settleIdempotency(leased, result, NO_ONCE_ONLY, clock)])).toEqual({ ok: true });
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock)).toEqual({ kind: "replay", result });
  });

  it("24 時間を過ぎた済みの行は、表の消しの前でも fresh として取り直す", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    const leased = leasedOf(await claimIdempotency(table.db, claim(), clock));
    await writeAtomically(table.db, [settleIdempotency(leased, { ok: true, item: {} }, NO_ONCE_ONLY, clock)]);
    set(T0 + IDEMPOTENCY_TTL_SECONDS * 1000);
    expect((await claimIdempotency(table.db, claim({ requestId: "req-2", fingerprint: "b".repeat(64) }), clock)).kind).toBe("fresh");
    const row = table.row("idempotency", idempotencyKeyOf(claim()));
    expect(row).toMatchObject({ state: "leased", owner_request_id: "req-2", fingerprint: "b".repeat(64) });
    expect(row).not.toHaveProperty("result");
  });

  it("表の失敗は投げる（呼び手が 503 にする）", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    table.failNext("unavailable");
    await expect(claimIdempotency(table.db, claim(), clock)).rejects.toBeInstanceOf(WriteUnavailableError);
    table.failNext();
    await claimIdempotency(table.db, claim(), clock);
    table.failReads(Object.assign(new Error("down"), { name: "InternalServerError" }));
    await expect(claimIdempotency(table.db, claim({ requestId: "req-2" }), clock)).rejects.toThrow("down");
  });

  it("2 回目の読みは強い整合", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock);
    expect(table.reads.every((r) => r.consistent)).toBe(true);
  });
});

// 1 回だけ返す値を持たない操作と、item.token を 1 回だけ返す操作
const NO_ONCE_ONLY = { onceOnly: [] };
const ISSUES_TOKEN = { onceOnly: ["item.token"] };

describe("settleIdempotency", () => {
  it("済みにし要素の結果を足した行全体を、借りの行の version と incarnation を条件に置き換える 1 件を返す", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    const leased = leasedOf(await claimIdempotency(table.db, claim(), clock));
    const item = settleIdempotency(leased, { ok: false, status: 409, reason: "state_mismatch" }, ISSUES_TOKEN, clock);
    expect(item).toMatchObject({ table: "idempotency", op: "put", key: idempotencyKeyOf(claim()) });
    expect(expressionsOf(item.condition)).toMatchObject({
      ConditionExpression: "(attribute_exists(#n0) AND #n1 = :v0 AND #n2 = :v1)",
      ExpressionAttributeValues: { ":v0": 1, ":v1": leased.incarnation },
    });
    expect(await writeAtomically(table.db, [item])).toEqual({ ok: true });
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({
      state: "settled",
      result: { ok: false, status: 409, reason: "state_mismatch" },
      schema_version: 1,
      version: 2,
      incarnation: leased.incarnation,
      owner_request_id: "req-1",
      fingerprint: "a".repeat(64),
    });
  });

  it("操作が定めた 1 回だけ返す値の場所だけを null に替え、ほかの値は控える", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    const leased = leasedOf(await claimIdempotency(table.db, claim({ operation: "delegations.create" }), clock));
    const token = SECRET_SAMPLES["delegation_token"];
    const result = { ok: true, item: { delegation_id: "dlg_01890a5d-ac96-774b-bcce-b302099a8057", token, token_expires_at: "2026-11-22T03:04:05.678Z", note: { secret: "x" } } };
    await writeAtomically(table.db, [settleIdempotency(leased, result, ISSUES_TOKEN, clock)]);
    const stored = table.row("idempotency", idempotencyKeyOf(claim({ operation: "delegations.create" })));
    // 名前に token を含む token_expires_at や、名前に secret を含む項目は 1 回だけ返す値でないため値のまま
    expect(stored?.["result"]).toEqual({ ok: true, item: { delegation_id: "dlg_01890a5d-ac96-774b-bcce-b302099a8057", token: null, token_expires_at: "2026-11-22T03:04:05.678Z", note: { secret: "x" } } });
    // 元の結果は変えない（呼び手へは 1 回目だけ値を返す）
    expect(result.item.token).toBe(token);
  });

  it("一覧の結果は要素ごとに同じ場所を替える", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    const leased = leasedOf(await claimIdempotency(table.db, claim(), clock));
    const item = settleIdempotency(leased, { ok: true, items: [{ token: "a", id: 1 }, { token: "b", id: 2 }] }, { onceOnly: ["items.token"] }, clock);
    expect(item.item?.["result"]).toEqual({ ok: true, items: [{ token: null, id: 1 }, { token: null, id: 2 }] });
  });

  it("取り直された後（version が変わった後）は条件で外れ、取り直した借りを書き換えない", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    const leased = leasedOf(await claimIdempotency(table.db, claim(), clock));
    set(T0 + IDEMPOTENCY_LEASE_MS);
    leasedOf(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock));
    const outcome = await writeAtomically(table.db, [settleIdempotency(leased, { ok: true, item: {} }, NO_ONCE_ONLY, clock)]);
    expect(outcome).toEqual({ ok: false, failed: [{ index: 0, onConflict: "fail" }] });
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ state: "leased", owner_request_id: "req-2" });
  });

  it("手放した借りを別の要求が同じ鍵で version 1 から借り直すと、前の借りの確定と手放しが incarnation の違いで外れる", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    const leased = leasedOf(await claimIdempotency(table.db, claim(), clock));
    expect(await writeAtomically(table.db, [releaseIdempotency(leased)])).toEqual({ ok: true });
    const again = leasedOf(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock));
    expect(again.version).toBe(1);
    expect(again.incarnation).not.toBe(leased.incarnation);
    expect((await writeAtomically(table.db, [settleIdempotency(leased, { ok: true, item: {} }, NO_ONCE_ONLY, clock)])).ok).toBe(false);
    expect((await writeAtomically(table.db, [releaseIdempotency(leased)])).ok).toBe(false);
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ state: "leased", owner_request_id: "req-2", incarnation: again.incarnation });
  });
});

describe("releaseIdempotency", () => {
  it("借りの行の version と incarnation を条件に消す 1 件を返す", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    const leased = leasedOf(await claimIdempotency(table.db, claim(), clock));
    const item = releaseIdempotency(leased);
    expect(item).toMatchObject({ table: "idempotency", op: "delete", key: idempotencyKeyOf(claim()), onConflict: "fail" });
    expect(expressionsOf(item.condition).ExpressionAttributeValues).toEqual({ ":v0": 1, ":v1": leased.incarnation });
    expect(await writeAtomically(table.db, [item])).toEqual({ ok: true });
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toBeUndefined();
  });

  it("済みにした後や取り直された後の行は消さない", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    const leased = leasedOf(await claimIdempotency(table.db, claim(), clock));
    await writeAtomically(table.db, [settleIdempotency(leased, { ok: true, item: {} }, NO_ONCE_ONLY, clock)]);
    expect((await writeAtomically(table.db, [releaseIdempotency(leased)])).ok).toBe(false);
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ state: "settled" });
  });
});
