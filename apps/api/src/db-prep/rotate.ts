import { PROGRESS_DB_IDENT_SHAPE } from "@nd-factory/contracts/db-prep";
import { escapeIdentifier, escapeLiteral } from "pg";
import type { ProjectIdent } from "./provision.ts";
import { scramVerifier } from "./scram.ts";
import { ADMIN_DATABASE, type SqlExecutor, type SqlParam } from "./sql-executor.ts";

// 差し替えの結果。recorded は確定の後に記された番号（applied なら渡した番号）
export type RotateResult = { kind: "applied" | "superseded_equal" | "superseded_greater"; recorded: number };

export type TerminateResult = { kind: "done"; remaining: number } | { kind: "superseded_greater"; recorded: number };

export type TerminateOptions = {
  // 切りと読み直しが共にする期限と、読み直しの間隔（既定 15,000 と 500。provisionProject の手順の 5 とそろえる）
  deadlineMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// 番号は表の integer の列に入る
const MAX_SEQ = 2_147_483_647;

// 名前と番号は形を照らしてから SQL に載せる。例外の文に名前を入れない（ログへ流れうるため）
function assertRole(role: string): void {
  if (!PROGRESS_DB_IDENT_SHAPE.test(role)) throw new Error("役割の名前が形に合わない");
}

function assertSeq(seq: number): void {
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) throw new Error("差し替えの番号は 1 以上の整数");
}

// 同じ役割の差し替えどうしを直列にする鎖。rotateRole と terminateRoleConnections の両方が取る
const ROTATE_LOCK = "SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext('nd-rotate:' || CAST(:role_name AS text)))";
// 表の有無は 2 回見る（prep-run.ts と同じ）: 鎖なしで見て、無ければスキーマの鎖を取ってからカタログをその文の写しで読み直す。
// 取る順は差し替えの鎖 → スキーマの鎖で、スキーマの鎖を持って差し替えの鎖を待つ処理は無いため、互いに待ち合わない
const SCHEMA_LOCK = "SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext('nd-prep:schema'))";
const TABLE_PRESENT = "SELECT to_regclass('nd_prep.rotation_seq') IS NOT NULL AS present";
const TABLE_PRESENT_FRESH =
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace" +
  " WHERE n.nspname = 'nd_prep' AND c.relname = 'rotation_seq') AS present";
const SCHEMA_PRESENT = "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'nd_prep') AS present";
const CREATE_SCHEMA = "CREATE SCHEMA nd_prep";
const REVOKE_SCHEMA = "REVOKE ALL ON SCHEMA nd_prep FROM PUBLIC";
// 役割ごとに 1 行で、消さない。old_conn_cutoff は古い接続を切る境で、パスワードを書くたびに空へ戻す
const CREATE_TABLE =
  "CREATE TABLE nd_prep.rotation_seq (role_name text PRIMARY KEY, seq integer NOT NULL," +
  " written_at timestamptz NOT NULL, old_conn_cutoff timestamptz)";
const REVOKE_TABLE = "REVOKE ALL ON nd_prep.rotation_seq FROM PUBLIC";
const READ_SEQ =
  "SELECT seq::int AS recorded, (old_conn_cutoff IS NOT NULL) AS cutoff_recorded FROM nd_prep.rotation_seq WHERE role_name = :role_name";
// Data API は整数を longValue（bigint）で渡すため、SQL の側で int に決める
const WRITE_SEQ =
  "INSERT INTO nd_prep.rotation_seq (role_name, seq, written_at, old_conn_cutoff)" +
  " VALUES (:role_name, CAST(:seq AS int), clock_timestamp(), NULL)" +
  " ON CONFLICT (role_name) DO UPDATE SET seq = EXCLUDED.seq, written_at = EXCLUDED.written_at, old_conn_cutoff = NULL";
// 境の時刻は、パスワードを書いたトランザクションの確定の後に、最初に切りの段へ来た呼び出しが記す。記されていれば記し直さない
const RECORD_CUTOFF =
  "UPDATE nd_prep.rotation_seq SET old_conn_cutoff = clock_timestamp()" +
  " WHERE role_name = :role_name AND seq = CAST(:seq AS int) AND old_conn_cutoff IS NULL";
// 統計の写しを捨てる。トランザクションの中の pg_stat_activity は、最初に読んだ時点の写しを返し続けるため（LIB21）。
// 関数を FROM に置き、void の列を行に載せない
const CLEAR_SNAPSHOT = "SELECT 1::int AS cleared FROM pg_stat_clear_snapshot()";
// 切る相手: その役割の接続のうち、境の時刻より前に始まったもの（確定の前に古いパスワードで認証したものだけ）
const OLD_SESSIONS =
  " FROM pg_catalog.pg_stat_activity s JOIN nd_prep.rotation_seq r ON r.role_name = s.usename::text" +
  " WHERE r.role_name = :role_name AND s.pid <> pg_backend_pid() AND s.backend_start < r.old_conn_cutoff";
