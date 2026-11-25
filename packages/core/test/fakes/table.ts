import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { checkAuditAppendOnly, type Condition, type TransactItem, type Update } from "../../src/conditional-write.ts";
import type { Db, KeyCondition, RowKey, StoredRow, TableName } from "../../src/db.ts";

// 偽の表。DynamoDB を呼ばずに、条件と更新を構造の値のまま当てる。
// トランザクションは全件の条件を先に照らし、1 件でも外れれば何も書かずに SDK と同じ TransactionCanceledException を投げる。
// 索引は結果整合を真似るため本体と別に持ち、テストが古い行を残せる（決定 14）

type Mutable = Record<string, unknown>;

// invalid_with_conflict は、条件の外れた件と並べて、外れていない最初の件を表が断った理由（ValidationError）にした取り消し
export type InjectedFailure = "conflict" | "throttled" | "unavailable" | "invalid" | "invalid_with_conflict";

function rowKey(key: RowKey): string {
  return `${key.pk}\u0000${key.sk ?? ""}`;
}

function getPath(row: Mutable | undefined, path: string): unknown {
  let current: unknown = row;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Mutable)[segment];
  }
  return current;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(op: string, actual: unknown, expected: unknown): boolean {
  if (op === "=") return actual !== undefined && sameValue(actual, expected);
  if (op === "<>") return actual !== undefined && !sameValue(actual, expected);
  // DynamoDB は型の違う値どうしの大小を偽にする
  if (typeof actual !== typeof expected || (typeof actual !== "number" && typeof actual !== "string")) return false;
  const a = actual as number | string;
  const e = expected as number | string;
  switch (op) {
    case "<":
      return a < e;
    case "<=":
      return a <= e;
    case ">":
      return a > e;
    default:
      return a >= e;
  }
}

function evaluate(condition: Condition, row: Mutable | undefined): boolean {
  switch (condition.kind) {
    case "exists":
      return getPath(row, condition.path) !== undefined;
    case "not_exists":
      return getPath(row, condition.path) === undefined;
    case "cmp":
      return compare(condition.op, getPath(row, condition.path), condition.value);
    case "and":
      return condition.of.every((c) => evaluate(c, row));
    case "or":
      return condition.of.some((c) => evaluate(c, row));
  }
}

function validationError(message: string): Error {
  return Object.assign(new Error(message), { name: "ValidationException" });
}

// DynamoDB と同じく、入れ子の道の親の地図が無ければ更新を拒む
function parentOf(row: Mutable, path: string): { parent: Mutable; leaf: string } {
  const segments = path.split(".");
  const leaf = segments.pop() ?? "";
  let parent: Mutable = row;
  for (const segment of segments) {
    const next = parent[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) throw validationError("The document path provided in the update expression is invalid for update");
    parent = next as Mutable;
  }
  return { parent, leaf };
}

function applyUpdate(base: Mutable, update: Update): Mutable {
  const row = structuredClone(base);
  for (const action of update) {
    const { parent, leaf } = parentOf(row, action.path);
    if (action.kind === "set") parent[leaf] = structuredClone(action.value);
    else if (action.kind === "remove") delete parent[leaf];
    else {
      const current = parent[leaf] ?? action.from;
      if (typeof current !== "number") throw validationError("An operand in the update expression has an incorrect data type");
      parent[leaf] = current + action.by;
    }
  }
  return row;
}

