import type { Row, SqlExecutor, SqlParam } from "../../src/db-prep/sql-executor.ts";

export type SqlCall =
  | { kind: "execute"; sql: string; params: SqlParam[] | undefined; database: string; transactionId: string | undefined }
  | { kind: "begin"; database: string }
  | { kind: "commit"; transactionId: string }
  | { kind: "rollback"; transactionId: string };

// SqlExecutor の作り物。呼ばれた順に残し、文ごとの答えと失敗を差し込める（DB には届かない）
export class FakeSqlExecutor implements SqlExecutor {
  calls: SqlCall[] = [];
  // 文に返す行。返さなければ空の行
  respond: (sql: string, params: SqlParam[] | undefined) => Row[] = () => [];
  // 呼び出しの前に投げさせる失敗。返さなければ通す
  failOn: (call: SqlCall) => Error | undefined = () => undefined;
  private seq = 0;

  private record(call: SqlCall): void {
    this.calls.push(call);
    const failure = this.failOn(call);
    if (failure) throw failure;
  }

  async execute(sql: string, params: SqlParam[] | undefined, opts: { database: string; transactionId?: string }): Promise<Row[]> {
    this.record({ kind: "execute", sql, params, database: opts.database, transactionId: opts.transactionId });
    const rows = this.respond(sql, params);
    // 引数の値を記録しない設定の確かめ（role-password.ts）は、答えを差し込まなければ 0 で pgAudit が無いと返す
    if (rows.length === 0 && sql.includes("current_setting('log_parameter_max_length')")) {
      return [{ normal: "0", on_error: "0", audit_log: null, audit_parameter: null }];
    }
    return rows;
  }

  async begin(opts: { database: string }): Promise<string> {
    this.record({ kind: "begin", database: opts.database });
    this.seq += 1;
    return `tx-${this.seq}`;
  }

  async commit(transactionId: string): Promise<void> {
    this.record({ kind: "commit", transactionId });
  }

  async rollback(transactionId: string): Promise<void> {
    this.record({ kind: "rollback", transactionId });
  }

  statements(): string[] {
    return this.calls.flatMap((c) => (c.kind === "execute" ? [c.sql] : []));
  }
}
