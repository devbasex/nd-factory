import { RETRY_POLICIES } from "@nd-factory/contracts/data";
import { writeRow, type RowCodec, type Stored } from "@nd-factory/contracts/row-codec";
import pRetry from "p-retry";
import { v4 } from "uuid";
import type { Db, Row, RowKey, TableName } from "./db.ts";
import type { Logger } from "./log.ts";
import { classifyFailure, isRetryableCancellation } from "./retry.ts";

// 条件つきの書き込み。条件と更新は構造の値（Condition・Update）で組み、DynamoDB の式の文字列へはこのモジュールの
// expressionsOf だけが書き出す（条件式の組み立てを部品の外に置かない。受け入れ条件 2）。
// 確定は writeAtomically が 1 つのトランザクションで行い、一時の失敗による取り消し（衝突と書き込みの呼びすぎ。SDK が繰り返さない）だけを p-retry で繰り返す（決定 13・17）

// DynamoDB の 1 つのトランザクションの件の上限（TransactWriteItems の仕様の値。AWS の DynamoDB の API の文書の TransactItems の上限）
export const TRANSACT_MAX_ITEMS = 100;

// 外れたときの扱い。呼び手が要素の 409 version_mismatch・state_mismatch か、前の 1 件の結果にする。
// rebuild は、サーバーが読んだ行から作る書き換え（月の使った量の加算・利用者の行の login_count の足し引き）が外れたとき、
// dispatch がハンドラーを呼び直して組み直す扱い。writeAtomically は訳さずに外れた件と一緒に返す（issues/issue-2-design-row-writers.md の決定 6）
export type ConflictRule = "version_mismatch" | "state_mismatch" | "return_existing" | "rebuild" | "fail";

// 比べる値の列の道。入れ子の地図の中は . で区切る（列の名前は英小文字と _ だけで . を持たない）
export type ColumnPath = string;

export type Condition =
  | { readonly kind: "exists"; readonly path: ColumnPath }
  | { readonly kind: "not_exists"; readonly path: ColumnPath }
  | { readonly kind: "cmp"; readonly path: ColumnPath; readonly op: "=" | "<>" | "<" | "<=" | ">" | ">="; readonly value: unknown }
  | { readonly kind: "and"; readonly of: readonly Condition[] }
  | { readonly kind: "or"; readonly of: readonly Condition[] };

export type UpdateAction =
  | { readonly kind: "set"; readonly path: ColumnPath; readonly value: unknown }
  // path = path + by。from があれば列が無いとき from から足す（if_not_exists）
  | { readonly kind: "increment"; readonly path: ColumnPath; readonly by: number; readonly from?: number }
  | { readonly kind: "remove"; readonly path: ColumnPath };

export type Update = readonly UpdateAction[];

export type TransactItem = {
  readonly table: TableName;
  readonly op: "put" | "update" | "delete" | "check";
  readonly key: RowKey;
  // put の行
  readonly item?: Row;
  // update の更新
  readonly update?: Update;
  readonly condition: Condition;
  readonly onConflict: ConflictRule;
};

export type WriteOutcome = { readonly ok: true } | { readonly ok: false; readonly failed: readonly { readonly index: number; readonly onConflict: ConflictRule }[] };

// 書き手の誤り（設計の誤りで、テストが先に落とす）
export class WriteSpecError extends Error {
  override name = "WriteSpecError";
}

// 記録の表（追記だけ、I9）の行を書き換える・消す書き込み。API の役割も記録の表の更新と削除の権限を持たない
export class AuditAppendOnlyError extends Error {
  override name = "AuditAppendOnlyError";
}

// 再試行の後も表に届かない（分類が rejected でない失敗。retryable と、断ったと言い切れない unknown など）。呼び手は要求全体の 503（記録の行を含むなら audit_unavailable、含まなければ unavailable）にする。
// unknown は届かないのか断ったのか分からず、再実行しても通らないことがある（audit_unavailable の判別を残すための代償）。
// 表が断った失敗（分類が rejected。ValidationException・SerializationException・取り消しの理由の ValidationError など、再実行しても通らない）はこれに包まず、元の例外のまま投げる
export class WriteUnavailableError extends Error {
  override name = "WriteUnavailableError";
  readonly includesAudit: boolean;
  constructor(message: string, options: { cause: unknown; includesAudit: boolean }) {
    super(message, { cause: options.cause });
    this.includesAudit = options.includesAudit;
  }
}

// 構造の値の組み立て