// 終了のシグナルを 1 つの文で送るだけで待たない（timeout 0。0 より大きい待ちは呼び出しごとに掛かり、積み重なる。LIB22）
const SIGNAL_OLD = `SELECT count(*) FILTER (WHERE pg_terminate_backend(s.pid, 0))::int AS signalled${OLD_SESSIONS}`;
// 起動の途中の接続は pg_stat_activity に載らない（PostgreSQL 16 は認証と起動の処理を終えてから載せる）。SCRAM の認証は
// 交換の始めに検証子を読むため、確定の前に読み始めた接続は、確定の後に古いパスワードで認証を終えうる。
// 起動の処理は認証の前に取引を始めて自分の仮想の取引番号の鎖を取り、pg_stat_activity に載った後に確定して放す。
// そのため確定の後のある時点で鎖を持つ pid の集まりは、その時点で古い検証子を持って起動の途中にある接続をすべて含む
const VXID_HOLDERS =
  "SELECT coalesce(string_agg(DISTINCT l.pid::text, ','), '')::text AS holders FROM pg_catalog.pg_locks l" +
  " WHERE l.locktype = 'virtualxid' AND l.granted AND l.pid IS NOT NULL AND l.pid <> pg_backend_pid()";
// 境の時刻より前に始まって載っている接続の数と、起動の途中と見た pid（:starting。コンマ区切り）のうちまだ載っていないもの。
// 2 つは同じ文で同じ写しを読む。鎖の読みはこの文より前に打つ（鎖を放す前に必ず載るため、後で読む写しに載るか終わっている）
const REMAINING_OLD =
  `SELECT (SELECT count(*)::int${OLD_SESSIONS}) AS remaining,` +
  " (SELECT coalesce(string_agg(u.pid::text, ','), '') FROM unnest(string_to_array(CAST(:starting AS text), ',')::int[]) AS u(pid)" +
  " WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid = u.pid))::text AS starting";

function pidList(raw: unknown, what: string): string[] {
  if (typeof raw !== "string" || !/^(\d+(,\d+)*)?$/.test(raw)) throw new Error(`${what}を読めなかった`);
  return raw === "" ? [] : raw.split(",");
}

type TxOpts = { database: string; transactionId: string };

// 1 つのトランザクションで打つ。途中で投げたら巻き戻して元の失敗を投げ、確定が投げたらそのまま投げる
async function inTransaction<T>(sql: SqlExecutor, fn: (opts: TxOpts) => Promise<T>): Promise<T> {
  const tx = await sql.begin({ database: ADMIN_DATABASE });
  let out: T;
  try {
    out = await fn({ database: ADMIN_DATABASE, transactionId: tx });
  } catch (e) {
    // 巻き戻しの失敗は元の失敗より後の出来事で、呼ぶ側は元の失敗で扱う。Data API のトランザクションは無通信で巻き戻る
    await sql.rollback(tx).catch(() => undefined);
    throw e;
  }
  await sql.commit(tx);
  return out;
}

async function present(sql: SqlExecutor, stmt: string, opts: TxOpts): Promise<boolean> {
  const [row] = await sql.execute(stmt, undefined, opts);
  return row?.present === true;
}

async function ensureTable(sql: SqlExecutor, opts: TxOpts): Promise<void> {
  if (await present(sql, TABLE_PRESENT, opts)) return;
  await sql.execute(SCHEMA_LOCK, undefined, opts);
  if (await present(sql, TABLE_PRESENT_FRESH, opts)) return;
  if (!(await present(sql, SCHEMA_PRESENT, opts))) {
    await sql.execute(CREATE_SCHEMA, undefined, opts);
    await sql.execute(REVOKE_SCHEMA, undefined, opts);
  }
  await sql.execute(CREATE_TABLE, undefined, opts);
  await sql.execute(REVOKE_TABLE, undefined, opts);
}

// 記した番号と境の時刻の有無。行が無ければ undefined。読めない形なら投げる
async function readSeq(sql: SqlExecutor, params: SqlParam[], opts: TxOpts): Promise<{ recorded: number; cutoffRecorded: boolean } | undefined> {
  const rows = await sql.execute(READ_SEQ, params, opts);
  const [row] = rows;
  if (row === undefined) return undefined;
  if (rows.length !== 1 || typeof row.recorded !== "number" || typeof row.cutoff_recorded !== "boolean") {
    throw new Error("差し替えの番号を読めなかった");
  }
  return { recorded: row.recorded, cutoffRecorded: row.cutoff_recorded };
}

