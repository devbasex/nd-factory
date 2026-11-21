import { RETRY_POLICIES } from "@nd-factory/contracts/data";
import pRetry from "p-retry";
import { type RowCodec, rowUpdateOf } from "@nd-factory/contracts/row-codec";
import type { Db, Row, RowKey, StoredRow, TableName } from "./db.ts";
import type { Logger } from "./log.ts";
import { classifyFailure, isRetryableCancellation } from "./retry.ts";

// 条件つきの書き込み。条件と更新は構造の値（Condition・Update）で組み、DynamoDB の式の文字列へはこのモジュールの
// expressionsOf だけが書き出す（条件式の組み立てを部品の外に置かない。受け入れ条件 2）。
// 確定は writeAtomically が 1 つのトランザクションで行い、一時の失敗による取り消し（衝突と書き込みの呼びすぎ。SDK が繰り返さない）だけを p-retry で繰り返す（決定 13・17）

// DynamoDB の 1 つのトランザクションの件の上限（TransactWriteItems の仕様の値。AWS の DynamoDB の API の文書の TransactItems の上限）
export const TRANSACT_MAX_ITEMS = 100;

// 外れたときの扱い。呼び手が要素の 409 version_mismatch・state_mismatch か、前の 1 件の結果にする
export type ConflictRule = "version_mismatch" | "state_mismatch" | "return_existing" | "fail";

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
  // 条件が外れたときの組み直し（rewriteIfVersion・rewriteIfState が付ける）。writeAtomically が行を強い整合で読み直して渡し、
  // 照らした列（version か state）が読んだときのままで schema_version だけが変わった（表の移しが先に確定した）なら、
  // 読み直した行から組み直した 1 件を返す。ほかは null（本当の衝突）
  readonly rebuild?: (current: StoredRow | null) => TransactItem | null;
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

export function putIfAbsent(spec: { table: TableName; item: Row; onConflict: ConflictRule }): TransactItem {
  const { item } = spec;
  if (!Number.isInteger(item.schema_version) || item.schema_version < 1) throw new WriteSpecError("putIfAbsent: schema_version は 1 以上の整数");
  return {
    table: spec.table,
    op: "put",
    key: { pk: item.pk, sk: item.sk ?? null },
    item,
    condition: cond.notExists("pk"),
    onConflict: spec.onConflict,
  };
}

// 読んだ版（version）と読んだ行の形の版（schema_version）が同じときだけ書き、version を 1 上げる。
// schema_version も照らすのは、表の移しが version を変えずに列を足すため。移しが先に確定すると、読んだ行の列から作った set と remove は
// 移しが足した列を消さない（索引の鍵の列なら行が索引に残る）。外れたら rewriteIfVersion の組み直しで読み直す
export function updateIfVersion(spec: {
  table: TableName;
  key: RowKey;
  version: number;
  schemaVersion: number;
  set: SetColumns;
  remove?: readonly string[];
  extra?: Condition;
  onConflict: ConflictRule;
}): TransactItem {
  if (!Number.isInteger(spec.version) || spec.version < 1) throw new WriteSpecError("updateIfVersion: version は 1 以上の整数");
  if (!Number.isInteger(spec.schemaVersion) || spec.schemaVersion < 1) throw new WriteSpecError("updateIfVersion: schemaVersion は 1 以上の整数");
  const remove = spec.remove ?? [];
  checkSetAndRemove("updateIfVersion", spec.set, remove, ["pk", "sk", "version", "schema_version"]);
  const matches = [cond.eq("version", spec.version), cond.eq("schema_version", spec.schemaVersion)];
  return {
    table: spec.table,
    op: "update",
    key: spec.key,
    update: [...setActions(spec.set), { kind: "increment", path: "version", by: 1 }, ...removeActions(remove)],
    condition: cond.and(...matches, ...(spec.extra === undefined ? [] : [spec.extra])),
    onConflict: spec.onConflict,
  };
}

// version を持たず状態を条件に決まった向きへだけ書き換える行（ログインをつなぐ流れの open → verified → used）の書き換え。
// 読んだ行の形の版（schema_version）と遷移元の状態のときだけ、同じ版の set と remove を一緒に当てる。
// updateIfSchemaVersion（表の移し。書く版が from より大きい）と違い、書く版は読んだ版と同じでよい。version を持たないため上げない
export function updateIfState(spec: {
  table: TableName;
  key: RowKey;
  schemaVersion: number;
  state: { readonly column: string; readonly from: string };
  set: SetColumns;
  remove: readonly string[];
  extra?: Condition;
  onConflict: ConflictRule;
}): TransactItem {
  if (!Number.isInteger(spec.schemaVersion) || spec.schemaVersion < 1) throw new WriteSpecError("updateIfState: schemaVersion は 1 以上の整数");
  const to = spec.set["schema_version"];
  if (typeof to !== "number" || !Number.isInteger(to) || to < 1) throw new WriteSpecError("updateIfState: set の schema_version は 1 以上の整数");
  checkSetAndRemove("updateIfState", spec.set, spec.remove, ["pk", "sk", "version", "schema_version", spec.state.column]);
  const matches = [cond.exists("pk"), cond.eq("schema_version", spec.schemaVersion), cond.eq(spec.state.column, spec.state.from)];
  return {
    table: spec.table,
    op: "update",
    key: spec.key,
    update: [...setActions(spec.set), ...removeActions(spec.remove)],
    condition: cond.and(...matches, ...(spec.extra === undefined ? [] : [spec.extra])),
    onConflict: spec.onConflict,
  };
}

