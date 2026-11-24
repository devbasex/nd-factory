import { RETRY_POLICIES } from "@nd-factory/contracts/data";
import type { Stored } from "@nd-factory/contracts/row-codec";
import { usageMonthCodec } from "@nd-factory/contracts/rows/teams";
import { describe, expect, it } from "vitest";
import {
  AuditAppendOnlyError,
  cond,
  expressionsOf,
  deleteIfVersion,
  putIfAbsent,
  replaceIfUnchanged,
  replaceIfVersion,
  rowToCreate,
  TRANSACT_MAX_ITEMS,
  WriteSpecError,
  WriteUnavailableError,
  writeAtomically,
  type TransactItem,
} from "../src/conditional-write.ts";
import { createLogger } from "../src/log.ts";
import { fakeTable } from "./fakes/table.ts";

// DynamoDB は呼ばない。条件と更新は偽の表で当て、式の文字列は expressionsOf の出力で照らす

const TEAM = "team_01890a5d-ac96-774b-bcce-b302099a8057";

function logs() {
  const lines: string[] = [];
  return { records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>), log: createLogger({ request_id: "req-1", fn: "api", endpoint: "user" }, (l) => lines.push(l)) };
}

const teamRow = (version = 1) => ({ pk: `TEAM#${TEAM}`, sk: "TEAM", schema_version: 1, version, team_id: TEAM, name: "acme" });

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 読んだ行に保存してあった値（readRow の stored の形）
const value = (v: unknown): Stored => ({ kind: "value", value: v });
const ABSENT: Stored = { kind: "absent" };
const INCARNATION = "3f2b6c1e-8a4d-4f7b-9c2e-1d5a7b9e0f13";
const OTHER_INCARNATION = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const teamKey = { pk: `TEAM#${TEAM}`, sk: "TEAM" };
// rowReplaceOf の戻り値の形（version と incarnation を持たない）
const replacement = (name = "acme-2") => ({ pk: `TEAM#${TEAM}`, sk: "TEAM", schema_version: 1, team_id: TEAM, name });

describe("putIfAbsent", () => {
  it("条件 attribute_not_exists(pk) と扱いを持つ 1 件を組む", () => {
    const item = putIfAbsent({ table: "teams", item: teamRow(), onConflict: "return_existing" });
    expect(item).toMatchObject({ table: "teams", op: "put", key: { pk: `TEAM#${TEAM}`, sk: "TEAM" }, onConflict: "return_existing" });
    expect(expressionsOf(item.condition)).toEqual({ ConditionExpression: "attribute_not_exists(#n0)", ExpressionAttributeNames: { "#n0": "pk" } });
  });

  it("区切りの鍵だけの行は sk を null にする", () => {
    expect(putIfAbsent({ table: "idempotency", item: { pk: "usr_x#op#k", schema_version: 1 }, onConflict: "fail" }).key).toEqual({ pk: "usr_x#op#k", sk: null });
  });

  it("schema_version の無い行を型で弾く", () => {
    // @ts-expect-error schema_version が無い
    expect(() => putIfAbsent({ table: "teams", item: { pk: "TEAM#x", sk: "TEAM" }, onConflict: "fail" })).toThrow(WriteSpecError);
  });

  it("記録の表を除くどの行にも（version を持たない行にも）新しい incarnation（UUID v4）を足し、戻り値の item に載せる", () => {
    const versioned = putIfAbsent({ table: "teams", item: teamRow(), onConflict: "fail" });
    const versionless = putIfAbsent({ table: "events", item: { pk: "PROJECT#p#LANE#l", sk: "SEQ#1", schema_version: 1 }, onConflict: "return_existing" });
    for (const item of [versioned, versionless]) expect(item.item?.["incarnation"]).toMatch(UUID_V4);
    expect(versioned.item).toMatchObject({ ...teamRow(), incarnation: expect.any(String) });
    expect(versionless.item).not.toHaveProperty("version");
  });

  it("2 回組むと incarnation が違い、渡した行の incarnation（仮の値）は新しい値で置き換える", () => {
    const first = putIfAbsent({ table: "teams", item: { ...teamRow(), incarnation: INCARNATION }, onConflict: "fail" });
    const second = putIfAbsent({ table: "teams", item: { ...teamRow(), incarnation: INCARNATION }, onConflict: "fail" });
    expect(first.item?.["incarnation"]).not.toBe(INCARNATION);
    expect(first.item?.["incarnation"]).not.toBe(second.item?.["incarnation"]);
  });

  it("記録の表の行には incarnation を足さない", () => {
    const item = putIfAbsent({ table: "audit", item: { pk: "AUDIT#1", sk: "AUDIT", schema_version: 1 }, onConflict: "fail" });
    expect(item.item).toEqual({ pk: "AUDIT#1", sk: "AUDIT", schema_version: 1 });
  });

  it("偽の表に書いた行が、戻り値の item の incarnation を持つ", async () => {
    const table = fakeTable();
    const item = putIfAbsent({ table: "teams", item: teamRow(), onConflict: "fail" });
    expect(await writeAtomically(table.db, [item])).toEqual({ ok: true });
    expect(table.row("teams", teamKey)).toEqual(item.item);
  });
});