// 記した番号が n より小さいときだけ、パスワード（SCRAM-SHA-256 の検証子）と番号 n と書いた時刻を 1 つのトランザクションで書き、
// 境の時刻を空にする（I17）。パスワードの平文は SQL の文にも引数にも載せない（失敗した文は DB の側のログに書かれうるため）
export async function rotateRole(sql: SqlExecutor, project: ProjectIdent & { password: string; seq: number }): Promise<RotateResult> {
  if (project.projectId.length === 0) throw new Error("プロジェクトの ID が空");
  assertRole(project.role);
  assertSeq(project.seq);
  // 文を打つ前に作る。印字できない文字のパスワードはここで投げ、何も打たない
  const verifier = escapeLiteral(scramVerifier(project.password));
  const role = escapeIdentifier(project.role);
  const roleParam = [{ name: "role_name", value: project.role }];
  return inTransaction(sql, async (opts) => {
    // 鎖は確定か巻き戻しまで持つ
    await sql.execute(ROTATE_LOCK, roleParam, opts);
    await ensureTable(sql, opts);
    const got = await readSeq(sql, roleParam, opts);
    if (got !== undefined && got.recorded > project.seq) return { kind: "superseded_greater", recorded: got.recorded };
    if (got !== undefined && got.recorded === project.seq) return { kind: "superseded_equal", recorded: got.recorded };
    await sql.execute(`ALTER ROLE ${role} WITH PASSWORD ${verifier}`, undefined, opts);
    await sql.execute(WRITE_SEQ, [...roleParam, { name: "seq", value: project.seq }], opts);
    return { kind: "applied", recorded: project.seq };
  });
}

// rotateRole の確定の後に、別のトランザクションで同じ鎖を取り、境の時刻より前に始まった役割の接続を切る。
// 記した番号が n より大きければ何も切らない。境の時刻が空なら記す。切りと読み直しは切り始めから 1 つの期限を共にし、
// 期限を過ぎても読み直しを 1 回打ってから、その数を返す（1 以上なら呼ぶ側が connections_remain にする）。
// 数には、確定の前に古い検証子を読んで起動の途中にある接続も入れる（0 を返した後に古いパスワードの接続が成り立たないように）
export async function terminateRoleConnections(
  sql: SqlExecutor,
  role: string,
  seq: number,
  options: TerminateOptions = {},
): Promise<TerminateResult> {
  assertRole(role);
  assertSeq(seq);
  const deadlineMs = options.deadlineMs ?? 15_000;
  const pollMs = options.pollMs ?? 500;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const roleParam = [{ name: "role_name", value: role }];
  return inTransaction(sql, async (opts): Promise<TerminateResult> => {
    await sql.execute(ROTATE_LOCK, roleParam, opts);
    const got = await readSeq(sql, roleParam, opts);
    // 行が無いか n より小さいのは、rotateRole が番号 n を確定していない呼び出し
    if (got === undefined || got.recorded < seq) throw new Error("差し替えの番号が記されていない");
    if (got.recorded > seq) return { kind: "superseded_greater", recorded: got.recorded };
    if (!got.cutoffRecorded) await sql.execute(RECORD_CUTOFF, [...roleParam, { name: "seq", value: seq }], opts);

    const deadline = now() + deadlineMs;
    // 一覧を読む前にも写しを捨てる
    await sql.execute(CLEAR_SNAPSHOT, undefined, opts);
    await sql.execute(SIGNAL_OLD, roleParam, opts);
    // 起動の途中と見た pid。最初の読みで決め、以後は載ったか終わったものを外していく（後から起動した接続は新しい検証子を読む）
    let starting: string[] | undefined;
    for (;;) {
      // 期限を過ぎていても、読み直しを 1 回打ってから決める
      const [held] = await sql.execute(VXID_HOLDERS, undefined, opts);
      const holders = pidList(held?.holders, "起動の途中の接続");
      // 鎖を放した pid は、載ったか終わったもの。載ったものは境の時刻と比べる側で数える
      starting = starting === undefined ? holders : starting.filter((pid) => holders.includes(pid));
      await sql.execute(CLEAR_SNAPSHOT, undefined, opts);
      const [row] = await sql.execute(REMAINING_OLD, [...roleParam, { name: "starting", value: starting.join(",") }], opts);
      const visible = row?.remaining;
      if (typeof visible !== "number") throw new Error("残りの接続の数を読めなかった");
      starting = pidList(row?.starting, "起動の途中の接続");
      // 起動の途中の接続は役割が分からないため、古い検証子を持ちうるものとして残りに数える
      const remaining = visible + starting.length;
      if (remaining === 0) return { kind: "done", remaining };
      const left = deadline - now();
      if (left <= 0) return { kind: "done", remaining };
      await sleep(Math.min(pollMs, left));
      // 待つ間に起動を終えて載った古い接続にも、シグナルを送る
      await sql.execute(CLEAR_SNAPSHOT, undefined, opts);
      await sql.execute(SIGNAL_OLD, roleParam, opts);
    }
  });
}
