import {
  BeginTransactionCommand,
  type ColumnMetadata,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  type Field,
  RDSDataClient,
  type RDSDataClientConfig,
  RollbackTransactionCommand,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";
import pRetry, { AbortError } from "p-retry";

export type SqlValue = string | number | boolean | null;

// 文の中の :name に結ぶ値。2 つの実装が同じ文と同じ引数を受ける
export type SqlParam = { name: string; value: SqlValue };

// 読む列はどれも SQL の側で ::int・::text・::boolean に型を決める。時刻や入れ子の値は行に載せない
export type Row = Record<string, SqlValue>;

// 用意と差し替えの SQL を打つ口。transactionId の無い execute は自動の確定で打つ
export type SqlExecutor = {
  execute(sql: string, params: SqlParam[] | undefined, opts: { database: string; transactionId?: string }): Promise<Row[]>;
  begin(opts: { database: string }): Promise<string>;
  commit(transactionId: string): Promise<void>;
  rollback(transactionId: string): Promise<void>;
};

// 管理の役割が持つデータベース。nd_prep のスキーマはここに置く
export const ADMIN_DATABASE = "postgres";

// 再開の待ちとして繰り返す例外の名前。ほかの例外は 1 回で投げる
// 繰り返してよい前提（推測。#44 で確かめる）: DatabaseResumingException の時は、文が DB で打たれていない。
// 文書は「A request was cancelled because the Aurora Serverless v2 DB instance was paused」と、一時停止のため要求が
// 取り消されたことだけを言い、文が DB へ届いていないことまでは書いていない。止まった DB が文を受けられないことからの推測である。
// 推測が外れて打たれた文を打ち直すと、CREATE DATABASE・CREATE ROLE のような繰り返せない文は「既にある」で落ちる。
// 用意の手順は既にあれば作らない作りで何度打っても同じ結果になるため（docs/design/data.md の用意の手順）、外れたときに起きるのは
// その回の sql_failed で、次の開始か呼び直しが同じ手順を打ち直して終える（2 重の作成や壊れた状態は残らない）。
// 届いた後の失敗（通信の切れ・時間切れ・5xx）は打たれたかが分からないため、ここへ足さない。SDK の側の再試行も止める（createRdsDataClient）
// https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html#API_ExecuteStatement_Errors
export const RESUME_WAIT_ERRORS: readonly string[] = ["DatabaseResumingException"];

export const DATA_API_RETRY_DEFAULTS = { attempts: 12, delayMs: 5_000, deadlineMs: 60_000 } as const;

export type DataApiRetry = { attempts: number; delayMs: number; deadlineMs: number; now: () => number };

// 再開の待ちが回数か期限で尽きた。文の中身は持たず、試した回数と最後の例外だけを持つ
export class DataApiUnavailableError extends Error {
  override name = "DataApiUnavailableError";
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(`Data API の再開の待ちが尽きた（${attempts} 回試した）`, { cause });
    this.attempts = attempts;
  }
}

function isResumeWait(e: unknown): boolean {
  return e instanceof Error && RESUME_WAIT_ERRORS.includes(e.name);
}

// 行の値を 2 つの実装で同じ形にそろえる。型の決まらない列は SQL を直すべきなので投げる
export function toRow(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("行が名前つきの列の組でない");
  const row: Row = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      row[key] = v;
    } else {
      throw new Error(`列 ${key} の型が決まっていない（SQL の側で ::int・::text・::boolean にする）`);
    }
  }
  return row;
}

function toField(value: SqlValue): Field {
  if (value === null) return { isNull: true };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
}

function toParameters(params: SqlParam[]): SqlParameter[] {
  return params.map((p) => ({ name: p.name, value: toField(p.value) }));
}

function fromField(field: Field, column: string): SqlValue {
  if (field.isNull === true) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  throw new Error(`列 ${column} の型が決まっていない（SQL の側で ::int・::text・::boolean にする）`);
}

// 行は records と列の名前（columnMetadata）から組む。formatRecordsAs の JSON は SELECT にだけ効き、
// INSERT … RETURNING の行を返さないため使わない
function parseRecords(records: Field[][] | undefined, columns: ColumnMetadata[] | undefined): Row[] {
  if (records === undefined || records.length === 0) return [];
  if (columns === undefined) throw new Error("Data API が列の名前を返さなかった");
  const names = columns.map((c, i) => {
    const name = c.label ?? c.name;
    if (!name) throw new Error(`${i} 番目の列に名前が無い`);
    return name;
  });
  return records.map((record) => {
    if (record.length !== names.length) throw new Error("Data API の行と列の数が合わない");
    const row: Row = {};
    record.forEach((field, i) => {
      const name = names[i]!;
      row[name] = fromField(field, name);
    });
    return row;
  });
}

function resolveRetry(retry: Partial<DataApiRetry> | undefined): DataApiRetry {
  const r = {
    ...DATA_API_RETRY_DEFAULTS,
    // p-retry が maxRetryTime を測るのと同じ時計
    now: () => performance.now(),
    ...retry,
  };
  if (!Number.isInteger(r.attempts) || r.attempts < 1) throw new Error("試す回数は 1 以上の整数");
  if (!(r.delayMs >= 0) || !(r.deadlineMs > 0)) throw new Error("待ちは 0 以上、期限は 0 より大きい");
  return r;
}