describe("rowToCreate", () => {
  it("行の版の書き手の行に仮の incarnation を入れ、putIfAbsent が新しい値で置き換える", () => {
    const month = { team_id: TEAM, month: "2026-11", used_amount_minor: 0, used_currency: "USD", version: 1 } as const;
    const row = rowToCreate(usageMonthCodec, month);
    expect(row).toMatchObject({ ...month, pk: `TEAM#${TEAM}`, sk: "USAGE#2026-11", schema_version: 1 });
    const item = putIfAbsent({ table: "teams", item: row, onConflict: "rebuild" });
    expect(item.item?.["incarnation"]).toMatch(UUID_V4);
    expect(item.item?.["incarnation"]).not.toBe(row["incarnation"]);
  });

  it("行の版の形を通らない行は投げる（書き手の誤り）", () => {
    expect(() => rowToCreate(usageMonthCodec, { team_id: TEAM, month: "2026-13", used_amount_minor: 0, used_currency: "USD", version: 1 })).toThrow();
  });
});

describe("replaceIfVersion", () => {
  it("op put で、行が item と version + 1 と読み手の見る incarnation、条件が attribute_exists(pk) と保存してあった version と incarnation の一致", () => {
    const item = replaceIfVersion({ table: "teams", item: replacement(), version: 3, incarnation: INCARNATION, expect: { version: value(3), incarnation: value(INCARNATION) }, onConflict: "version_mismatch" });
    expect(item).toMatchObject({ table: "teams", op: "put", key: teamKey, onConflict: "version_mismatch" });
    expect(item.item).toEqual({ ...replacement(), version: 4, incarnation: INCARNATION });
    expect(item.update).toBeUndefined();
    expect(expressionsOf(item.condition)).toEqual({
      ConditionExpression: "(attribute_exists(#n0) AND #n1 = :v0 AND #n2 = :v1)",
      ExpressionAttributeNames: { "#n0": "pk", "#n1": "version", "#n2": "incarnation" },
      ExpressionAttributeValues: { ":v0": 3, ":v1": INCARNATION },
    });
  });

  it("expect の列が absent なら attribute_not_exists にし、attribute_exists(pk) は expect によらず入れる", () => {
    const item = replaceIfVersion({ table: "teams", item: replacement(), version: 1, incarnation: INCARNATION, expect: { version: ABSENT, incarnation: ABSENT }, onConflict: "version_mismatch" });
    expect(expressionsOf(item.condition).ConditionExpression).toBe("(attribute_exists(#n0) AND attribute_not_exists(#n1) AND attribute_not_exists(#n2))");
    expect(item.item).toMatchObject({ version: 2, incarnation: INCARNATION });
  });

  it("version が 1 で extra があると extra も条件にする", () => {
    const item = replaceIfVersion({
      table: "decisions",
      item: { pk: "PROJECT#p", sk: "APPROVAL#a", schema_version: 1, state: "answered" },
      version: 1,
      incarnation: INCARNATION,
      expect: { version: value(1), incarnation: value(INCARNATION) },
      extra: cond.eq("state", "waiting"),
      onConflict: "state_mismatch",
    });
    expect(expressionsOf(item.condition).ConditionExpression).toBe("(attribute_exists(#n0) AND #n1 = :v0 AND #n2 = :v1 AND #n3 = :v2)");
    expect(item.item).toMatchObject({ version: 2 });
  });

  it("item が version か incarnation を持つと投げる", () => {
    for (const extra of [{ version: 3 }, { incarnation: INCARNATION }]) {
      expect(() => replaceIfVersion({ table: "teams", item: { ...replacement(), ...extra }, version: 3, incarnation: INCARNATION, expect: { version: value(3), incarnation: value(INCARNATION) }, onConflict: "version_mismatch" })).toThrow(WriteSpecError);
    }
  });

  it("version が 1 以上の整数でない・incarnation が空・schema_version が 1 以上の整数でないと投げる", () => {
    const base = { table: "teams", item: replacement(), version: 1, incarnation: INCARNATION, expect: { version: value(1), incarnation: value(INCARNATION) }, onConflict: "version_mismatch" } as const;
    for (const version of [0, 1.5, -1]) expect(() => replaceIfVersion({ ...base, version })).toThrow(WriteSpecError);
    expect(() => replaceIfVersion({ ...base, incarnation: "" })).toThrow(WriteSpecError);
    expect(() => replaceIfVersion({ ...base, item: { ...replacement(), schema_version: 0 } })).toThrow(WriteSpecError);
  });

  it("記録の表を指すと投げる", () => {
    expect(() =>
      replaceIfVersion({ table: "audit", item: { pk: "AUDIT#1", sk: "AUDIT", schema_version: 1 }, version: 1, incarnation: INCARNATION, expect: { version: ABSENT, incarnation: ABSENT }, onConflict: "fail" }),
    ).toThrow(AuditAppendOnlyError);
  });

  it("偽の表で、読んだ版と世代のときだけ置き換わって版が 1 上がり、item に無い列は消える", async () => {
    const table = fakeTable();
    table.seed("teams", { ...teamRow(1), incarnation: INCARNATION, old_column: "x" });
    const write = (name: string) =>
      replaceIfVersion({ table: "teams", item: replacement(name), version: 1, incarnation: INCARNATION, expect: { version: value(1), incarnation: value(INCARNATION) }, onConflict: "version_mismatch" });
    expect(await writeAtomically(table.db, [write("acme-2")])).toEqual({ ok: true });
    expect(table.row("teams", teamKey)).toEqual({ ...replacement("acme-2"), version: 2, incarnation: INCARNATION });
    // 古い版で書くと外れ、何も変わらない
    expect(await writeAtomically(table.db, [write("stale")])).toEqual({ ok: false, failed: [{ index: 0, onConflict: "version_mismatch" }] });
    expect(table.row("teams", teamKey)).toMatchObject({ name: "acme-2", version: 2 });
  });

  it("repair が incarnation を補った行（保存の行に列が無い）は書け、incarnation を保存する。同じ鍵で作り直した行は外れる", async () => {
    const table = fakeTable();
    table.seed("teams", teamRow(1));
    const write = replaceIfVersion({ table: "teams", item: replacement(), version: 1, incarnation: INCARNATION, expect: { version: value(1), incarnation: ABSENT }, onConflict: "version_mismatch" });
    expect(await writeAtomically(table.db, [write])).toEqual({ ok: true });
    expect(table.row("teams", teamKey)).toMatchObject({ version: 2, incarnation: INCARNATION });

    // 消して同じ鍵で作り直した行（putIfAbsent が入れた incarnation を持つ）は、前の行を読んだ書き手から書き換わらない
    const recreated = fakeTable();
    recreated.seed("teams", { ...teamRow(1), incarnation: OTHER_INCARNATION });
    expect((await writeAtomically(recreated.db, [write])).ok).toBe(false);
    const stale = replaceIfVersion({ table: "teams", item: replacement(), version: 1, incarnation: INCARNATION, expect: { version: value(1), incarnation: value(INCARNATION) }, onConflict: "version_mismatch" });
    expect((await writeAtomically(recreated.db, [stale])).ok).toBe(false);
    expect(recreated.row("teams", teamKey)).toMatchObject({ name: "acme", incarnation: OTHER_INCARNATION });
  });

  it("repair が形を外れた version（文字列・0）を直した行は、保存してあった値を条件にし、読み手の見る形の値から 1 上げて書く", async () => {
    for (const [stored, seen] of [["3", 3], [0, 1]] as const) {
      const table = fakeTable();
      table.seed("teams", { ...teamRow(1), version: stored, incarnation: INCARNATION });
      const write = replaceIfVersion({ table: "teams", item: replacement(), version: seen, incarnation: INCARNATION, expect: { version: value(stored), incarnation: value(INCARNATION) }, onConflict: "version_mismatch" });
      expect(expressionsOf(write.condition).ExpressionAttributeValues).toEqual({ ":v0": stored, ":v1": INCARNATION });
      expect(await writeAtomically(table.db, [write])).toEqual({ ok: true });
      expect(table.row("teams", teamKey)).toEqual({ ...replacement(), version: seen + 1, incarnation: INCARNATION });
    }
  });

  it("version と incarnation の両方を補った行を読んだ後に消えると外れ、行を作らない", async () => {
    const table = fakeTable();
    const outcome = await writeAtomically(table.db, [
      replaceIfVersion({ table: "teams", item: replacement(), version: 1, incarnation: INCARNATION, expect: { version: ABSENT, incarnation: ABSENT }, onConflict: "version_mismatch" }),
    ]);
    expect(outcome.ok).toBe(false);
    expect(table.rows("teams")).toEqual([]);
  });
});

