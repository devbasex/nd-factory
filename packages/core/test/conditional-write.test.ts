import { RETRY_POLICIES } from "@nd-factory/contracts/data";
import { describe, expect, it } from "vitest";
import {
  AuditAppendOnlyError,
  cond,
  expressionsOf,
  putIfAbsent,
  TRANSACT_MAX_ITEMS,
  updateIfSchemaVersion,
  updateIfVersion,
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
});

describe("updateIfVersion", () => {
  it("版の条件と version + 1 を持つ 1 件を組む", () => {
    const item = updateIfVersion({ table: "teams", key: { pk: `TEAM#${TEAM}`, sk: "TEAM" }, version: 3, set: { name: "acme-2" }, onConflict: "version_mismatch" });
    expect(item.op).toBe("update");
    expect(expressionsOf(item.condition, item.update)).toEqual({
      ConditionExpression: "#n0 = :v0",
      UpdateExpression: "SET #n1 = :v1, #n0 = #n0 + :v2",
      ExpressionAttributeNames: { "#n0": "version", "#n1": "name" },
      ExpressionAttributeValues: { ":v0": 3, ":v1": "acme-2", ":v2": 1 },
    });
  });

  it("version が 1 で extra があると両方を条件にする", () => {
    const item = updateIfVersion({ table: "decisions", key: { pk: "PROJECT#p", sk: "APPROVAL#a" }, version: 1, set: { state: "answered" }, extra: cond.eq("state", "waiting"), onConflict: "state_mismatch" });
    expect(expressionsOf(item.condition, item.update).ConditionExpression).toBe("(#n0 = :v0 AND #n1 = :v1)");
  });

  it("remove の列は REMOVE 句に並び、SET と同じ 1 つの更新の式に入る", () => {
    const item = updateIfVersion({ table: "projects", key: { pk: "PROJECT#p", sk: "PROJECT" }, version: 2, set: { schema_version: 2 }, remove: ["current_team_id", "current_assign_id"], onConflict: "version_mismatch" });
    expect(expressionsOf(item.condition, item.update).UpdateExpression).toBe("SET #n1 = :v1, #n0 = #n0 + :v2 REMOVE #n2, #n3");
  });

  it("remove が空か無いと REMOVE 句を持たない", () => {
    for (const remove of [[], undefined]) {
      const item = updateIfVersion({ table: "teams", key: { pk: "TEAM#t", sk: "TEAM" }, version: 1, set: { name: "x" }, ...(remove === undefined ? {} : { remove }), onConflict: "version_mismatch" });
      expect(expressionsOf(item.condition, item.update).UpdateExpression).not.toContain("REMOVE");
    }
  });

  it("set に version を含むと型で弾く", () => {
    // @ts-expect-error set に version を書けない
    expect(() => updateIfVersion({ table: "teams", key: { pk: "TEAM#t", sk: "TEAM" }, version: 1, set: { version: 9 }, onConflict: "version_mismatch" })).toThrow(WriteSpecError);
  });

  it("remove が set の鍵か pk・sk・version・schema_version を含むと投げる", () => {
    for (const remove of [["name"], ["pk"], ["sk"], ["version"], ["schema_version"]]) {
      expect(() => updateIfVersion({ table: "teams", key: { pk: "TEAM#t", sk: "TEAM" }, version: 1, set: { name: "x" }, remove, onConflict: "version_mismatch" })).toThrow(WriteSpecError);
    }
  });

  it("version が 1 以上の整数でないと投げる", () => {
    for (const version of [0, 1.5, -1]) {
      expect(() => updateIfVersion({ table: "teams", key: { pk: "TEAM#t", sk: "TEAM" }, version, set: { name: "x" }, onConflict: "version_mismatch" })).toThrow(WriteSpecError);
    }
  });

  it("偽の表で、読んだ版のときだけ書けて版が 1 上がる", async () => {
    const table = fakeTable();
    table.seed("teams", teamRow(1));
    const key = { pk: `TEAM#${TEAM}`, sk: "TEAM" };
    expect(await writeAtomically(table.db, [updateIfVersion({ table: "teams", key, version: 1, set: { name: "acme-2" }, onConflict: "version_mismatch" })])).toEqual({ ok: true });
    expect(table.row("teams", key)).toMatchObject({ name: "acme-2", version: 2 });
    // 古い版で書くと外れ、何も変わらない
    expect(await writeAtomically(table.db, [updateIfVersion({ table: "teams", key, version: 1, set: { name: "stale" }, onConflict: "version_mismatch" })])).toEqual({
      ok: false,
      failed: [{ index: 0, onConflict: "version_mismatch" }],
    });
    expect(table.row("teams", key)).toMatchObject({ name: "acme-2", version: 2 });
  });
});