function keyOfRaw(what: string, raw: StoredRow): RowKey {
  const pk = raw["pk"];
  const sk = raw["sk"];
  if (typeof pk !== "string" || (sk !== undefined && typeof sk !== "string")) throw new WriteSpecError(`${what}: 読んだ行に鍵が無い`);
  return { pk, sk: sk ?? null };
}

function integerColumn(what: string, raw: StoredRow, column: string): number {
  const value = raw[column];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new WriteSpecError(`${what}: 読んだ行の ${column} は 1 以上の整数`);
  return value;
}

// 読んだ行（raw）を row（latest の形）へ書き換える、version を照らす 1 件（書き手の決まり。上書きの行）。
// set と remove は rowUpdateOf で読んだ行から作り、条件は読んだ version と schema_version。
// 移しが先に確定して schema_version だけが変わったら、writeAtomically が読み直した行から set と remove を組み直して 1 回だけ送り直す
export function rewriteIfVersion<L>(spec: { table: TableName; codec: RowCodec<L>; raw: StoredRow; row: L; extra?: Condition; onConflict: ConflictRule }, rebuildable = true): TransactItem {
  const { raw } = spec;
  const version = integerColumn("rewriteIfVersion", raw, "version");
  const schemaVersion = integerColumn("rewriteIfVersion", raw, "schema_version");
  const { set, remove } = rowUpdateOf(spec.codec, raw, spec.row);
  const item = updateIfVersion({
    table: spec.table,
    key: keyOfRaw("rewriteIfVersion", raw),
    version,
    schemaVersion,
    set,
    remove,
    ...(spec.extra === undefined ? {} : { extra: spec.extra }),
    onConflict: spec.onConflict,
  });
  if (!rebuildable) return item;
  const rebuild = (current: StoredRow | null): TransactItem | null =>
    current !== null && current["version"] === version && current["schema_version"] !== schemaVersion ? rewriteIfVersion({ ...spec, raw: current }, false) : null;
  return { ...item, rebuild };
}

// 読んだ行（raw）を row（latest の形）へ書き換える、遷移元の状態を照らす 1 件（書き手の決まり。advance_state の行）。
// 条件は読んだ schema_version と読んだ状態（stateColumn の値）。組み直しは rewriteIfVersion と同じ
export function rewriteIfState<L>(
  spec: { table: TableName; codec: RowCodec<L>; raw: StoredRow; row: L; stateColumn?: string; extra?: Condition; onConflict: ConflictRule },
  rebuildable = true,
): TransactItem {
  const { raw } = spec;
  const column = spec.stateColumn ?? "state";
  const from = raw[column];
  if (typeof from !== "string") throw new WriteSpecError(`rewriteIfState: 読んだ行の ${column} は文字列`);
  const schemaVersion = integerColumn("rewriteIfState", raw, "schema_version");
  const { set, remove } = rowUpdateOf(spec.codec, raw, spec.row);
  const item = updateIfState({
    table: spec.table,
    key: keyOfRaw("rewriteIfState", raw),
    schemaVersion,
    state: { column, from },
    set,
    // 状態の列は set で書き換える。remove には出さない（書き換え後の形が状態を持たないのは書き手の誤り）
    remove,
    ...(spec.extra === undefined ? {} : { extra: spec.extra }),
    onConflict: spec.onConflict,
  });
  if (!rebuildable) return item;
  const rebuild = (current: StoredRow | null): TransactItem | null =>
    current !== null && current[column] === from && current["schema_version"] !== schemaVersion ? rewriteIfState({ ...spec, raw: current }, false) : null;
  return { ...item, rebuild };
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

// 外れた件がどれも組み直せる（rebuild が読み直した行から 1 件を返す）なら、組み直した件へ替えた並びを返す。1 件でも組み直せなければ null
async function rebuiltItems(db: Db, items: readonly TransactItem[], outcome: WriteOutcome): Promise<TransactItem[] | null> {
  if (outcome.ok || outcome.failed.length === 0) return null;
  const next = [...items];
  for (const { index } of outcome.failed) {
    const item = items[index];
    if (item?.rebuild === undefined) return null;
    const rebuilt = item.rebuild(await db.get(item.table, item.key, true));
    if (rebuilt === null) return null;
    next[index] = rebuilt;
  }
  return next;
}

// 確定する。条件が外れ、外れた件がどれも表の移しに先を越されただけ（rebuild が組み直せる）なら、組み直して 1 回だけ送り直す
export async function writeAtomically(db: Db, items: readonly TransactItem[], log?: Logger): Promise<WriteOutcome> {
  const outcome = await commitOnce(db, items, log);
  const rebuilt = await rebuiltItems(db, items, outcome);
  if (rebuilt === null) return outcome;
  log?.info("表の移しが先に確定した行を読み直して組み直す", { tables: tablesOf(items), count: items.length });
  // 組み直した件は rebuild を持たないため、2 回目が外れればそのまま返す
  return commitOnce(db, rebuilt, log);
}

async function commitOnce(db: Db, items: readonly TransactItem[], log?: Logger): Promise<WriteOutcome> {
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
