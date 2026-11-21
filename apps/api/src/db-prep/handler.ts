import {
  type DbPrepFailureReason,
  type DbPrepInvocation,
  type DbPrepOutcome,
  PROGRESS_DB_IDENT_SHAPE,
  dbPrepInvocation,
} from "@nd-factory/contracts/db-prep";
import pino from "pino";
import { claimPrepRun } from "./prep-run.ts";
import { type ProjectIdent, checkIsolationGuard, claimBinding, provisionProject } from "./provision.ts";
import { rotateRole, terminateRoleConnections } from "./rotate.ts";
import { DataApiUnavailableError, type SqlExecutor } from "./sql-executor.ts";

// 口がプロジェクトの行の 1 回の強い整合の読みから返す、データベースと役割と秘密の器の名前と、結んだ版の ID と、
// 同じ行の用意の ID と差し替えの番号（差し替えをまだしていない行は null）。版の ID を、読んだ時点の用意の ID と番号に結び付けて照らす
export type PrepTarget = {
  database: string;
  role: string;
  secret: string;
  secretVersion: string;
  prepId: string;
  rotationSeq: number | null;
};

// 終わりの記録の口。実装は #6（プロジェクトのモジュールの操作）。isCurrent はプロジェクトの表をプロジェクトの ID の主キーで
// 強い整合で読み（認可もそのプロジェクトに限る）、その行の用意の ID が渡した値と同じかを返す。readTarget は同じ読み方で
// 1 回読み、名前と版の ID を、同じ行の用意の ID と差し替えの番号と一緒に返す。record は用意の ID・
// 差し替えの番号・版の ID が今の値と合うときだけ書く条件つきの書き込みで、合わなければ書かずに mismatch を返す
// 差し替えで保留を下ろせる結果は applied か recorded_seq = n の rotation_superseded だけ。recorded_seq > n の
// rotation_superseded と failed は、条件が合っても保留を残す（前者は結んだ版を AWSCURRENT へ移していない）
export type PrepCompletionPort = {
  isCurrent(projectId: string, prepId: string): Promise<boolean>;
  readTarget(projectId: string): Promise<PrepTarget>;
  record(inv: DbPrepInvocation, outcome: DbPrepOutcome, secretVersion: string): Promise<"recorded" | "mismatch">;
};

// 関数の誤りで止まった段。ログと投げる例外に載せる
// terminate は古い接続を切った後も残りを読んだ段（I17。終わりを記さずに落ち、見回りが I22 で呼び直す）
export type PrepStage = "is_current" | "claim" | "read_target" | "read_password" | "terminate" | "promote" | "record";

// ログに出す項目はこれだけ。値はどれも決まった形の ID・種類・コード・数で、名前・パスワード・URL・SQL の文を持たない
export type PrepLogFields = {
  prep_id?: string;
  kind?: DbPrepInvocation["kind"];
  result?: DbPrepOutcome["result"] | "not_current" | "duplicate_delivery";
  reason?: DbPrepFailureReason;
  duration_ms?: number;
  record_result?: "recorded" | "mismatch";
  stage?: PrepStage;
  err_name?: string;
  sqlstate?: string;
};

// メッセージは定数だけにし、値を埋め込まない
export const PREP_LOG_MESSAGES = Object.freeze({
  invalidInvocation: "呼び出しが形に合わない",
  notCurrent: "用意の ID が今の値でないため何もしない",
  duplicateDelivery: "同じ用意の ID の 2 つ目の配信のため何もしない",
  finished: "用意の結果を終わりの記録の口へ渡した",
  mismatch: "終わりの記録が今の値と合わず書かれなかった",
  functionError: "終わりを記さずに止まった",
} as const);

export type PrepLogMessage = (typeof PREP_LOG_MESSAGES)[keyof typeof PREP_LOG_MESSAGES];

export type PrepLogger = {
  info(fields: PrepLogFields, msg: PrepLogMessage): void;
  warn(fields: PrepLogFields, msg: PrepLogMessage): void;
  error(fields: PrepLogFields, msg: PrepLogMessage): void;
};

// 2 つ目の守り。出す項目を決まった形で組む（1 つ目の守り）のに漏れて渡った値を、キーごと外す
export const PREP_LOG_REDACT_PATHS: readonly string[] = [
  "password",
  "*.password",
  "url",
  "*.url",
  "secret",
  "*.secret",
  "SecretString",
  "*.SecretString",
  "database",
  "*.database",
  "role",
  "*.role",
  "sql",
  "*.sql",
  "err",
  "*.err",
  "message",
  "stack",
  "*.message",
  "*.stack",
];

// 1 行の JSON を標準出力（関数のログの群）へ出す。テストは書き先を渡す
export function createPrepLogger(destination?: pino.DestinationStream): pino.Logger {
  const options: pino.LoggerOptions = { redact: { paths: [...PREP_LOG_REDACT_PATHS], remove: true } };
  return destination === undefined ? pino(options) : pino(options, destination);
}