function cancelled(codes: string[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: "Transaction cancelled",
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

function unavailable(): Error {
  return Object.assign(new Error("Service unavailable"), { name: "InternalServerError" });
}

function matchesKey(row: Mutable, keyCond: KeyCondition): boolean {
  if (row[keyCond.partition.column] !== keyCond.partition.value) return false;
  const sort = keyCond.sort;
  if (sort === undefined) return true;
  const value = row[sort.column];
  if (typeof value !== "string" && typeof value !== "number") return false;
  if (sort.op === "begins_with") return typeof value === "string" && value.startsWith(sort.value);
  if (sort.op === "between") return value >= sort.low && value <= sort.high;
  return compare(sort.op, value, sort.value);
}

// 文字列の符号単位の順（DynamoDB の鍵の順と同じく大文字と小文字を区別する）。整列と続きの位置の探索の両方がこれを使う
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bySortKey(column: string) {
  return (a: Mutable, b: Mutable): number => compareText(String(a[column] ?? ""), String(b[column] ?? ""));
}

export function fakeTable() {
  const tables = new Map<TableName, Map<string, Mutable>>();
  const indexes = new Map<string, Mutable[]>();
  const failures: InjectedFailure[] = [];
  // 送られたトランザクション（件の一覧）
  const transactions: (readonly TransactItem[])[] = [];
  const reads: { table: TableName; key: RowKey; consistent: boolean }[] = [];
  let getFailure: Error | null = null;

  const tableOf = (name: TableName): Map<string, Mutable> => {
    let table = tables.get(name);
    if (table === undefined) {
      table = new Map();
      tables.set(name, table);
    }
    return table;
  };

  const db: Db = {
    async get(table, key, consistent) {
      reads.push({ table, key, consistent });
      if (getFailure !== null) throw getFailure;
      const row = tableOf(table).get(rowKey(key));
      return row === undefined ? null : (structuredClone(row) as StoredRow);
    },
    async query(table, keyCond, opts) {
      const items = [...tableOf(table).values()].filter((row) => matchesKey(row, keyCond)).sort(bySortKey(keyCond.sort?.column ?? "sk"));
      if (opts.descending === true) items.reverse();
      return { items: structuredClone(items.slice(0, opts.limit ?? items.length)), lastKey: null };
    },
    async queryIndex(table, index, keyCond, opts) {
      const items = (indexes.get(`${table}/${index}`) ?? []).filter((row) => matchesKey(row, keyCond));
      return { items: structuredClone(items.slice(0, opts.limit ?? items.length)), lastKey: null };
    },
    async scan(table, opts) {
      const keyOfRow = (row: Mutable): string => rowKey({ pk: String(row["pk"]), sk: typeof row["sk"] === "string" ? row["sk"] : null });
      const all = [...tableOf(table).values()].sort((a, b) => compareText(keyOfRow(a), keyOfRow(b)));
      const after = opts.startKey === null ? null : rowKey(opts.startKey);
      const start = after === null ? 0 : all.findIndex((row) => compareText(keyOfRow(row), after) > 0);
      const page = start < 0 ? [] : all.slice(start, start + opts.limit);
      const last = page.at(-1);
      const more = start >= 0 && start + opts.limit < all.length;
      return { items: structuredClone(page), lastKey: more && last !== undefined ? { pk: String(last["pk"]), sk: typeof last["sk"] === "string" ? last["sk"] : null } : null };
    },
    async transactWrite(items) {
      // 本物の createDb と同じく、送る境で記録の表の書き換え・消し・上書きを止める（送られた件に数えない）
      checkAuditAppendOnly(items);
      transactions.push(items);
      const failure = failures.shift();
      if (failure === "conflict") throw cancelled(items.map(() => "TransactionConflict"));
      if (failure === "throttled") throw cancelled(items.map((_, index) => (index === 0 ? "ThrottlingError" : "None")));
      if (failure === "unavailable") throw unavailable();
      if (failure === "invalid") throw validationError("One or more parameter values were invalid");
      const codes = items.map((item) => (evaluate(item.condition, tableOf(item.table).get(rowKey(item.key))) ? "None" : "ConditionalCheckFailed"));
      if (failure === "invalid_with_conflict") {
        const at = codes.indexOf("None");
        throw cancelled(codes.map((code, index) => (index === at ? "ValidationError" : code)));
      }
      if (codes.includes("ConditionalCheckFailed")) throw cancelled(codes);
      // 更新を先に全部組んでから書く（途中の誤りで半端に書かない）
      const next = items.map((item) => {
        const existing = tableOf(item.table).get(rowKey(item.key));
        if (item.op === "put") return { item, row: structuredClone({ ...item.item }) as Mutable | null };
        if (item.op === "delete") return { item, row: null };
        if (item.op === "check") return { item, row: existing ?? null };
        return { item, row: applyUpdate(existing ?? { pk: item.key.pk, ...(item.key.sk === null ? {} : { sk: item.key.sk }) }, item.update ?? []) };
      });
      for (const { item, row } of next) {
        if (item.op === "check") continue;
        if (row === null) tableOf(item.table).delete(rowKey(item.key));
        else tableOf(item.table).set(rowKey(item.key), row);
      }
    },
    async update(table, key, update, condition) {
      const existing = tableOf(table).get(rowKey(key));
      if (!evaluate(condition, existing)) return false;
      tableOf(table).set(rowKey(key), applyUpdate(existing ?? { pk: key.pk, ...(key.sk === null ? {} : { sk: key.sk }) }, update));
      return true;
    },
  };

  return {
    db,
    transactions,
    reads,
    // 本体へ行を置く
    seed(table: TableName, row: Mutable): void {
      tableOf(table).set(rowKey({ pk: String(row["pk"]), sk: typeof row["sk"] === "string" ? row["sk"] : null }), structuredClone(row));
    },
    remove(table: TableName, key: RowKey): void {
      tableOf(table).delete(rowKey(key));
    },
    row(table: TableName, key: RowKey): Mutable | undefined {
      const row = tableOf(table).get(rowKey(key));
      return row === undefined ? undefined : structuredClone(row);
    },
    rows(table: TableName): Mutable[] {
      return structuredClone([...tableOf(table).values()]);
    },
    // 索引の中身を置く（本体と食い違ってよい。結果整合の遅れを真似る）
    setIndex(table: TableName, index: string, rows: Mutable[]): void {
      indexes.set(`${table}/${index}`, structuredClone(rows));
    },
    // 次のトランザクションから順に、衝突・届かない失敗・表が断る失敗（ValidationException）を起こす
    failNext(...next: InjectedFailure[]): void {
      failures.push(...next);
    },
    failReads(error: Error | null): void {
      getFailure = error;
    },
  };
}

export type FakeTable = ReturnType<typeof fakeTable>;
