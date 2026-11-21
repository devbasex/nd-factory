import { IDEMPOTENCY_TTL_SECONDS } from "@nd-factory/contracts/operation";
import { describe, expect, it } from "vitest";
import { createClock } from "../src/clock.ts";
import { WriteUnavailableError, writeAtomically } from "../src/conditional-write.ts";
import { claimIdempotency, IDEMPOTENCY_LEASE_MS, idempotencyKeyOf, markIdempotencyStarted, settleIdempotency, type IdempotencyClaimInput } from "../src/idempotency.ts";
import { SECRET_SAMPLES } from "./fixtures/secrets.ts";
import { fakeTable } from "./fakes/table.ts";

// DynamoDB は呼ばない。偽の表で借りと済みの行を照らす

const T0 = Date.parse("2026-11-21T00:00:00.000Z");

function clockAt(ms: number) {
  let now = ms;
  return { clock: createClock(() => now), set: (next: number) => (now = next) };
}

const claim = (over: Partial<IdempotencyClaimInput> = {}): IdempotencyClaimInput => ({
  principalKey: "usr_01890a5d-ac96-774b-bcce-b302099a8057",
  operation: "sprints.create",
  key: "4a6f1f0e-1f8b-4c7e-9a52-6b8f0f0e1f8b",
  fingerprint: "a".repeat(64),
  requestId: "req-1",
  ...over,
});

// req-1 の 1 回目の試み
const first = () => ({ id: "attempt-req-1", resumed: false });