// 再開の待ちだけを繰り返す。期限は呼び出しの最初の試行の始めから測る
async function withResumeWait<T>(op: () => Promise<T>, retry: DataApiRetry): Promise<T> {
  let start: number | undefined;
  let tried = 0;
  let last: unknown;
  try {
    return await pRetry(
      async () => {
        const t = retry.now();
        if (start === undefined) {
          start = t;
        } else if (retry.deadlineMs - (t - start) <= 0) {
          // p-retry は待ちを残りへ切り詰めた後、期限を照らさずに次の試行を呼ぶ。打たずに止める
          throw new AbortError(new DataApiUnavailableError(tried, last));
        }
        tried += 1;
        try {
          return await op();
        } catch (e) {
          if (isResumeWait(e)) {
            last = e;
            throw e;
          }
          throw new AbortError(e instanceof Error ? e : new Error("Error でない値が投げられた", { cause: e }));
        }
      },
      {
        retries: retry.attempts - 1,
        factor: 1,
        minTimeout: retry.delayMs,
        maxTimeout: retry.delayMs,
        randomize: false,
        maxRetryTime: retry.deadlineMs,
      },
    );
  } catch (e) {
    if (isResumeWait(e)) throw new DataApiUnavailableError(tried, e);
    throw e;
  }
}

// createRdsDataClient が作ったクライアントと、作った時の再試行の戦略。createDataApiExecutor はここに有るクライアントだけを受ける
const SINGLE_ATTEMPT_CLIENTS = new WeakMap<RDSDataClient, RDSDataClient["config"]["retryStrategy"]>();

// createRdsDataClient が SDK へ渡す設定の項目。これ以外は型の外から渡されても捨てる。除く項目を数える作りでは、
// extensions（configure から setRetryStrategy を呼べる）のように再試行の戦略を差し替える経路を漏らしうるため、渡す項目を数える
export type RdsDataClientOptions = Pick<RDSDataClientConfig, "region" | "credentials" | "endpoint" | "requestHandler">;

// Data API のクライアント。SDK の自動の再試行を止める（maxAttempts: 1・SDK の既定の再試行の戦略）。SDK は通信の障害や
// 絞りで文や commit を打ち直し、初回が確定して応答だけが失われると、打ち直しの失敗が返って確定したかが分からなくなる。
// 再試行は再開の待ちだけをこの実装が受け持つ。retryStrategy・retryMode・maxAttempts・extensions などは SDK へ渡さない
export function createRdsDataClient(options: RdsDataClientOptions = {}): RDSDataClient {
  const { region, credentials, endpoint, requestHandler } = options;
  const client = new RDSDataClient({
    ...(region === undefined ? {} : { region }),
    ...(credentials === undefined ? {} : { credentials }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(requestHandler === undefined ? {} : { requestHandler }),
    maxAttempts: 1,
  });
  SINGLE_ATTEMPT_CLIENTS.set(client, client.config.retryStrategy);
  return client;
}

// 渡されたクライアントが SDK の再試行を止めているかを、最初の要求の前に確かめる。maxAttempts だけを読むと、
// maxAttempts: 1 と独自の retryStrategy を持つクライアントが通り、その戦略が文や commit を打ち直せる。
// そのため作る経路を createRdsDataClient に限り、そこで作っていないクライアントは受けない。作った後に config の
// 戦略を差し替えたクライアントも受けない（再試行の層は要求のたびに config から戦略を読む）
async function assertSingleAttempt(client: RDSDataClient): Promise<void> {
  if (!SINGLE_ATTEMPT_CLIENTS.has(client)) {
    throw new Error("Data API のクライアントは createRdsDataClient で作る（SDK の再試行を止める）");
  }
  if (client.config.retryStrategy !== SINGLE_ATTEMPT_CLIENTS.get(client)) {
    throw new Error("createRdsDataClient で作った後に再試行の戦略が差し替えられた（SDK の再試行を止める）");
  }
  const max = await client.config.maxAttempts();
  if (max !== 1) throw new Error(`Data API のクライアントは SDK の再試行を止める（maxAttempts が ${max}）`);
}

// SqlExecutor の RDS Data API の実装。45 秒で終わらない文は Data API が取り消す（continueAfterTimeout を偽にする）
export function createDataApiExecutor(opts: {
  client: RDSDataClient;
  resourceArn: string;
  secretArn: string;
  retry?: Partial<DataApiRetry>;
}): SqlExecutor {
  const { client, resourceArn, secretArn } = opts;
  const retry = resolveRetry(opts.retry);
  let checked: Promise<void> | undefined;
  const send: RDSDataClient["send"] = async (command: Parameters<RDSDataClient["send"]>[0]) => {
    checked ??= assertSingleAttempt(client);
    await checked;
    return client.send(command);
  };

  return {
    async execute(sql, params, o) {
      const command = new ExecuteStatementCommand({
        resourceArn,
        secretArn,
        database: o.database,
        sql,
        ...(params && params.length > 0 ? { parameters: toParameters(params) } : {}),
        ...(o.transactionId === undefined ? {} : { transactionId: o.transactionId }),
        includeResultMetadata: true,
        continueAfterTimeout: false,
      });
      // トランザクションの外の文は再開の待ちだけを打ち直す（文は打たれていないと推測する。RESUME_WAIT_ERRORS の前提）。
      // トランザクションの中の文は繰り返さない。呼ぶ側が rollback して失敗にする
      const out = o.transactionId === undefined ? await withResumeWait(() => send(command), retry) : await send(command);
      return parseRecords(out.records, out.columnMetadata);
    },

    async begin(o) {
      const out = await withResumeWait(
        () => send(new BeginTransactionCommand({ resourceArn, secretArn, database: o.database })),
        retry,
      );
      if (!out.transactionId) throw new Error("BeginTransaction が transactionId を返さなかった");
      return out.transactionId;
    },

    async commit(transactionId) {
      await send(new CommitTransactionCommand({ resourceArn, secretArn, transactionId }));
    },

    async rollback(transactionId) {
      await send(new RollbackTransactionCommand({ resourceArn, secretArn, transactionId }));
    },
  };
}