describe("deleteIfVersion", () => {
  it("op delete で、条件が attribute_exists(pk) と保存してあった version と incarnation の一致", () => {
    const item = deleteIfVersion({ table: "users", key: { pk: "USER#u", sk: "LOGIN#google#s" }, expect: { version: value(2), incarnation: value(INCARNATION) }, onConflict: "version_mismatch" });
    expect(item).toMatchObject({ table: "users", op: "delete", key: { pk: "USER#u", sk: "LOGIN#google#s" }, onConflict: "version_mismatch" });
    expect(item.item).toBeUndefined();
    expect(expressionsOf(item.condition)).toEqual({
      ConditionExpression: "(attribute_exists(#n0) AND #n1 = :v0 AND #n2 = :v1)",
      ExpressionAttributeNames: { "#n0": "pk", "#n1": "version", "#n2": "incarnation" },
      ExpressionAttributeValues: { ":v0": 2, ":v1": INCARNATION },
    });
  });

  it("extra があると extra も条件にする", () => {
    const item = deleteIfVersion({ table: "users", key: { pk: "USER#u", sk: "LOGIN#google#s" }, expect: { version: value(1), incarnation: ABSENT }, extra: cond.eq("state", "open"), onConflict: "state_mismatch" });
    expect(expressionsOf(item.condition).ConditionExpression).toBe("(attribute_exists(#n0) AND #n1 = :v0 AND attribute_not_exists(#n2) AND #n3 = :v1)");
  });

  it("expect の値が undefined だと投げる（列が無ければ absent）", () => {
    for (const expectation of [{ version: value(undefined), incarnation: ABSENT }, { version: value(1), incarnation: value(undefined) }]) {
      expect(() => deleteIfVersion({ table: "users", key: { pk: "USER#u", sk: "USER" }, expect: expectation, onConflict: "fail" })).toThrow(WriteSpecError);
    }
  });

  it("repair が形を外れた version と incarnation を直した行は、保存してあった値（文字列・0・空の文字列）をそのまま条件にして消せる", async () => {
    const key = { pk: "USER#u", sk: "LOGIN#google#s" };
    for (const [version, incarnation] of [["3", INCARNATION], [0, ""]] as const) {
      const table = fakeTable();
      table.seed("users", { ...key, schema_version: 1, version, incarnation, user_id: "u" });
      const del = deleteIfVersion({ table: "users", key, expect: { version: value(version), incarnation: value(incarnation) }, onConflict: "fail" });
      expect(expressionsOf(del.condition).ExpressionAttributeValues).toEqual({ ":v0": version, ":v1": incarnation });
      expect(await writeAtomically(table.db, [del])).toEqual({ ok: true });
      expect(table.row("users", key)).toBeUndefined();
    }
  });

  it("記録の表を指すと投げる", () => {
    expect(() => deleteIfVersion({ table: "audit", key: { pk: "AUDIT#1", sk: "AUDIT" }, expect: { version: ABSENT, incarnation: ABSENT }, onConflict: "fail" })).toThrow(AuditAppendOnlyError);
  });

  it("偽の表で、expect の incarnation が absent（repair が補った行）でも消せ、読んだ後に消えていた行と作り直した行では外れる", async () => {
    const key = { pk: "USER#u", sk: "LOGIN#google#s" };
    const table = fakeTable();
    table.seed("users", { ...key, schema_version: 1, user_id: "u" });
    const del = deleteIfVersion({ table: "users", key, expect: { version: ABSENT, incarnation: ABSENT }, onConflict: "fail" });
    expect(await writeAtomically(table.db, [del])).toEqual({ ok: true });
    expect(table.row("users", key)).toBeUndefined();
    // 消えていた行では外れる（既に無い行を自分が消したと取り違えない）
    expect((await writeAtomically(table.db, [del])).ok).toBe(false);
    // 作り直した行は新しい incarnation を持つため外れる
    table.seed("users", { ...key, schema_version: 1, version: 1, incarnation: OTHER_INCARNATION, user_id: "u" });
    const stale = deleteIfVersion({ table: "users", key, expect: { version: value(1), incarnation: value(INCARNATION) }, onConflict: "fail" });
    expect((await writeAtomically(table.db, [stale])).ok).toBe(false);
    expect(table.row("users", key)).toBeDefined();
  });
});