export const cond = {
  exists: (path: ColumnPath): Condition => ({ kind: "exists", path }),
  notExists: (path: ColumnPath): Condition => ({ kind: "not_exists", path }),
  eq: (path: ColumnPath, value: unknown): Condition => ({ kind: "cmp", path, op: "=", value }),
  ne: (path: ColumnPath, value: unknown): Condition => ({ kind: "cmp", path, op: "<>", value }),
  lt: (path: ColumnPath, value: unknown): Condition => ({ kind: "cmp", path, op: "<", value }),
  le: (path: ColumnPath, value: unknown): Condition => ({ kind: "cmp", path, op: "<=", value }),
  gt: (path: ColumnPath, value: unknown): Condition => ({ kind: "cmp", path, op: ">", value }),
  ge: (path: ColumnPath, value: unknown): Condition => ({ kind: "cmp", path, op: ">=", value }),
  and: (...of: Condition[]): Condition => ({ kind: "and", of }),
  or: (...of: Condition[]): Condition => ({ kind: "or", of }),
};

// 鍵と版の列。set と remove はこれらを書き換えない
const KEY_COLUMNS = ["pk", "sk", "version"] as const;

// set に鍵と版の列を書けない形（型で弾く）
export type SetColumns = { readonly [column: string]: unknown } & { readonly pk?: never; readonly sk?: never; readonly version?: never };

function checkSetAndRemove(what: string, set: Readonly<Record<string, unknown>>, remove: readonly string[], forbiddenInRemove: readonly string[]): void {
  for (const column of KEY_COLUMNS) {
    if (Object.hasOwn(set, column)) throw new WriteSpecError(`${what}: set に ${column} を含めない`);
  }
  for (const column of remove) {
    if (forbiddenInRemove.includes(column)) throw new WriteSpecError(`${what}: remove に ${column} を含めない`);
    if (Object.hasOwn(set, column)) throw new WriteSpecError(`${what}: remove が set の列と重なる: ${column}`);
  }
  if (new Set(remove).size !== remove.length) throw new WriteSpecError(`${what}: remove の列が重なる`);
}

function setActions(set: Readonly<Record<string, unknown>>): UpdateAction[] {
  return Object.entries(set).map(([path, value]) => ({ kind: "set", path, value }));
}

function removeActions(remove: readonly string[]): UpdateAction[] {
  return remove.map((path) => ({ kind: "remove", path }));
}

// 記録の表を除く行の世代（incarnation）を持つ表。記録の表の行は追記だけで表の移しも書き直さないため持たない（決定 8・9）
function hasIncarnation(table: TableName): boolean {
  return table !== "audit";
}

function checkSchemaVersion(what: string, item: Row): void {
  if (typeof item.pk !== "string" || item.pk.length === 0) throw new WriteSpecError(`${what}: pk は空でない文字列`);
  if (!Number.isInteger(item.schema_version) || item.schema_version < 1) throw new WriteSpecError(`${what}: schema_version は 1 以上の整数`);
}

function keyOfItem(item: Row): RowKey {
  return { pk: item.pk, sk: item.sk ?? null };
}

// 行が無いときだけ足す。記録の表を除くどの表でも（version の有無によらず）新しい incarnation（UUID v4）を足した行を書き、戻り値の item に載せる。
// 書き手は作った行の incarnation をそこから読む。渡した行の incarnation（rowToCreate の仮の値）は新しい値で置き換える（決定 8）
export function putIfAbsent(spec: { table: TableName; item: Row; onConflict: ConflictRule }): TransactItem {
  checkSchemaVersion("putIfAbsent", spec.item);
  const item: Row = hasIncarnation(spec.table) ? { ...spec.item, incarnation: v4() } : spec.item;
  return {
    table: spec.table,
    op: "put",
    key: keyOfItem(item),
    item,
    condition: cond.notExists("pk"),
    onConflict: spec.onConflict,
  };
}

// putIfAbsent へ渡す新しい行を、行の版の書き手（writeRow）で作る。schema_version は writeRow が書き手の版にする。
// 行の形は incarnation を必須にしているため仮の値を入れて照らし、putIfAbsent がそれを新しい UUID v4 で置き換える（仮の値は表に書かれない）
const INCARNATION_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

export function rowToCreate<L extends { readonly incarnation: string; readonly schema_version: number }>(codec: RowCodec<L>, row: Omit<L, "incarnation" | "schema_version">): Row {
  const written = writeRow(codec, { ...row, schema_version: codec.latest.version, incarnation: INCARNATION_PLACEHOLDER } as unknown as L);
  return written as Row;
}