// 関数の誤りで止まったときに投げる。元の例外の message と stack には SQL の文・名前・URL が入りうるため繋がず、
// 段と元の例外の名前だけを持つ（Lambda の実行環境は投げられた例外の文をログの群へ書く）
export class DbPrepFunctionError extends Error {
  override name = "DbPrepFunctionError";
  readonly stage: PrepStage;
  readonly errName: string;

  constructor(stage: PrepStage, errName: string) {
    super(`DB の用意の関数が終わりを記さずに止まった（段 ${stage}・${errName}）`);
    this.stage = stage;
    this.errName = errName;
  }
}

export type PrepDeps = {
  sql: SqlExecutor;
  completion: PrepCompletionPort;
  readPassword: (secret: string, versionId: string) => Promise<string>;
  promote: (secret: string, versionId: string) => Promise<void>;
  logger: PrepLogger;
  // 所要時間と、残る接続を待つ期限の時計（既定の本番は performance.now）
  now: () => number;
  // 残る接続を待つ間の眠り。テストは差し替えて時計を進める
  sleep?: (ms: number) => Promise<void>;
};

// 例外から出してよいのは、識別子の形の名前と SQLSTATE の形のコードだけ
function errName(e: unknown): string {
  const name = e instanceof Error ? e.name : undefined;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Unknown";
}

