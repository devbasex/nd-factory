import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  type Field,
  type RDSDataClient,
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

function parseRecords(formatted: string | undefined): Row[] {
  if (formatted === undefined) return [];
  const parsed: unknown = JSON.parse(formatted);
  if (!Array.isArray(parsed)) throw new Error("Data API の行が配列でない");
  return parsed.map((r: unknown) => toRow(r));
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

// SqlExecutor の RDS Data API の実装。45 秒で終わらない文は Data API が取り消す（continueAfterTimeout を偽にする）
export function createDataApiExecutor(opts: {
  client: RDSDataClient;
  resourceArn: string;
  secretArn: string;
  retry?: Partial<DataApiRetry>;
}): SqlExecutor {
  const { client, resourceArn, secretArn } = opts;
  const retry = resolveRetry(opts.retry);

  return {
    async execute(sql, params, o) {
      const command = new ExecuteStatementCommand({
        resourceArn,
        secretArn,
        database: o.database,
        sql,
        ...(params && params.length > 0 ? { parameters: toParameters(params) } : {}),
        ...(o.transactionId === undefined ? {} : { transactionId: o.transactionId }),
        formatRecordsAs: "JSON",
        continueAfterTimeout: false,
      });
      // トランザクションの中の文は繰り返さない。呼ぶ側が rollback して失敗にする
      const out =
        o.transactionId === undefined ? await withResumeWait(() => client.send(command), retry) : await client.send(command);
      return parseRecords(out.formattedRecords);
    },

    async begin(o) {
      const out = await withResumeWait(
        () => client.send(new BeginTransactionCommand({ resourceArn, secretArn, database: o.database })),
        retry,
      );
      if (!out.transactionId) throw new Error("BeginTransaction が transactionId を返さなかった");
      return out.transactionId;
    },

    async commit(transactionId) {
      await client.send(new CommitTransactionCommand({ resourceArn, secretArn, transactionId }));
    },

    async rollback(transactionId) {
      await client.send(new RollbackTransactionCommand({ resourceArn, secretArn, transactionId }));
    },
  };
}