// 読んだ行に保存してあった version と incarnation。readRow の stored の値（列が無ければ absent）
export type StoredVersion = { readonly version: Stored; readonly incarnation: Stored };

function storedCondition(column: "version" | "incarnation", stored: Stored): Condition {
  return stored.kind === "absent" ? cond.notExists(column) : cond.eq(column, stored.value);
}

function checkExpect(what: string, expect: StoredVersion): void {
  const version = expect.version;
  if (version.kind === "value" && !(typeof version.value === "number" && Number.isInteger(version.value) && version.value >= 1)) {
    throw new WriteSpecError(`${what}: expect の version は 1 以上の整数か absent`);
  }
  const incarnation = expect.incarnation;
  if (incarnation.kind === "value" && !(typeof incarnation.value === "string" && incarnation.value.length > 0)) {
    throw new WriteSpecError(`${what}: expect の incarnation は空でない文字列か absent`);
  }
}

// 行があり、保存してあった version と incarnation が読んだときと同じこと（と extra）。attribute_exists(pk) は expect によらず必ず入れる
// （version と incarnation の両方を補った行では 2 つの条件がどちらも attribute_not_exists になり、読んだ後に行が消えても通ってしまうため）
function versionCondition(expect: StoredVersion, extra: Condition | undefined): Condition {
  const of = [cond.exists("pk"), storedCondition("version", expect.version), storedCondition("incarnation", expect.incarnation)];
  return cond.and(...(extra === undefined ? of : [...of, extra]));
}

// 読んだ行の置き換え（決定 1・8）。item は rowReplaceOf の戻り値（version と incarnation を持たない行全体）。
// 保存してあった version と incarnation（expect。readRow の stored）のときだけ行を item で置き換え、version を読み手の見る形の値から 1 上げ、
// incarnation を読み手の見る形の値にする。行に item に無い列があれば置き換えで消える。記録の表は拒む（追記だけ、I9）
export function replaceIfVersion(spec: {
  table: TableName;
  item: Row;
  version: number;
  incarnation: string;
  expect: StoredVersion;
  extra?: Condition;
  onConflict: ConflictRule;
}): TransactItem {
  checkSchemaVersion("replaceIfVersion", spec.item);
  for (const column of ["version", "incarnation"]) {
    if (Object.hasOwn(spec.item, column)) throw new WriteSpecError(`replaceIfVersion: item に ${column} を含めない（rowReplaceOf の戻り値を渡す）`);
  }
  if (!Number.isInteger(spec.version) || spec.version < 1) throw new WriteSpecError("replaceIfVersion: version は 1 以上の整数");
  if (typeof spec.incarnation !== "string" || spec.incarnation.length === 0) throw new WriteSpecError("replaceIfVersion: incarnation は空でない文字列");
  checkExpect("replaceIfVersion", spec.expect);
  const item: Row = { ...spec.item, version: spec.version + 1, incarnation: spec.incarnation };
  const out: TransactItem = { table: spec.table, op: "put", key: keyOfItem(item), item, condition: versionCondition(spec.expect, spec.extra), onConflict: spec.onConflict };
  checkAuditAppendOnly([out]);
  return out;
}

// 保存してあった version と incarnation（readRow の stored）のときだけ行を消す。条件は replaceIfVersion と同じ（と extra）。
// 消えていた行では外れる（書き手は既に無い行を自分が消したと取り違えない）。記録の表は拒む
export function deleteIfVersion(spec: { table: TableName; key: RowKey; expect: StoredVersion; extra?: Condition; onConflict: ConflictRule }): TransactItem {
  checkExpect("deleteIfVersion", spec.expect);
  const out: TransactItem = { table: spec.table, op: "delete", key: spec.key, condition: versionCondition(spec.expect, spec.extra), onConflict: spec.onConflict };
  checkAuditAppendOnly([out]);
  return out;
}

// 行の形の版が from のときだけ書き換える（表の移しと、version を持たない行の書き換え）。version を上げない
export function updateIfSchemaVersion(spec: {
  table: TableName;
  key: RowKey;
  from: number;
  set: SetColumns;
  remove: readonly string[];
  version: number | null;
  onConflict: ConflictRule;
}): TransactItem {
  const to = spec.set["schema_version"];
  if (typeof to !== "number" || !Number.isInteger(to) || to <= spec.from) throw new WriteSpecError("updateIfSchemaVersion: set の schema_version は from より大きい整数");
  checkSetAndRemove("updateIfSchemaVersion", spec.set, spec.remove, ["pk", "sk", "version", "schema_version"]);
  const conditions = [cond.exists("pk"), cond.eq("schema_version", spec.from)];
  if (spec.version !== null) conditions.push(cond.eq("version", spec.version));
  return {
    table: spec.table,
    op: "update",
    key: spec.key,
    update: [...setActions(spec.set), ...removeActions(spec.remove)],
    condition: cond.and(...conditions),
    onConflict: spec.onConflict,
  };
}