function sqlstate(e: unknown): string | undefined {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

function errFields(e: unknown): Pick<PrepLogFields, "err_name" | "sqlstate"> {
  const state = sqlstate(e);
  return state === undefined ? { err_name: errName(e) } : { err_name: errName(e), sqlstate: state };
}

// 口が返した名前は、SQL を打つ前に形を照らす。例外の文に名前を入れない
function assertTarget(target: PrepTarget): void {
  if (!PROGRESS_DB_IDENT_SHAPE.test(target.database) || !PROGRESS_DB_IDENT_SHAPE.test(target.role)) {
    throw new Error("口が返したデータベースか役割の名前が形に合わない");
  }
  if (target.secret.length === 0 || target.secretVersion.length === 0) throw new Error("口が返した秘密の器か版の ID が空");
}

type Ran = { outcome: DbPrepOutcome; error?: unknown };

// SQL の失敗として記さず、関数の誤りとして終わりを記さずに止める段の失敗
class StageFailure extends Error {
  override name = "StageFailure";
  readonly stage: PrepStage;
  readonly inner: unknown;

  constructor(stage: PrepStage, inner: unknown) {
    super("段の失敗");
    this.stage = stage;
    this.inner = inner;
  }
}

// 古い接続が残った（I17）。値を持たない
class ConnectionsRemainError extends Error {
  override name = "ConnectionsRemainError";
}

function failed(reason: DbPrepFailureReason, error?: unknown): Ran {
  return { outcome: { result: "failed", reason }, error };
}

function sqlFailure(e: unknown): Ran {
  return failed(e instanceof DataApiUnavailableError ? "data_api_unavailable" : "sql_failed", e);
}

type SessionWait = { now: () => number; sleep?: (ms: number) => Promise<void> };

async function runCreate(sql: SqlExecutor, project: ProjectIdent, password: string, wait: SessionWait): Promise<Ran> {
  try {
    if ((await claimBinding(sql, project)) === "conflict") return failed("guard_conflict");
    if ((await checkIsolationGuard(sql, project)) === "conflict") return failed("guard_conflict");
    await provisionProject(sql, { ...project, password }, wait);
    return { outcome: { result: "applied" } };
  } catch (e) {
    return sqlFailure(e);
  }
}

// 差し替え。古い接続の残りが 0 と読んだら、差し替えの鎖と番号 n の読みを持ったまま promote で結んだ版へ AWSCURRENT を移し、
// その後に鎖を放す（重なった古い呼び出しが、新しい呼び出しの移した版を古い版へ戻せないように）。
// 残りが 1 以上なら終わりを記さずに落ちる（I17）。promote の失敗も SQL の失敗として記さずに落ちる
async function runRotate(
  sql: SqlExecutor,
  project: ProjectIdent,
  password: string,
  seq: number,
  wait: SessionWait,
  promote: () => Promise<void>,
): Promise<Ran> {
  let promoteFailure: { error: unknown } | undefined;
  const whileLocked = async (): Promise<void> => {
    try {
      await promote();
    } catch (e) {
      promoteFailure = { error: e };
      throw e;
    }
  };
  let rotated: Awaited<ReturnType<typeof rotateRole>>;
  let cut: Awaited<ReturnType<typeof terminateRoleConnections>>;
  try {
    rotated = await rotateRole(sql, { ...project, password, seq });
    if (rotated.kind === "superseded_greater") return { outcome: { result: "rotation_superseded", recorded_seq: rotated.recorded } };
    cut = await terminateRoleConnections(sql, project.role, seq, { ...wait, whileLocked });
  } catch (e) {
    if (promoteFailure !== undefined) throw new StageFailure("promote", promoteFailure.error);
    return sqlFailure(e);
  }
  if (cut.kind === "superseded_greater") return { outcome: { result: "rotation_superseded", recorded_seq: cut.recorded } };
  if (cut.remaining > 0) throw new StageFailure("terminate", new ConnectionsRemainError("古い接続が残った"));
  return rotated.kind === "applied"
    ? { outcome: { result: "applied" } }
    : { outcome: { result: "rotation_superseded", recorded_seq: rotated.recorded } };
}

// 呼び出しを照らし、用意の ID を読み直し、重複の配信を除き、用意か差し替えを打って、結果を終わりの記録の口へ渡す
export function createDbPrepHandler(deps: PrepDeps): (event: unknown) => Promise<void> {
  const { sql, completion, logger } = deps;
  const wait: SessionWait = { now: deps.now, sleep: deps.sleep };

  return async function handle(event: unknown): Promise<void> {
    const started = deps.now();
    const parsed = dbPrepInvocation.safeParse(event);
    if (!parsed.success) {
      // 呼び出しの値は出さない（形に合わない呼び出しは何を持つか分からない）
      logger.error({}, PREP_LOG_MESSAGES.invalidInvocation);
      return;
    }
    const inv = parsed.data;
    const base = { prep_id: inv.prep_id, kind: inv.kind };
    const elapsed = () => Math.max(0, Math.round(deps.now() - started));
    let stage: PrepStage = "is_current";
    try {
      if (!(await completion.isCurrent(inv.project_id, inv.prep_id))) {
        logger.info({ ...base, result: "not_current" }, PREP_LOG_MESSAGES.notCurrent);
        return;
      }
      // 受け取りの段の失敗（再開の待ちの尽き・確定の応答が届かない）は、受け取れたかが分からないため終わりを記さない
      stage = "claim";
      if ((await claimPrepRun(sql, inv.prep_id)) === "duplicate") {
        logger.info({ ...base, result: "duplicate_delivery" }, PREP_LOG_MESSAGES.duplicateDelivery);
        return;
      }
      stage = "read_target";
      const target = await completion.readTarget(inv.project_id);
      assertTarget(target);
      // isCurrent の後に用意の ID か番号が替わり、行が次の用意の版を結んでいれば、その版を読まずに終える
      // （古い呼び出しが新しい版を DB へ書く前に AWSCURRENT へ移さないように）
      if (target.prepId !== inv.prep_id || (inv.kind === "rotate" && target.rotationSeq !== inv.rotation_seq)) {
        logger.info({ ...base, result: "not_current" }, PREP_LOG_MESSAGES.notCurrent);
        return;
      }
      stage = "read_password";
      const password = await deps.readPassword(target.secret, target.secretVersion);

      const project: ProjectIdent = { projectId: inv.project_id, database: target.database, role: target.role };
      const promote = () => deps.promote(target.secret, target.secretVersion);
      // 終わりを記す前に、結んだ版に AWSCURRENT が付いていることを確かめる。移すのは DB にその版のパスワードが書かれたと
      // 分かる結果だけ（作るなら applied、差し替えなら applied か記した番号 = n の rotation_superseded。差し替えは鎖の中で移す）
      let ran: Ran;
      if (inv.kind === "create") {
        ran = await runCreate(sql, project, password, wait);
        if (ran.outcome.result === "applied") {
          stage = "promote";
          await promote();
        }
      } else {
        ran = await runRotate(sql, project, password, inv.rotation_seq, wait, promote);
      }
      stage = "record";
      const recorded = await completion.record(inv, ran.outcome, target.secretVersion);

      const fields: PrepLogFields = {
        ...base,
        result: ran.outcome.result,
        ...(ran.outcome.result === "failed" ? { reason: ran.outcome.reason } : {}),
        ...(ran.error === undefined ? {} : errFields(ran.error)),
        duration_ms: elapsed(),
        record_result: recorded,
      };
      if (recorded === "mismatch") {
        logger.warn(fields, PREP_LOG_MESSAGES.mismatch);
      } else if (ran.outcome.result === "failed") {
        logger.error(fields, PREP_LOG_MESSAGES.finished);
      } else {
        logger.info(fields, PREP_LOG_MESSAGES.finished);
      }
    } catch (caughtError) {
      // 自動の再試行は 0 回で、見回りが期限の後に扱う
      const failedStage = caughtError instanceof StageFailure ? caughtError.stage : stage;
      const e = caughtError instanceof StageFailure ? caughtError.inner : caughtError;
      logger.error({ ...base, stage: failedStage, ...errFields(e), duration_ms: elapsed() }, PREP_LOG_MESSAGES.functionError);
      throw new DbPrepFunctionError(failedStage, errName(e));
    }
  };
}
