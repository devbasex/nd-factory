import { IDEMPOTENCY_TTL_SECONDS } from "@nd-factory/contracts/operation";
import { describe, expect, it } from "vitest";
import { createClock } from "../src/clock.ts";
import { WriteUnavailableError, writeAtomically } from "../src/conditional-write.ts";
import { claimIdempotency, IDEMPOTENCY_LEASE_MS, idempotencyKeyOf, settleIdempotency, type IdempotencyClaimInput } from "../src/idempotency.ts";
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

describe("claimIdempotency", () => {
  it("1 回目は fresh で、借りの行がある", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    expect(await claimIdempotency(table.db, claim(), clock)).toEqual({ kind: "fresh" });
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
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock)).toEqual({ kind: "fresh" });
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

  it("済みの行で中身が同じなら replay で前の要素の結果を返す", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    const result = { ok: true, item: { sprint_id: "spr_01890a5d-ac96-774b-bcce-b302099a8057" } };
    expect(await writeAtomically(table.db, [settleIdempotency(claim(), result, clock)])).toEqual({ ok: true });
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2" }), clock)).toEqual({ kind: "replay", result });
  });

  it("24 時間を過ぎた済みの行は、表の消しの前でも fresh として取り直す", async () => {
    const table = fakeTable();
    const { clock, set } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    await writeAtomically(table.db, [settleIdempotency(claim(), { ok: true, item: {} }, clock)]);
    set(T0 + IDEMPOTENCY_TTL_SECONDS * 1000);
    expect(await claimIdempotency(table.db, claim({ requestId: "req-2", fingerprint: "b".repeat(64) }), clock)).toEqual({ kind: "fresh" });
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

describe("settleIdempotency", () => {
  it("済みの行と要素の結果を書く 1 件を返す", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    const item = settleIdempotency(claim(), { ok: false, status: 409, reason: "state_mismatch" }, clock);
    expect(item).toMatchObject({ table: "idempotency", op: "update", key: idempotencyKeyOf(claim()) });
    await writeAtomically(table.db, [item]);
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ state: "settled", result: { ok: false, status: 409, reason: "state_mismatch" }, schema_version: 1 });
  });

  it("1 回だけ返す値（token など）は null に替えて控える", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    await claimIdempotency(table.db, claim({ operation: "delegations.create" }), clock);
    const token = SECRET_SAMPLES["delegation_token"];
    const result = { ok: true, item: { delegation_id: "dlg_01890a5d-ac96-774b-bcce-b302099a8057", token, note: { secret: "x" }, echoed: token } };
    await writeAtomically(table.db, [settleIdempotency(claim({ operation: "delegations.create" }), result, clock)]);
    const stored = table.row("idempotency", idempotencyKeyOf(claim({ operation: "delegations.create" })));
    expect(stored?.["result"]).toEqual({ ok: true, item: { delegation_id: "dlg_01890a5d-ac96-774b-bcce-b302099a8057", token: null, note: { secret: null }, echoed: null } });
    // 元の結果は変えない（呼び手へは 1 回目だけ値を返す）
    expect(result.item.token).toBe(token);
  });

  it("持ち主が違うと条件で外れる", async () => {
    const table = fakeTable();
    const { clock } = clockAt(T0);
    await claimIdempotency(table.db, claim(), clock);
    const outcome = await writeAtomically(table.db, [settleIdempotency(claim({ requestId: "req-other" }), { ok: true, item: {} }, clock)]);
    expect(outcome.ok).toBe(false);
    expect(table.row("idempotency", idempotencyKeyOf(claim()))).toMatchObject({ state: "leased" });
  });
});