describe("replaceIfUnchanged（表の移しだけが使う）", () => {
  const key = { pk: "USER#u", sk: "LOGIN#google#s" };
  const item = { pk: key.pk, sk: key.sk, schema_version: 2, version: 3, incarnation: INCARNATION, idp: "google" };
  const expect3 = { schema_version: value(1), version: value(3), incarnation: value(INCARNATION) };

  it("op は put で、行は item のまま（version を上げない）、条件は attribute_exists(pk) と 3 つの列の保存の値の一致", () => {
    const out = replaceIfUnchanged({ table: "users", item, expect: expect3, onConflict: "fail" });
    expect(out.op).toBe("put");
    expect(out.key).toEqual(key);
    expect(out.item).toEqual(item);
    const ex = expressionsOf(out.condition);
    expect(ex.ConditionExpression).toBe("(attribute_exists(#n0) AND #n1 = :v0 AND #n2 = :v1 AND #n3 = :v2)");
    expect(ex.ExpressionAttributeNames).toEqual({ "#n0": "pk", "#n1": "schema_version", "#n2": "version", "#n3": "incarnation" });
    expect(ex.ExpressionAttributeValues).toEqual({ ":v0": 1, ":v1": 3, ":v2": INCARNATION });
  });

  it("expect の absent は attribute_not_exists にする", () => {
    const out = replaceIfUnchanged({ table: "users", item, expect: { schema_version: value(1), version: ABSENT, incarnation: ABSENT }, onConflict: "fail" });
    expect(expressionsOf(out.condition).ConditionExpression).toBe("(attribute_exists(#n0) AND #n1 = :v0 AND attribute_not_exists(#n2) AND attribute_not_exists(#n3))");
  });

  it("保存の version が文字列 \"1\" の行を、条件はその文字列で、書く行は直した数の 1 で組む", async () => {
    const table = fakeTable();
    table.seed("users", { pk: key.pk, sk: key.sk, schema_version: 1, version: "1", incarnation: INCARNATION, idp: "google" });
    const fixed = { ...item, version: 1 };
    const out = replaceIfUnchanged({ table: "users", item: fixed, expect: { schema_version: value(1), version: value("1"), incarnation: value(INCARNATION) }, onConflict: "fail" });
    expect(expressionsOf(out.condition).ExpressionAttributeValues).toMatchObject({ ":v1": "1" });
    expect((await writeAtomically(table.db, [out])).ok).toBe(true);
    expect(table.row("users", key)).toEqual(fixed);
  });

  it("保存の値が変わった行（書き手が先に確定した・消して作り直した）と消えた行では外れ、行を作り直さない", async () => {
    const table = fakeTable();
    table.seed("users", { pk: key.pk, sk: key.sk, schema_version: 1, version: 4, incarnation: INCARNATION, idp: "google" });
    expect((await writeAtomically(table.db, [replaceIfUnchanged({ table: "users", item, expect: expect3, onConflict: "fail" })])).ok).toBe(false);
    table.seed("users", { pk: key.pk, sk: key.sk, schema_version: 1, version: 3, incarnation: OTHER_INCARNATION, idp: "google" });
    expect((await writeAtomically(table.db, [replaceIfUnchanged({ table: "users", item, expect: expect3, onConflict: "fail" })])).ok).toBe(false);
    table.remove("users", key);
    expect((await writeAtomically(table.db, [replaceIfUnchanged({ table: "users", item, expect: { schema_version: value(1), version: ABSENT, incarnation: ABSENT }, onConflict: "fail" })])).ok).toBe(false);
    expect(table.rows("users")).toEqual([]);
  });

  it("記録の表を指すと投げる。pk・schema_version の無い行と、value が undefined の expect で投げる", () => {
    expect(() => replaceIfUnchanged({ table: "audit", item: { pk: "AUDIT#a", sk: "AUDIT", schema_version: 1 }, expect: { schema_version: value(1), version: ABSENT, incarnation: ABSENT }, onConflict: "fail" })).toThrow(AuditAppendOnlyError);
    expect(() => replaceIfUnchanged({ table: "users", item: { ...item, schema_version: 0 }, expect: expect3, onConflict: "fail" })).toThrow(WriteSpecError);
    expect(() => replaceIfUnchanged({ table: "users", item, expect: { ...expect3, schema_version: { kind: "value", value: undefined } }, onConflict: "fail" })).toThrow(WriteSpecError);
  });
});