// 式の書き出し。プレースホルダは 1 件の中で通し番号にし、条件と更新で重ならない

export type Expressions = {
  readonly ConditionExpression: string;
  readonly UpdateExpression?: string;
  readonly ExpressionAttributeNames: Record<string, string>;
  readonly ExpressionAttributeValues?: Record<string, unknown>;
};

class Placeholders {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, unknown> = {};
  private readonly byName = new Map<string, string>();
  private valueCount = 0;

  path(path: ColumnPath): string {
    return path
      .split(".")
      .map((segment) => {
        if (!/^[a-z][a-z0-9_]*$/.test(segment)) throw new WriteSpecError(`列の名前の形が違う: ${segment}`);
        let placeholder = this.byName.get(segment);
        if (placeholder === undefined) {
          placeholder = `#n${this.byName.size}`;
          this.byName.set(segment, placeholder);
          this.names[placeholder] = segment;
        }
        return placeholder;
      })
      .join(".");
  }

  value(value: unknown): string {
    const placeholder = `:v${this.valueCount}`;
    this.valueCount += 1;
    this.values[placeholder] = value;
    return placeholder;
  }
}

function conditionText(c: Condition, ph: Placeholders): string {
  switch (c.kind) {
    case "exists":
      return `attribute_exists(${ph.path(c.path)})`;
    case "not_exists":
      return `attribute_not_exists(${ph.path(c.path)})`;
    case "cmp":
      return `${ph.path(c.path)} ${c.op} ${ph.value(c.value)}`;
    case "and":
    case "or": {
      if (c.of.length === 0) throw new WriteSpecError(`${c.kind} の条件が空`);
      const parts = c.of.map((part) => conditionText(part, ph));
      return parts.length === 1 ? (parts[0] ?? "") : `(${parts.join(c.kind === "and" ? " AND " : " OR ")})`;
    }
  }
}

function updateText(update: Update, ph: Placeholders): string {
  const sets: string[] = [];
  const removes: string[] = [];
  for (const action of update) {
    if (action.kind === "set") sets.push(`${ph.path(action.path)} = ${ph.value(action.value)}`);
    else if (action.kind === "increment") {
      const path = ph.path(action.path);
      const base = action.from === undefined ? path : `if_not_exists(${path}, ${ph.value(action.from)})`;
      sets.push(`${path} = ${base} + ${ph.value(action.by)}`);
    } else removes.push(ph.path(action.path));
  }
  if (sets.length === 0 && removes.length === 0) throw new WriteSpecError("更新が空");
  const clauses: string[] = [];
  if (sets.length > 0) clauses.push(`SET ${sets.join(", ")}`);
  if (removes.length > 0) clauses.push(`REMOVE ${removes.join(", ")}`);
  return clauses.join(" ");
}

export function expressionsOf(condition: Condition, update?: Update): Expressions {
  const ph = new Placeholders();
  const ConditionExpression = conditionText(condition, ph);
  const UpdateExpression = update === undefined ? undefined : updateText(update, ph);
  // 値の無い式に空の ExpressionAttributeValues を渡すと DynamoDB が拒む
  const hasValues = Object.keys(ph.values).length > 0;
  return {
    ConditionExpression,
    ...(UpdateExpression === undefined ? {} : { UpdateExpression }),
    ExpressionAttributeNames: ph.names,
    ...(hasValues ? { ExpressionAttributeValues: ph.values } : {}),
  };
}

// 確定

function cancellationCodes(error: unknown): readonly (string | undefined)[] | null {
  if (error === null || typeof error !== "object") return null;
  const e = error as { name?: unknown; CancellationReasons?: unknown };
  if (e.name !== "TransactionCanceledException" || !Array.isArray(e.CancellationReasons)) return null;
  return e.CancellationReasons.map((r: unknown) => {
    const code = r !== null && typeof r === "object" ? (r as { Code?: unknown }).Code : undefined;
    return typeof code === "string" ? code : undefined;
  });
}

function rowId(item: TransactItem): string {
  return `${item.table}\u0000${item.key.pk}\u0000${item.key.sk ?? ""}`;
}