describe("updateIfSchemaVersion", () => {
  const key = { pk: "USER#u", sk: "LOGIN#google#s" };

  it("schema_version の条件と attribute_exists(pk) を持ち、remove の列が REMOVE 句に並ぶ", () => {
    const item = updateIfSchemaVersion({ table: "users", key, from: 1, set: { schema_version: 2, idp: "google" }, remove: ["old_column"], version: null, onConflict: "fail" });
    const ex = expressionsOf(item.condition, item.update);
    expect(ex.ConditionExpression).toBe("(attribute_exists(#n0) AND #n1 = :v0)");
    expect(ex.UpdateExpression).toBe("SET #n1 = :v1, #n2 = :v2 REMOVE #n3");
    expect(ex.ExpressionAttributeNames).toEqual({ "#n0": "pk", "#n1": "schema_version", "#n2": "idp", "#n3": "old_column" });
  });

  it("version があれば版も条件にし、version を上げない", () => {
    const item = updateIfSchemaVersion({ table: "teams", key: { pk: "TEAM#t", sk: "TEAM" }, from: 1, set: { schema_version: 2 }, remove: [], version: 4, onConflict: "fail" });
    const ex = expressionsOf(item.condition, item.update);
    expect(ex.ConditionExpression).toBe("(attribute_exists(#n0) AND #n1 = :v0 AND #n2 = :v1)");
    expect(ex.UpdateExpression).toBe("SET #n1 = :v2");
  });

  it("remove が空なら REMOVE 句を持たない", () => {
    const item = updateIfSchemaVersion({ table: "users", key, from: 1, set: { schema_version: 2 }, remove: [], version: null, onConflict: "fail" });
    expect(expressionsOf(item.condition, item.update).UpdateExpression).toBe("SET #n1 = :v1");
  });

  it("remove が set の鍵か pk・sk・version・schema_version を含むと投げる", () => {
    for (const remove of [["idp"], ["pk"], ["sk"], ["version"], ["schema_version"]]) {
      expect(() => updateIfSchemaVersion({ table: "users", key, from: 1, set: { schema_version: 2, idp: "x" }, remove, version: null, onConflict: "fail" })).toThrow(WriteSpecError);
    }
  });

  it("set の schema_version が from より大きくないと投げる。set に version を含むと型で弾く", () => {
    expect(() => updateIfSchemaVersion({ table: "users", key, from: 2, set: { schema_version: 2 }, remove: [], version: null, onConflict: "fail" })).toThrow(WriteSpecError);
    // @ts-expect-error set に version を書けない
    expect(() => updateIfSchemaVersion({ table: "users", key, from: 1, set: { schema_version: 2, version: 3 }, remove: [], version: null, onConflict: "fail" })).toThrow(WriteSpecError);
  });

  it("行が消えていれば条件が外れ、行を作り直さない", async () => {
    const table = fakeTable();
    const outcome = await writeAtomically(table.db, [updateIfSchemaVersion({ table: "users", key, from: 1, set: { schema_version: 2 }, remove: [], version: null, onConflict: "fail" })]);
    expect(outcome.ok).toBe(false);
    expect(table.rows("users")).toEqual([]);
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
    ["取り消しの理由が書き込みの呼びすぎ", Object.assign(new Error("throttled"), { name: "TransactionCanceledException", $metadata: { httpStatusCode: 400 }, CancellationReasons: [{ Code: "None" }, { Code: "ThrottlingError" }] }), "retryable"],
    ["名前の分からない 5xx", Object.assign(new Error("down"), { name: "SomethingUnexpected", $metadata: { httpStatusCode: 503 } }), "retryable"],
    ["分類できない失敗", Object.assign(new Error("odd"), { name: "SerializationException", $metadata: { httpStatusCode: 400 } }), "unknown"],
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