describe("writeAtomically", () => {
  const put = (n: number): TransactItem => putIfAbsent({ table: "events", item: { pk: "PROJECT#p#LANE#l", sk: `SEQ#${String(n).padStart(4, "0")}`, schema_version: 1 }, onConflict: "return_existing" });

  it("全件が書かれ ok を返す（1 件と 100 件）", async () => {
    for (const count of [1, TRANSACT_MAX_ITEMS]) {
      const table = fakeTable();
      const items = Array.from({ length: count }, (_, i) => put(i));
      expect(await writeAtomically(table.db, items)).toEqual({ ok: true });
      expect(table.rows("events")).toHaveLength(count);
    }
  });

  it("条件の外れは件の番号と扱いを返し、どれも書かない", async () => {
    const table = fakeTable();
    table.seed("events", { pk: "PROJECT#p#LANE#l", sk: "SEQ#0001", schema_version: 1 });
    const outcome = await writeAtomically(table.db, [put(0), put(1), put(2)]);
    expect(outcome).toEqual({ ok: false, failed: [{ index: 1, onConflict: "return_existing" }] });
    expect(table.rows("events")).toHaveLength(1);
  });

  it("rebuild の件の外れは扱いを訳さずに件の番号と一緒に返し、自分では組み直さない", async () => {
    const table = fakeTable();
    table.seed("teams", { ...teamRow(2), incarnation: INCARNATION });
    const stale = replaceIfVersion({ table: "teams", item: replacement(), version: 1, incarnation: INCARNATION, expect: { version: value(1), incarnation: value(INCARNATION) }, onConflict: "rebuild" });
    expect(await writeAtomically(table.db, [put(0), stale])).toEqual({ ok: false, failed: [{ index: 1, onConflict: "rebuild" }] });
    expect(table.transactions).toHaveLength(1);
    expect(table.rows("events")).toEqual([]);
  });

  it("トランザクションの衝突は方針の回数まで繰り返し、warn を出す", async () => {
    const table = fakeTable();
    const { log, records } = logs();
    table.failNext("conflict", "conflict");
    expect(await writeAtomically(table.db, [put(0)], log)).toEqual({ ok: true });
    expect(table.transactions).toHaveLength(RETRY_POLICIES["dynamodb-transaction"].retries + 1);
    const warns = records().filter((r) => r["level"] === "warn");
    expect(warns).toHaveLength(2);
    expect(warns[0]).toMatchObject({ policy: "dynamodb-transaction", attempt: 1, tables: ["events"], count: 1 });
  });

  it.each(["ThrottlingError", "ProvisionedThroughputExceeded", "RequestLimitExceeded"])("取り消しの理由 %s は方針の回数まで繰り返して確定する", async (code) => {
    const table = fakeTable();
    const { log, records } = logs();
    let calls = 0;
    const thrown = Object.assign(new Error("throttled"), { name: "TransactionCanceledException", $metadata: { httpStatusCode: 400 }, CancellationReasons: [{ Code: code }] });
    const db = {
      transactWrite: async (items: readonly TransactItem[]) => {
        calls += 1;
        if (calls <= RETRY_POLICIES["dynamodb-transaction"].retries) throw thrown;
        await table.db.transactWrite(items);
      },
    } as unknown as Parameters<typeof writeAtomically>[0];
    expect(await writeAtomically(db, [put(0)], log)).toEqual({ ok: true });
    expect(calls).toBe(RETRY_POLICIES["dynamodb-transaction"].retries + 1);
    expect(table.rows("events")).toHaveLength(1);
    expect(records().filter((r) => r["level"] === "warn")).toHaveLength(RETRY_POLICIES["dynamodb-transaction"].retries);
  });

  it("呼びすぎの取り消しを使い切ると WriteUnavailableError を投げ、何も書かない", async () => {
    const table = fakeTable();
    table.failNext("throttled", "throttled", "throttled");
    await expect(writeAtomically(table.db, [put(0), put(1)])).rejects.toBeInstanceOf(WriteUnavailableError);
    expect(table.transactions).toHaveLength(RETRY_POLICIES["dynamodb-transaction"].retries + 1);
    expect(table.rows("events")).toEqual([]);
  });

  it("衝突を使い切ると WriteUnavailableError を投げ、何も書かない", async () => {
    const table = fakeTable();
    table.failNext("conflict", "conflict", "conflict");
    await expect(writeAtomically(table.db, [put(0)])).rejects.toBeInstanceOf(WriteUnavailableError);
    expect(table.transactions).toHaveLength(3);
    expect(table.rows("events")).toEqual([]);
  });

  it("表に届かない失敗は繰り返さずに WriteUnavailableError を投げる（SDK の再試行の後）", async () => {
    const table = fakeTable();
    const { log, records } = logs();
    table.failNext("unavailable");
    const error = await writeAtomically(table.db, [put(0)], log).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteUnavailableError);
    expect((error as WriteUnavailableError).includesAudit).toBe(false);
    expect(table.transactions).toHaveLength(1);
    expect(records().at(-1)).toMatchObject({ level: "error", msg: "書き込みが表に届かない", result: "unavailable", class: "retryable", error: "InternalServerError" });
  });

  it("表が断った失敗（ValidationException）は WriteUnavailableError に包まず、元の例外のまま投げる", async () => {
    const table = fakeTable();
    const { log, records } = logs();
    table.failNext("invalid");
    const error = await writeAtomically(table.db, [put(0)], log).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(WriteUnavailableError);
    expect(error).toMatchObject({ name: "ValidationException" });
    expect(table.transactions).toHaveLength(1);
    expect(records().at(-1)).toMatchObject({ level: "error", msg: "書き込みを表が断った", result: "rejected", class: "rejected", error: "ValidationException" });
  });

  it.each([
    ["要求の形を断った例外", Object.assign(new Error("bad"), { name: "SerializationException", $metadata: { httpStatusCode: 400 } })],
    ["取り消しの理由が行の形の誤り", Object.assign(new Error("bad"), { name: "TransactionCanceledException", $metadata: { httpStatusCode: 400 }, CancellationReasons: [{ Code: "None" }, { Code: "ValidationError" }] })],
    ["取り消しの理由に行の形の誤りと書き込みの呼びすぎが並ぶ", Object.assign(new Error("bad"), { name: "TransactionCanceledException", $metadata: { httpStatusCode: 400 }, CancellationReasons: [{ Code: "ValidationError" }, { Code: "ThrottlingError" }] })],
  ])("%s は記録の行を含んでも WriteUnavailableError に包まず、繰り返さずに元の例外のまま投げる", async (_why, thrown) => {
    const { log, records } = logs();
    let calls = 0;
    const db = {
      transactWrite: async () => {
        calls += 1;
        return Promise.reject(thrown);
      },
    } as unknown as Parameters<typeof writeAtomically>[0];
    const audit = putIfAbsent({ table: "audit", item: { pk: "AUDIT#1", sk: "AUDIT", schema_version: 1 }, onConflict: "fail" });
    const error = await writeAtomically(db, [audit], log).catch((e: unknown) => e);
    expect(error).toBe(thrown);
    expect(calls).toBe(1);
    expect(records().at(-1)).toMatchObject({ level: "error", msg: "書き込みを表が断った", result: "rejected", class: "rejected" });
  });

  it.each(["ValidationError", "ItemCollectionSizeLimitExceeded"])(
    "条件の外れと断った理由 %s が別の件に並ぶ取り消しは、条件の外れとして返さず、繰り返さずに元の例外のまま投げる",
    async (code) => {
      const { log, records } = logs();
      // 件ごとに理由を対応させる: 0 番の版の比べが外れ、1 番の新しい行を表が断った
      const thrown = Object.assign(new Error("canceled"), {
        name: "TransactionCanceledException",
        $metadata: { httpStatusCode: 400 },
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: code }],
      });
      let calls = 0;
      const db = {
        transactWrite: async () => {
          calls += 1;
          return Promise.reject(thrown);
        },
      } as unknown as Parameters<typeof writeAtomically>[0];
      const items = [
        replaceIfVersion({ table: "teams", item: { pk: "TEAM#t", sk: "TEAM", schema_version: 1, name: "x" }, version: 1, incarnation: INCARNATION, expect: { version: value(1), incarnation: value(INCARNATION) }, onConflict: "version_mismatch" }),
        putIfAbsent({ table: "events", item: { pk: "EVENT#1", sk: "EVENT", schema_version: 1 }, onConflict: "return_existing" }),
      ];
      const error = await writeAtomically(db, items, log).catch((e: unknown) => e);
      expect(error).toBe(thrown);
      expect(calls).toBe(1);
      expect(records().at(-1)).toMatchObject({ level: "error", msg: "書き込みを表が断った", result: "rejected", class: "rejected", error: "TransactionCanceledException" });
    },
  );

  it.each([
    ["取り消しの理由が書き込みの呼びすぎ", Object.assign(new Error("throttled"), { name: "TransactionCanceledException", $metadata: { httpStatusCode: 400 }, CancellationReasons: [{ Code: "None" }, { Code: "ThrottlingError" }] }), "retryable"],
    ["名前の分からない 5xx", Object.assign(new Error("down"), { name: "SomethingUnexpected", $metadata: { httpStatusCode: 503 } }), "retryable"],
    ["分類できない失敗", Object.assign(new Error("odd"), { name: "SomethingUnexpected", $metadata: { httpStatusCode: 400 } }), "unknown"],
  ])("%s は WriteUnavailableError に包み、記録の行を含むことを運ぶ", async (_why, thrown, cls) => {
    const { log, records } = logs();
    const db = { transactWrite: async () => Promise.reject(thrown) } as unknown as Parameters<typeof writeAtomically>[0];
    const audit = putIfAbsent({ table: "audit", item: { pk: "AUDIT#1", sk: "AUDIT", schema_version: 1 }, onConflict: "fail" });
    const error = await writeAtomically(db, [audit], log).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteUnavailableError);
    expect((error as WriteUnavailableError).includesAudit).toBe(true);
    expect((error as WriteUnavailableError).cause).toBe(thrown);
    expect(records().at(-1)).toMatchObject({ level: "error", msg: "書き込みが表に届かない", result: "unavailable", class: cls });
  });

  it("101 件と 0 件と同じ行の 2 回で止め、送らない", async () => {
    const table = fakeTable();
    await expect(writeAtomically(table.db, Array.from({ length: TRANSACT_MAX_ITEMS + 1 }, (_, i) => put(i)))).rejects.toBeInstanceOf(WriteSpecError);
    await expect(writeAtomically(table.db, [])).rejects.toBeInstanceOf(WriteSpecError);
    await expect(writeAtomically(table.db, [put(0), put(0)])).rejects.toBeInstanceOf(WriteSpecError);
    expect(table.transactions).toEqual([]);
  });
});