describe("claimIdempotency", () => {
  it("1 回目は fresh で、借りの行がある", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    expect(await claimIdempotency(table.db, claim(), clock)).toMatchObject({ kind: "fresh", attempt: { resumed: false } });
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({
      state: "leased",
      owner_request_id: "req-1",
      fingerprint: "a".repeat(64),
      lease_until: new Date(T0 + IDEMPOTENCY_LEASE_MS).toISOString(),
      expire_at: Math.floor(T0 / 1000) + IDEMPOTENCY_TTL_SECONDS,
      schema_version: 1,
    });
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
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock)).toMatchObject({ kind: "fresh", attempt: { resumed: false } });
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ owner_request_id: "req-2", state: "leased" });
  });

  it("期限を過ぎた借りを 2 つが同時に取り直すと、1 つだけが fresh", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    set(T0 + IDEMPOTENCY_LEASE_MS);
    const results = await Promise.all([claimIdempotency(table.db, claim({ requestId: "req-2" }), clock), claimIdempotency(table.db, claim({ requestId: "req-3" }), clock)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["fresh", "in_progress"]);
  });

  it("期限を過ぎた借りの行は中身が違っても fresh で取り直し、前の持ち主はもう確定しない", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    set(T0 + IDEMPOTENCY_LEASE_MS);
    const fixed = claim({ requestId: "req-2", fingerprint: "b".repeat(64) });
    expect(await claimIdempotency(table.db, fixed, clock)).toMatchObject({ kind: "fresh", attempt: { resumed: false } });
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ state: "leased", owner_request_id: "req-2", fingerprint: "b".repeat(64) });
    expect((await writeAtomically(table.db, [settleIdempotency(claim(), { ok: true }, NO_ONCE_ONLY, clock)])).ok).toBe(false);
  });

  it("外へ働きかけ始めた借りは、期限を過ぎても中身が違えば reused で、元の中身との対応を残す", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    expect((await writeAtomically(table.db, [markIdempotencyStarted(claim(), first(), clock)])).ok).toBe(true);
    set(T0 + IDEMPOTENCY_LEASE_MS);
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2", fingerprint: "b".repeat(64) }), clock)).toEqual({ kind: "reused" });
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ owner_request_id: "req-1", fingerprint: "a".repeat(64), started_at: new Date(T0).toISOString() });
  });

  it("外へ働きかけ始めた借りは、期限の後に同じ中身なら fresh で取り直し、印を残して再開する", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    await writeAtomically(table.db, [markIdempotencyStarted(claim(), first(), clock)]);
    set(T0 + IDEMPOTENCY_LEASE_MS);
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock)).toEqual({ kind: "fresh", attempt: { id: "attempt-req-1", resumed: true } });
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ owner_request_id: "req-2", started_at: new Date(T0).toISOString(), attempt_id: "attempt-req-1" });
    set(T0 + 2 * IDEMPOTENCY_LEASE_MS);
    expect(await claimIdempotency(table.db, claim({ requestId: "req-3", fingerprint: "b".repeat(64) }), clock)).toEqual({ kind: "reused" });
  });

  it("中身を差し替える取り直しは、読んだ後に前の持ち主が働きかけ始めた印を付けたら外れる", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    set(T0 + IDEMPOTENCY_LEASE_MS);
    // 取り直しの読みの直後に前の持ち主が印を付ける
    const get = table.db.get.bind(table.db);
    const racing = {
      ...table.db,
      get: async (...args: Parameters<typeof table.db.get>) => {
        const row = await get(...args);
        await writeAtomically(table.db, [markIdempotencyStarted(claim(), first(), clock)]);
        return row;
      },
    };
    expect(await claimIdempotency(racing, claim({ requestId: "req-2", fingerprint: "b".repeat(64) }), clock)).toEqual({ kind: "in_progress" });
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ owner_request_id: "req-1", fingerprint: "a".repeat(64) });
  });

  it("送信を受理した直後に落ちた鍵の再開は、初めての試みと分けて前の試みの識別子を渡し、印は再開の識別子でだけ照らし直せる", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    const claimed = await claimIdempotency(table.db, claim(), clock);
    if (claimed.kind !== "fresh") throw new Error("fresh でない");
    expect(claimed.attempt.resumed).toBe(false);
    expect(claimed.attempt.id).toMatch(/^[0-9a-f]{64}$/);
    expect((await writeAtomically(table.db, [markIdempotencyStarted(claim(), claimed.attempt, clock)])).ok).toBe(true);
    // 済みの行を書けずに借りの期限が過ぎる
    set(T0 + IDEMPOTENCY_LEASE_MS);
    const resumed = await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock);
    expect(resumed).toEqual({ kind: "fresh", attempt: { id: claimed.attempt.id, resumed: true } });
    if (resumed.kind !== "fresh") throw new Error("fresh でない");
    // 初めての試みとしての印は外れ、再開の識別子でだけ照らし直せる。印の時刻は書き換えない
    expect((await writeAtomically(table.db, [markIdempotencyStarted(claim({ requestId: "req-2" }), { id: "other", resumed: false }, clock)])).ok).toBe(false);
    expect((await writeAtomically(table.db, [markIdempotencyStarted(claim({ requestId: "req-2" }), { id: "other", resumed: true }, clock)])).ok).toBe(false);
    expect((await writeAtomically(table.db, [markIdempotencyStarted(claim({ requestId: "req-2" }), resumed.attempt, clock)])).ok).toBe(true);
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ started_at: new Date(T0).toISOString(), attempt_id: claimed.attempt.id });
  });

  it("同じ中身の取り直しは、読んだ後に前の持ち主が印を付けたら外れる（再開かどうかを読んだ値で決める）", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    set(T0 + IDEMPOTENCY_LEASE_MS);
    const get = table.db.get.bind(table.db);
    const racing = {
      ...table.db,
      get: async (...args: Parameters<typeof table.db.get>) => {
        const row = await get(...args);
        await writeAtomically(table.db, [markIdempotencyStarted(claim(), first(), clock)]);
        return row;
      },
    };
    expect(await claimIdempotency(racing, claim({ requestId: "req-2" }), clock)).toEqual({ kind: "in_progress" });
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ owner_request_id: "req-1" });
  });

  it("印を付けられるのは借りの持ち主だけ", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    expect((await writeAtomically(table.db, [markIdempotencyStarted(claim({ requestId: "req-2" }), first(), clock)])).ok).toBe(false);
  });

  it("済みの行で中身が違えば、借りの期限を過ぎても reused", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    await writeAtomically(table.db, [settleIdempotency(claim(), { ok: true }, NO_ONCE_ONLY, clock)]);
    set(T0 + IDEMPOTENCY_LEASE_MS);
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2", fingerprint: "b".repeat(64) }), clock)).toEqual({ kind: "reused" });
  });

  it("済みの行で中身が同じなら replay で前の要素の結果を返す", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    const result = { ok: true, item: { sprint_id: "spr_01890a5d-ac96-774b-bcce-b302099a8057" } };
    expect(await writeAtomically(table.db, [settleIdempotency(claim(), result, NO_ONCE_ONLY, clock)])).toEqual({ ok: true });
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock)).toEqual({ kind: "replay", result });
  });

  it("24 時間を過ぎた済みの行は、表の消しの前でも fresh として取り直す", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    await writeAtomically(table.db, [settleIdempotency(claim(), { ok: true, item: {} }, NO_ONCE_ONLY, clock)]);
    set(T0 + IDEMPOTENCY_TTL_SECONDS * 1000);
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2", fingerprint: "b".repeat(64) }), clock)).toMatchObject({ kind: "fresh", attempt: { resumed: false } });
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
  it("済みの行と要素の結果を書く 1 件を返す", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    const item = settleIdempotency(claim(), { ok: false, status: 409, reason: "state_mismatch" }, ISSUES_TOKEN, clock);
    expect(item).toMatchObject({ table: "idempotency", op: "update", key: idempotencyKeyOf(claim()) });
    await writeAtomically(table.db, [item]);
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ state: "settled", result: { ok: false, status: 409, reason: "state_mismatch" }, schema_version: 1 });
  });

  it("操作が定めた 1 回だけ返す値の場所だけを null に替え、ほかの値は控える", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    await claimIdempotency(table.db, claim({ operation: "delegations.create" }), clock);
    const token = SECRET_SAMPLES["delegation_token"];
    const result = { ok: true, item: { delegation_id: "dlg_01890a5d-ac96-774b-bcce-b302099a8057", token, token_expires_at: "2026-11-22T03:04:05.678Z", note: { secret: "x" } } };
    await writeAtomically(table.db, [settleIdempotency(claim({ operation: "delegations.create" }), result, ISSUES_TOKEN, clock)]);
    const stored = table.row("idempotency", idempotencyKeyOf(claim({ operation: "delegations.create" })));
    // 名前に token を含む token_expires_at や、名前に secret を含む項目は 1 回だけ返す値でないため値のまま
    expect(stored?.["result"]).toEqual({ ok: true, item: { delegation_id: "dlg_01890a5d-ac96-774b-bcce-b302099a8057", token: null, token_expires_at: "2026-11-22T03:04:05.678Z", note: { secret: "x" } } });
    // 元の結果は変えない（呼び手へは 1 回目だけ値を返す）
    expect(result.item.token).toBe(token);
  });

  it("一覧の結果は要素ごとに同じ場所を替える", () => {
    const item = settleIdempotency(claim(), { ok: true, items: [{ token: "a", id: 1 }, { token: "b", id: 2 }] }, { onceOnly: ["items.token"] }, clockAt(T0).clock);
    expect(item.update).toContainEqual({ kind: "set", path: "result", value: { ok: true, items: [{ token: null, id: 1 }, { token: null, id: 2 }] } });
  });

  it("持ち主が違うと条件で外れる", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    const outcome = await writeAtomically(table.db, [settleIdempotency(claim({ requestId: "req-other" }), { ok: true, item: {} }, NO_ONCE_ONLY, clock)]);
    expect(outcome.ok).toBe(false);
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ state: "leased" });
  });
});