function isAppendOnlyPut(item: TransactItem): boolean {
  return item.op === "put" && item.condition.kind === "not_exists" && item.condition.path === "pk";
}

// 記録の表は無いときだけ足す。書き換え・消し・上書きを組んだら確定しない（I9）。
// writeAtomically の前の照らしと、送る境の Db.transactWrite（createDb）の両方が呼ぶ。既にある鍵への Put は更新と削除の権限が無くても
// Put の権限で上書きできるため、権限だけに頼らず送る前に止める
export function checkAuditAppendOnly(items: readonly TransactItem[]): void {
  for (const item of items) {
    if (item.table === "audit" && !isAppendOnlyPut(item)) throw new AuditAppendOnlyError(`記録の表へ ${item.op} を書かない（追記だけ）`);
  }
}

function checkItems(items: readonly TransactItem[]): void {
  if (items.length === 0) throw new WriteSpecError("書き込みが 0 件");
  if (items.length > TRANSACT_MAX_ITEMS) throw new WriteSpecError(`書き込みが ${TRANSACT_MAX_ITEMS} 件を越える: ${items.length}`);
  const seen = new Set<string>();
  for (const item of items) {
    const id = rowId(item);
    if (seen.has(id)) throw new WriteSpecError(`同じ行を 2 回指す（表 ${item.table}）`);
    seen.add(id);
  }
  checkAuditAppendOnly(items);
}

function tablesOf(items: readonly TransactItem[]): string[] {
  return [...new Set(items.map((item) => item.table))];
}

const TRANSACTION_POLICY = RETRY_POLICIES["dynamodb-transaction"];

export async function writeAtomically(db: Db, items: readonly TransactItem[], log?: Logger): Promise<WriteOutcome> {
  checkItems(items);
  // ログは表の名前・件の数・結果・外れた件の扱いだけ（行の値を出さない）
  const summary = { tables: tablesOf(items), count: items.length };
  const attempt = async (): Promise<WriteOutcome> => {
    try {
      await db.transactWrite(items);
      return { ok: true };
    } catch (error) {
      // 断った取り消しの理由（ValidationError・ItemCollectionSizeLimitExceeded）が別の件に並ぶときは、条件の外れより先に元の例外のまま投げる。
      // 断った件は直すまで通らず、条件の外れとして返すと呼び手が 409 や前の 1 件の結果にしてしまう
      if (classifyFailure(error) === "rejected") throw error;
      const codes = cancellationCodes(error);
      // 条件の外れは繰り返さず、件の番号と扱いへ訳す。ほかの失敗は投げる（一時の失敗による取り消しだけ p-retry が繰り返す）
      if (codes !== null && codes.includes("ConditionalCheckFailed")) {
        const failed = items.flatMap((item, index) => (codes[index] === "ConditionalCheckFailed" ? [{ index, onConflict: item.onConflict }] : []));
        return { ok: false, failed };
      }
      throw error;
    }
  };
  try {
    const outcome = await pRetry(attempt, {
      retries: TRANSACTION_POLICY.retries,
      minTimeout: TRANSACTION_POLICY.min_ms,
      maxTimeout: TRANSACTION_POLICY.max_ms,
      shouldRetry: ({ error }) => isRetryableCancellation(error),
      onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
        if (isRetryableCancellation(error) && retriesLeft > 0) {
          log?.warn("トランザクションの取り消しを繰り返す", { ...summary, policy: "dynamodb-transaction", attempt: attemptNumber, class: "retryable" });
        }
      },
    });
    if (outcome.ok) log?.info("書き込みを確定した", { ...summary, result: "ok" });
    else log?.info("書き込みの条件が外れた", { ...summary, result: "conflict", failed: outcome.failed.map((f) => f.onConflict) });
    return outcome;
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    const cls = classifyFailure(error);
    if (cls === "rejected") {
      // 届かないのでなく表が断った。再実行しても通らないため「届かない」と言わず、元の例外のまま投げる
      log?.error("書き込みを表が断った", { ...summary, result: "rejected", class: cls, error: name });
      throw error;
    }
    // retryable と、断ったと言い切れない失敗（unknown など）は届かないとして包む。記録の行を含む書き込みの audit_unavailable の判別を失わない
    const includesAudit = items.some((item) => item.table === "audit");
    log?.error("書き込みが表に届かない", { ...summary, result: "unavailable", class: cls, error: name });
    throw new WriteUnavailableError(`書き込みを確定できない（${name}）`, { cause: error, includesAudit });
  }
}