// 受け入れ条件 4（I9）: 記録の行の更新・削除の試みが書けない
describe("記録の表は追記だけ", () => {
  const auditKey = { pk: "PROJECT#p", sk: "2026-11-21T00:00:00.000Z#aud_x" };
  const seeded = () => {
    const table = fakeTable();
    table.seed("audit", { ...auditKey, schema_version: 1, operation: "projects.get" });
    return table;
  };

  it("記録の行の書き換えを組むと確定せず、行は変わらない", async () => {
    const table = seeded();
    const rewrite: TransactItem = { table: "audit", op: "update", key: auditKey, update: [{ kind: "set", path: "operation", value: "x" }], condition: cond.exists("pk"), onConflict: "fail" };
    await expect(writeAtomically(table.db, [rewrite])).rejects.toBeInstanceOf(AuditAppendOnlyError);
    expect(table.transactions).toEqual([]);
    expect(table.row("audit", auditKey)).toMatchObject({ operation: "projects.get" });
  });

  it("記録の行の削除と、条件なしの上書きを組むと確定しない", async () => {
    const table = seeded();
    const del: TransactItem = { table: "audit", op: "delete", key: auditKey, condition: cond.exists("pk"), onConflict: "fail" };
    const overwrite: TransactItem = { table: "audit", op: "put", key: auditKey, item: { ...auditKey, schema_version: 1, operation: "x" }, condition: cond.exists("pk"), onConflict: "fail" };
    for (const item of [del, overwrite]) await expect(writeAtomically(table.db, [item])).rejects.toBeInstanceOf(AuditAppendOnlyError);
    expect(table.transactions).toEqual([]);
    expect(table.row("audit", auditKey)).toMatchObject({ operation: "projects.get" });
  });

  it("状態の書き込みに記録の書き換えが混ざると、状態も書かない", async () => {
    const table = seeded();
    const state = putIfAbsent({ table: "teams", item: teamRow(), onConflict: "fail" });
    const del: TransactItem = { table: "audit", op: "delete", key: auditKey, condition: cond.exists("pk"), onConflict: "fail" };
    await expect(writeAtomically(table.db, [state, del])).rejects.toBeInstanceOf(AuditAppendOnlyError);
    expect(table.rows("teams")).toEqual([]);
  });

  it("Db.transactWrite は writeAtomically を通らずに呼ばれても、記録の表の書き換え・消し・上書きを送らない", async () => {
    const { createDb } = await import("../src/db.ts");
    const sent: unknown[] = [];
    const client = { send: async (command: unknown) => sent.push(command) };
    const names = Object.fromEntries(["users", "teams", "projects", "sprints", "events", "decisions", "notices", "usage", "audit", "idempotency"].map((n) => [n, `acme-dev-db-${n}`]));
    const db = createDb(client as never, names as never);
    const rewrite: TransactItem = { table: "audit", op: "update", key: auditKey, update: [{ kind: "set", path: "operation", value: "x" }], condition: cond.exists("pk"), onConflict: "fail" };
    const del: TransactItem = { table: "audit", op: "delete", key: auditKey, condition: cond.exists("pk"), onConflict: "fail" };
    const overwrite: TransactItem = { table: "audit", op: "put", key: auditKey, item: { ...auditKey, schema_version: 1, operation: "x" }, condition: cond.exists("pk"), onConflict: "fail" };
    const state = putIfAbsent({ table: "teams", item: teamRow(), onConflict: "fail" });
    for (const item of [rewrite, del, overwrite]) await expect(db.transactWrite([state, item])).rejects.toBeInstanceOf(AuditAppendOnlyError);
    expect(sent).toEqual([]);
    // 追記（無いときだけの Put）は送る
    await db.transactWrite([putIfAbsent({ table: "audit", item: { ...auditKey, schema_version: 1, operation: "x" }, onConflict: "fail" })]);
    expect(sent).toHaveLength(1);
  });

  it("Db.update は記録の表を書き換えない", async () => {
    const { createDb } = await import("../src/db.ts");
    const sent: unknown[] = [];
    const client = { send: async (command: unknown) => sent.push(command) };
    const names = Object.fromEntries(["users", "teams", "projects", "sprints", "events", "decisions", "notices", "usage", "audit", "idempotency"].map((n) => [n, `acme-dev-db-${n}`]));
    const db = createDb(client as never, names as never);
    await expect(db.update("audit", auditKey, [{ kind: "set", path: "operation", value: "x" }], cond.exists("pk"))).rejects.toBeInstanceOf(AuditAppendOnlyError);
    expect(sent).toEqual([]);
  });
});
