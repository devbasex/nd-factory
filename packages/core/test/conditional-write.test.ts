import { RETRY_POLICIES } from "@nd-factory/contracts/data";
import { readRow, rowCodec } from "@nd-factory/contracts/row-codec";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuditAppendOnlyError,
  cond,
  expressionsOf,
  putIfAbsent,
  rewriteIfState,
  rewriteIfVersion,
  TRANSACT_MAX_ITEMS,
  updateIfSchemaVersion,
  updateIfState,
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
  it("版と行の形の版の条件と version + 1 を持つ 1 件を組む", () => {
    const item = updateIfVersion({ table: "teams", key: { pk: `TEAM#${TEAM}`, sk: "TEAM" }, version: 3, schemaVersion: 1, set: { name: "acme-2" }, onConflict: "version_mismatch" });
    expect(item.op).toBe("update");
    expect(expressionsOf(item.condition, item.update)).toEqual({
      ConditionExpression: "(#n0 = :v0 AND #n1 = :v1)",
      UpdateExpression: "SET #n2 = :v2, #n0 = #n0 + :v3",
      ExpressionAttributeNames: { "#n0": "version", "#n1": "schema_version", "#n2": "name" },
      ExpressionAttributeValues: { ":v0": 3, ":v1": 1, ":v2": "acme-2", ":v3": 1 },
    });
  });

  it("version が 1 で extra があると版と行の形の版と extra を条件にする", () => {
    const item = updateIfVersion({ table: "decisions", key: { pk: "PROJECT#p", sk: "APPROVAL#a" }, version: 1, schemaVersion: 1, set: { state: "answered" }, extra: cond.eq("state", "waiting"), onConflict: "state_mismatch" });
    expect(expressionsOf(item.condition, item.update).ConditionExpression).toBe("(#n0 = :v0 AND #n1 = :v1 AND #n2 = :v2)");
  });

  it("remove の列は REMOVE 句に並び、SET と同じ 1 つの更新の式に入る", () => {
    const item = updateIfVersion({ table: "projects", key: { pk: "PROJECT#p", sk: "PROJECT" }, version: 2, schemaVersion: 1, set: { schema_version: 2 }, remove: ["current_team_id", "current_assign_id"], onConflict: "version_mismatch" });
    expect(expressionsOf(item.condition, item.update).UpdateExpression).toBe("SET #n1 = :v2, #n0 = #n0 + :v3 REMOVE #n2, #n3");
  });

  it("remove が空か無いと REMOVE 句を持たない", () => {
    for (const remove of [[], undefined]) {
      const item = updateIfVersion({ table: "teams", key: { pk: "TEAM#t", sk: "TEAM" }, version: 1, schemaVersion: 1, set: { name: "x" }, ...(remove === undefined ? {} : { remove }), onConflict: "version_mismatch" });
      expect(expressionsOf(item.condition, item.update).UpdateExpression).not.toContain("REMOVE");
    }
  });

  it("set に version を含むと型で弾く", () => {
    // @ts-expect-error set に version を書けない
    expect(() => updateIfVersion({ table: "teams", key: { pk: "TEAM#t", sk: "TEAM" }, version: 1, schemaVersion: 1, set: { version: 9 }, onConflict: "version_mismatch" })).toThrow(WriteSpecError);
  });

  it("remove が set の鍵か pk・sk・version・schema_version を含むと投げる", () => {
    for (const remove of [["name"], ["pk"], ["sk"], ["version"], ["schema_version"]]) {
      expect(() => updateIfVersion({ table: "teams", key: { pk: "TEAM#t", sk: "TEAM" }, version: 1, schemaVersion: 1, set: { name: "x" }, remove, onConflict: "version_mismatch" })).toThrow(WriteSpecError);
    }
  });

  it("version と schemaVersion が 1 以上の整数でないと投げる", () => {
    for (const version of [0, 1.5, -1]) {
      expect(() => updateIfVersion({ table: "teams", key: { pk: "TEAM#t", sk: "TEAM" }, version, schemaVersion: 1, set: { name: "x" }, onConflict: "version_mismatch" })).toThrow(WriteSpecError);
      expect(() => updateIfVersion({ table: "teams", key: { pk: "TEAM#t", sk: "TEAM" }, version: 1, schemaVersion: version, set: { name: "x" }, onConflict: "version_mismatch" })).toThrow(WriteSpecError);
    }
  });

  it("偽の表で、読んだ版のときだけ書けて版が 1 上がる", async () => {
    const table = fakeTable();
    table.seed("teams", teamRow(1));
    const key = { pk: `TEAM#${TEAM}`, sk: "TEAM" };
    expect(await writeAtomically(table.db, [updateIfVersion({ table: "teams", key, version: 1, schemaVersion: 1, set: { name: "acme-2" }, onConflict: "version_mismatch" })])).toEqual({ ok: true });
    expect(table.row("teams", key)).toMatchObject({ name: "acme-2", version: 2 });
    // 古い版で書くと外れ、何も変わらない
    expect(await writeAtomically(table.db, [updateIfVersion({ table: "teams", key, version: 1, schemaVersion: 1, set: { name: "stale" }, onConflict: "version_mismatch" })])).toEqual({
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
        updateIfVersion({ table: "teams", key: { pk: "TEAM#t", sk: "TEAM" }, version: 1, schemaVersion: 1, set: { name: "x" }, onConflict: "version_mismatch" }),
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

describe("updateIfState", () => {
  const key = { pk: "USER#u", sk: "LINK#l" };

  it("読んだ行の形の版と遷移元の状態と attribute_exists(pk) を条件に、同じ版の set と remove を一緒に当て、version を上げない", () => {
    const item = updateIfState({ table: "users", key, schemaVersion: 1, state: { column: "state", from: "open" }, set: { schema_version: 1, state: "verified" }, remove: ["code_verifier"], onConflict: "state_mismatch" });
    const ex = expressionsOf(item.condition, item.update);
    expect(ex.ConditionExpression).toBe("(attribute_exists(#n0) AND #n1 = :v0 AND #n2 = :v1)");
    expect(ex.UpdateExpression).toBe("SET #n1 = :v2, #n2 = :v3 REMOVE #n3");
    expect(ex.ExpressionAttributeNames).toEqual({ "#n0": "pk", "#n1": "schema_version", "#n2": "state", "#n3": "code_verifier" });
  });

  it("set の schema_version が無いか、remove が状態の列か pk・sk・version・schema_version を含むと投げる", () => {
    const base = { table: "users" as const, key, schemaVersion: 1, state: { column: "state", from: "open" }, onConflict: "state_mismatch" as const };
    expect(() => updateIfState({ ...base, set: { state: "verified" }, remove: [] })).toThrow(WriteSpecError);
    for (const remove of [["state"], ["pk"], ["sk"], ["version"], ["schema_version"]]) {
      expect(() => updateIfState({ ...base, set: { schema_version: 1 }, remove })).toThrow(WriteSpecError);
    }
  });
});

// 版 1 と版 2 を読む行の種類。版 2 は任意の列 owner_id（索引の鍵）を足す。移しは version を変えずに版 1 を版 2 へ書き換える
const ITEM_V1 = z.looseObject({ pk: z.string(), sk: z.string(), schema_version: z.literal(1), version: z.number(), item_id: z.string(), memo: z.string().optional() });
const ITEM_V2 = z.looseObject({ pk: z.string(), sk: z.string(), schema_version: z.literal(2), version: z.number(), item_id: z.string(), memo: z.string().optional(), owner_id: z.string().optional() });
type ItemV2 = z.infer<typeof ITEM_V2>;
const itemCodec = rowCodec({
  latest: { version: 2, schema: ITEM_V2 },
  previous: {
    version: 1,
    schema: ITEM_V1,
    // 版 1 の memo を版 2 の owner_id にも写す（移しが旧版の値を新版の索引の鍵へ写す）
    upgrade: (r: z.infer<typeof ITEM_V1>) => ({ ...r, schema_version: 2 as const, ...(r.memo === undefined ? {} : { owner_id: r.memo }) }),
    downgrade: ({ owner_id: _owner, ...r }: ItemV2) => ({ ...r, schema_version: 1 as const }),
  },
  writeVersion: 2,
  downgradable: false,
  keyOf: (r: ItemV2) => ({ pk: `ITEM#${r.item_id}`, sk: "ITEM" }),
});

describe("rewriteIfVersion", () => {
  const key = { pk: "ITEM#a", sk: "ITEM" };
  const v1 = { pk: "ITEM#a", sk: "ITEM", schema_version: 1, version: 3, item_id: "a", memo: "usr_x" };

  it("読んだ行の version と schema_version を条件にし、rowUpdateOf の set と remove を当てる", async () => {
    const table = fakeTable();
    table.seed("teams", v1);
    const raw = table.row("teams", key) as Record<string, unknown>;
    const read = readRow(itemCodec, raw);
    if (!read.ok) throw new Error("読めない");
    const { memo: _memo, ...without } = read.row;
    const item = rewriteIfVersion({ table: "teams", codec: itemCodec, raw: v1, row: without, onConflict: "version_mismatch" });
    expect(expressionsOf(item.condition, item.update).ConditionExpression).toBe("(#n0 = :v0 AND #n1 = :v1)");
    expect(await writeAtomically(table.db, [item])).toEqual({ ok: true });
    // memo を消した。版 2 の upgrade が写した owner_id は set に載る（書き手は消した memo の値から写さない）
    expect(table.row("teams", key)).toMatchObject({ schema_version: 2, version: 4, owner_id: "usr_x" });
    expect(table.row("teams", key)).not.toHaveProperty("memo");
  });

  it("旧版の行を読んだ後に移しが先に確定すると、読み直して組み直し、移しが足した列も消す", async () => {
    const table = fakeTable();
    table.seed("teams", v1);
    // 利用者の更新は旧版の行を読み、memo を消した形を作る（書き手は 1 段目のように owner_id を持たない形を書く）
    const raw = { ...v1 };
    const target: ItemV2 = { pk: "ITEM#a", sk: "ITEM", schema_version: 2, version: 3, item_id: "a" };
    const item = rewriteIfVersion({ table: "teams", codec: itemCodec, raw, row: target, onConflict: "version_mismatch" });
    // 組み直さなければ set にも remove にも owner_id が載らない
    expect(item.update?.some((a) => a.path === "owner_id")).toBe(false);
    // 移しが先に確定する（version を変えずに owner_id を足す）
    const migrated = updateIfSchemaVersion({ table: "teams", key, from: 1, set: { schema_version: 2, item_id: "a", memo: "usr_x", owner_id: "usr_x" }, remove: [], version: 3, onConflict: "fail" });
    expect(await writeAtomically(table.db, [migrated])).toEqual({ ok: true });
    expect(await writeAtomically(table.db, [item])).toEqual({ ok: true });
    const row = table.row("teams", key);
    expect(row).toMatchObject({ schema_version: 2, version: 4 });
    expect(row).not.toHaveProperty("owner_id");
    expect(row).not.toHaveProperty("memo");
  });

  it("version が変わっていれば組み直さず、条件の外れを返す", async () => {
    const table = fakeTable();
    table.seed("teams", { ...v1, schema_version: 2, version: 4, owner_id: "usr_x" });
    const target: ItemV2 = { pk: "ITEM#a", sk: "ITEM", schema_version: 2, version: 3, item_id: "a" };
    const item = rewriteIfVersion({ table: "teams", codec: itemCodec, raw: v1, row: target, onConflict: "version_mismatch" });
    expect(await writeAtomically(table.db, [item])).toEqual({ ok: false, failed: [{ index: 0, onConflict: "version_mismatch" }] });
    expect(table.row("teams", key)).toMatchObject({ version: 4, owner_id: "usr_x" });
  });
});

describe("rewriteIfState", () => {
  const key = { pk: "USER#u", sk: "LINK#l" };
  const link = { pk: "USER#u", sk: "LINK#l", schema_version: 1 as const, link_id: "l", state: "open" as const, code_verifier: "v" };
  const linkCodec = rowCodec({
    latest: { version: 1, schema: z.looseObject({ pk: z.string(), sk: z.string(), schema_version: z.literal(1), link_id: z.string(), state: z.enum(["open", "verified", "used"]), code_verifier: z.string().optional() }) },
    writeVersion: 1,
    keyOf: () => key,
  });

  it("版 1 の行の open → verified → used を同じ版の set と remove で書き、遷移元の状態が違えば外れる", async () => {
    const table = fakeTable();
    table.seed("users", link);
    const { code_verifier: _v, ...verified } = { ...link, state: "verified" as const };
    expect(await writeAtomically(table.db, [rewriteIfState({ table: "users", codec: linkCodec, raw: link, row: verified, onConflict: "state_mismatch" })])).toEqual({ ok: true });
    expect(table.row("users", key)).toEqual({ ...verified, schema_version: 1 });
    const raw = table.row("users", key) as Record<string, unknown>;
    expect(await writeAtomically(table.db, [rewriteIfState({ table: "users", codec: linkCodec, raw, row: { ...verified, state: "used" }, onConflict: "state_mismatch" })])).toEqual({ ok: true });
    expect(table.row("users", key)).toMatchObject({ state: "used", schema_version: 1 });
    // 古い読み（open）からの 2 回目の交換は外れる
    expect(await writeAtomically(table.db, [rewriteIfState({ table: "users", codec: linkCodec, raw: link, row: verified, onConflict: "state_mismatch" })])).toEqual({
      ok: false,
      failed: [{ index: 0, onConflict: "state_mismatch" }],
    });
  });
});
