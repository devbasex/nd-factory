import { PROGRESS_DB_IDENT_SHAPE } from "@nd-factory/contracts/db-prep";
import { escapeIdentifier, escapeLiteral } from "pg";
import { scramVerifier } from "./scram.ts";
import { ADMIN_DATABASE, type SqlExecutor, type SqlParam } from "./sql-executor.ts";

// プロジェクトと、そのデータベースと役割の名前。名前は API（#6）が無作為に作り、関数は口から読む
export type ProjectIdent = { projectId: string; database: string; role: string };

// 手順の 1 で PUBLIC から接続を外す、クラスタに初めからあるデータベース。接続し直してカタログと統計から他の名前を読ませない
export const SYSTEM_DATABASES: readonly string[] = ["postgres", "template1"];

// 手順の 4 で PUBLIC から読み取りを外す pg_catalog の表とビュー。どれも他のデータベース・役割の名前か数を返す。
// 共有のカタログでも、読み取りの権限はデータベースごとの pg_class に載るため、プロジェクトのデータベースでだけ外れる。
// 版によって無いものは外す前に引いて除く（PostgreSQL 14 以上を前提に並べる）
export const CATALOG_READS: readonly string[] = [
  // 共有のカタログ: データベースと役割の名前・結び付き・注釈
  "pg_database",
  "pg_auth_members",
  "pg_db_role_setting",
  "pg_shdepend",
  "pg_shdescription",
  "pg_shseclabel",
  "pg_replication_origin",
  "pg_subscription",
  // 役割の名前のビュー
  "pg_roles",
  "pg_user",
  "pg_group",
  "pg_user_mappings",
  "pg_seclabels",
  // 統計と進み具合のビュー: データベースと役割の名前を列に持つ
  "pg_stat_activity",
  "pg_stat_database",
  "pg_stat_database_conflicts",
  "pg_stat_replication",
  "pg_stat_subscription",
  "pg_stat_subscription_stats",
  "pg_stat_wal_receiver",
  "pg_stat_progress_vacuum",
  "pg_stat_progress_analyze",
  "pg_stat_progress_cluster",
  "pg_stat_progress_create_index",
  "pg_stat_progress_basebackup",
  "pg_stat_progress_copy",
  "pg_replication_slots",
  "pg_prepared_xacts",
];

const ADMIN = { database: ADMIN_DATABASE };

// 名前は形を照らしてから SQL に載せる。例外の文に名前を入れない（ログへ流れうるため）
function assertIdent(project: ProjectIdent): void {
  if (project.projectId.length === 0) throw new Error("プロジェクトの ID が空");
  if (!PROGRESS_DB_IDENT_SHAPE.test(project.database)) throw new Error("データベースの名前が形に合わない");
  if (!PROGRESS_DB_IDENT_SHAPE.test(project.role)) throw new Error("役割の名前が形に合わない");
}

// 1 つのトランザクションで打つ。途中で投げたら巻き戻して元の失敗を投げ、確定が投げたらそのまま投げる
async function inTransaction<T>(
  sql: SqlExecutor,
  database: string,
  fn: (opts: { database: string; transactionId: string }) => Promise<T>,
): Promise<T> {
  const tx = await sql.begin({ database });
  let out: T;
  try {
    out = await fn({ database, transactionId: tx });
  } catch (e) {
    // 巻き戻しの失敗は元の失敗より後の出来事で、呼ぶ側は元の失敗で扱う。Data API のトランザクションは無通信で巻き戻る
    await sql.rollback(tx).catch(() => undefined);
    throw e;
  }
  await sql.commit(tx);
  return out;
}

async function readFlag(
  sql: SqlExecutor,
  stmt: string,
  column: string,
  params: SqlParam[] | undefined,
  opts: { database: string; transactionId?: string },
): Promise<boolean> {
  const [row] = await sql.execute(stmt, params, opts);
  return row?.[column] === true;
}

// --- 結び付き（claimBinding） ---

// 作るプロジェクトどうしを直列にする鎖。2 つのプロジェクトの作成が同じ名前を同時に結ぶことを防ぐ
const BINDINGS_LOCK = "SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext('nd-prep:bindings'))";
// nd_prep のスキーマを作るときの鎖。claimPrepRun と同じ鎖で、スキーマを作る文どうしを重ねない。
// 取る順は結び付きの鎖 → スキーマの鎖で、claimPrepRun はスキーマの鎖しか取らないため、互いに待ち合わない
const SCHEMA_LOCK = "SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext('nd-prep:schema'))";
// 有無は鎖の後に、控え（syscache）を通さずカタログの表をその文の写しで読む（prep-run.ts の見直しと同じ理由）
const BINDINGS_PRESENT =
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace" +
  " WHERE n.nspname = 'nd_prep' AND c.relname = 'bindings') AS present";
const SCHEMA_PRESENT = "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'nd_prep') AS present";
const CREATE_SCHEMA = "CREATE SCHEMA nd_prep";
const REVOKE_SCHEMA = "REVOKE ALL ON SCHEMA nd_prep FROM PUBLIC";
const CREATE_BINDINGS =
  "CREATE TABLE nd_prep.bindings (project_id text PRIMARY KEY, database_name text NOT NULL UNIQUE," +
  " role_name text NOT NULL UNIQUE, bound_at timestamptz NOT NULL DEFAULT now())";
const REVOKE_BINDINGS = "REVOKE ALL ON nd_prep.bindings FROM PUBLIC";
// 3 つの値はそれぞれ一意なので、当たる行は多くて 3 つ
const FIND_BINDINGS =
  "SELECT project_id::text AS project_id, database_name::text AS database_name, role_name::text AS role_name" +
  " FROM nd_prep.bindings WHERE project_id = :project_id OR database_name = :database_name OR role_name = :role_name LIMIT 4";
const RESOURCES_PRESENT =
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = :database_name) AS database_exists," +
  " EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :role_name) AS role_exists";
const INSERT_BINDING = "INSERT INTO nd_prep.bindings (project_id, database_name, role_name) VALUES (:project_id, :database_name, :role_name)";

// データベースと役割を作る前に、プロジェクトと 2 つの名前の結び付きを記す（I10 の 1 つ目の守り）。
// bound: 新しく記した。retry: 同じ結び付きが既にあり、途中で止まった作成の打ち直し。conflict: 何も書かない
export async function claimBinding(sql: SqlExecutor, project: ProjectIdent): Promise<"bound" | "retry" | "conflict"> {
  assertIdent(project);
  const params = [
    { name: "project_id", value: project.projectId },
    { name: "database_name", value: project.database },
    { name: "role_name", value: project.role },
  ];
  return inTransaction(sql, ADMIN_DATABASE, async (opts) => {
    // 鎖は確定か巻き戻しまで持つ
    await sql.execute(BINDINGS_LOCK, undefined, opts);
    if (!(await readFlag(sql, BINDINGS_PRESENT, "present", undefined, opts))) {
      await sql.execute(SCHEMA_LOCK, undefined, opts);
      if (!(await readFlag(sql, SCHEMA_PRESENT, "present", undefined, opts))) {
        await sql.execute(CREATE_SCHEMA, undefined, opts);
        await sql.execute(REVOKE_SCHEMA, undefined, opts);
      }
      // 結び付きの鎖の下なので、ほかに表を作る配信は無い
      await sql.execute(CREATE_BINDINGS, undefined, opts);
      await sql.execute(REVOKE_BINDINGS, undefined, opts);
    }
    const rows = await sql.execute(FIND_BINDINGS, params, opts);
    if (rows.length === 0) {
      const [found] = await sql.execute(RESOURCES_PRESENT, params, opts);
      // 結び付きの無い資源。別の経路で作られたものか、作成の途中で行を失ったものを使わない
      if (found?.database_exists !== false || found.role_exists !== false) return "conflict";
      await sql.execute(INSERT_BINDING, params, opts);
      return "bound";
    }
    const [row] = rows;
    if (
      rows.length === 1 &&
      row?.project_id === project.projectId &&
      row.database_name === project.database &&
      row.role_name === project.role
    ) {
      return "retry";
    }
    return "conflict";
  });
}

// --- I10 の守り（checkIsolationGuard） ---

// 実効の CONNECT は、ACL の受け手の役割に属する（pg_has_role の MEMBER。継承か SET ROLE で使える）ことで読む。
// ACL に直に載る役割だけを見ると、所属で CONNECT を受ける役割を見落とす。datacl が空なら既定の ACL（持ち主と PUBLIC）で読む。
// 持ち主に属する役割も、持ち主の権限で CONNECT を与え直せるため数える。grantee 0 は PUBLIC。
// superuser はどのデータベースにも接続でき、クラスタを管理する側の役割として数えない（pg_has_role が常に真を返すため、数えると照らせない）
const CONNECT_VIA = (role: string) =>
  `(pg_catalog.pg_has_role(${role}, d.datdba, 'MEMBER') OR EXISTS (SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a` +
  ` WHERE a.privilege_type = 'CONNECT' AND a.grantee <> 0 AND pg_catalog.pg_has_role(${role}, a.grantee, 'MEMBER')))`;
// 対象のデータベースへ実効の CONNECT を持つ役割のうち、管理の役割（current_user。作った持ち主）と渡された役割のほかの数。
// 渡された役割に属する別の役割（渡された役割から CONNECT を受け継ぐ別のログイン）もここで数える。
// PUBLIC は別に返す（接続を許さない間は数えない）
const DATABASE_GRANTS =
  "SELECT d.datallowconn AS allow," +
  " (SELECT count(*)::int FROM pg_catalog.pg_roles r WHERE NOT r.rolsuper" +
  "   AND r.rolname <> current_user AND r.rolname <> :role_name AND " +
  CONNECT_VIA("r.oid") +
  ") AS others," +
  " EXISTS (SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a" +
  "   WHERE a.privilege_type = 'CONNECT' AND a.grantee = 0) AS public_connect" +
  " FROM pg_catalog.pg_database d WHERE d.datname = :database_name";
// 渡された役割が、渡されたデータベースのほかで実効の CONNECT を持つデータベースの数（所属・持ち主であることを含む）。
// 接続を許さないデータベースも数える（作成の途中のほかのプロジェクトのデータベースへの結び付きも結び付きであるため）。
// PUBLIC の分は数えない: PUBLIC は特定の役割への結び付きでなく、postgres・template1 は手順の 1、プロジェクトのデータベースは
// 手順の 3 が PUBLIC から外し、外れたことを読み直してから役割に接続を与える。渡された役割が superuser なら、どこへでも接続できるため数える
const ROLE_GRANTS =
  "SELECT count(*)::int AS other_databases FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_database d" +
  " WHERE r.rolname = :role_name AND d.datname <> :database_name AND (r.rolsuper OR " +
  CONNECT_VIA("r.oid") +
  ")";

// データベースか役割が、渡されたもの以外へ CONNECT で結ばれていれば conflict（claimBinding の後に打つ 2 つ目の守り）
export async function checkIsolationGuard(sql: SqlExecutor, project: ProjectIdent): Promise<"ok" | "conflict"> {
  assertIdent(project);
  const params = [
    { name: "database_name", value: project.database },
    { name: "role_name", value: project.role },
  ];
  const [database] = await sql.execute(DATABASE_GRANTS, params, ADMIN);
  if (database !== undefined) {
    if (typeof database.others !== "number" || database.others > 0) return "conflict";
    // 接続を許さないデータベースの PUBLIC は、手順の 2 の後・3 の REVOKE の前に止まった状態で、誰も接続できない
    if (database.public_connect !== false && database.allow !== false) return "conflict";
  }
  const [role] = await sql.execute(ROLE_GRANTS, params, ADMIN);
  if (typeof role?.other_databases !== "number" || role.other_databases > 0) return "conflict";
  return "ok";
}

// --- 用意の手順（provisionProject） ---

const DATABASE_EXISTS = "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = :database_name) AS found";
const ROLE_EXISTS = "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :role_name) AS found";
// 版に無いものを除く。名前の並びは引数の 1 つの文字列で渡す（Data API は配列の引数を受けない）
const EXISTING_CATALOG_READS =
  "SELECT c.relname::text AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace" +
  " WHERE n.nspname = 'pg_catalog' AND c.relname = ANY (string_to_array(:names, ',')) ORDER BY 1";
// 取り消しの後の読み直し。REVOKE は取り消す権限が無いと警告だけで終わるため、権限の今の状態を読んで照らす。
// PUBLIC がまだ CONNECT か TEMPORARY を持つデータベースの数と、渡した名前のうち見つかったデータベースの数
const PUBLIC_DATABASE_GRANTS =
  "SELECT count(*) FILTER (WHERE pg_catalog.has_database_privilege('public', d.oid, 'CONNECT')" +
  " OR pg_catalog.has_database_privilege('public', d.oid, 'TEMPORARY'))::int AS remaining, count(*)::int AS found" +
  " FROM pg_catalog.pg_database d WHERE d.datname = ANY (string_to_array(:names, ','))";
// 渡した名前のほかで、接続を許し、PUBLIC が CONNECT を持つデータベース（OID と名前）。渡すのは手順の 1 が外して読み直す
// postgres・template1 と、手順の 3 が外して読み直すプロジェクトのデータベース。ほかのデータベース（ほかのプロジェクトのもの、
// 別の経路で作られたもの）で PUBLIC が CONNECT を持てば、用意済みのほかのプロジェクトの役割も、これから作る役割もそこへ接続できる。
// 接続を許さないデータベース（作成の途中のほかのプロジェクトのもの・template0）は誰も接続できないため数えない
const OTHER_PUBLIC_DATABASES =
  "SELECT d.oid::text AS exposed_oid, d.datname::text AS exposed_name FROM pg_catalog.pg_database d WHERE d.datallowconn" +
  " AND NOT (d.datname = ANY (string_to_array(:names, ','))) AND pg_catalog.has_database_privilege('public', d.oid, 'CONNECT')" +
  " ORDER BY d.oid";
// 渡した OID のうち、PUBLIC がまだ CONNECT か TEMPORARY を持つデータベースの数（復旧の REVOKE の読み直し）
const EXPOSED_STILL_PUBLIC =
  "SELECT count(*)::int AS exposed_remaining FROM pg_catalog.pg_database d WHERE d.oid = ANY (string_to_array(:oids, ',')::oid[])" +
  " AND (pg_catalog.has_database_privilege('public', d.oid, 'CONNECT') OR pg_catalog.has_database_privilege('public', d.oid, 'TEMPORARY'))";
// 手順の 1 で切る相手: どのデータベースでも、今の権限ではそのデータベースへの CONNECT を持たないクライアントの接続
// （PUBLIC の CONNECT だけで postgres・template1・ほかのプロジェクトのデータベースへ繋いだプロジェクトの役割など）。
// 管理の役割と superuser の接続は除く（手順の 5 と同じ理由）。CONNECT は接続を始めるときだけ照らされ、取り消しても
// 繋いだままの接続は残る。前の用意が取り消しを確定した後・切り終える前に止まっても、次の用意がここで拾えるように、
// 今の ACL や取り消しを打ったかによらず、毎回すべてのデータベースで読む
const UNAUTHORIZED_SESSIONS =
  " FROM pg_catalog.pg_stat_activity s JOIN pg_catalog.pg_database d ON d.oid = s.datid" +
  " WHERE s.pid <> pg_backend_pid() AND s.backend_type = 'client backend' AND s.usename IS DISTINCT FROM current_user" +
  " AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid = s.usesysid AND r.rolsuper)" +
  " AND NOT pg_catalog.has_database_privilege(s.usesysid, d.oid, 'CONNECT')";
const SIGNAL_UNAUTHORIZED = `SELECT count(*) FILTER (WHERE pg_terminate_backend(s.pid, 0))::int AS unauthorized_signalled${UNAUTHORIZED_SESSIONS}`;
const REMAINING_UNAUTHORIZED = `SELECT count(*)::int AS remaining${UNAUTHORIZED_SESSIONS}`;
// 起動の途中の接続: データベースの鎖（pg_database の行への RowExclusiveLock）を持ち、まだ pg_stat_activity に載らない接続。
// PostgreSQL は起動のときこの鎖を取ってから CONNECT を照らし、pg_stat_activity に載せてから起動のトランザクションを確定して
// 鎖を放す。取り消しの確定の前に照らしを通った接続は、確定の時点でこの鎖を持つため、鎖を持つ載らない接続が無いと読んだ後の
// pg_stat_activity の読みには必ず載る。鎖を待っている接続はまだ照らしておらず、取り消しの後の ACL で照らされるため数えない
const PENDING_STARTUPS = (target: string) =>
  "SELECT count(DISTINCT l.pid)::int AS pending FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_database d ON d.oid = l.objid" +
  " WHERE l.locktype = 'object' AND l.database = 0 AND l.classid = 'pg_catalog.pg_database'::regclass AND l.granted" +
  ` AND l.pid <> pg_backend_pid() AND (${target})` +
  " AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity s WHERE s.pid = l.pid)";
// 手順の 1 で取り消すデータベース（postgres・template1 と、見つけて外したほかのデータベース）
const PENDING_REVOKED = PENDING_STARTUPS(
  "d.datname = ANY (string_to_array(:names, ',')) OR d.oid = ANY (string_to_array(:oids, ',')::oid[])",
);
// 手順の 3 で取り消すプロジェクトのデータベース
const PENDING_PROJECT = PENDING_STARTUPS("d.datname = :database_name");
// PUBLIC がまだ表か列のどれかを読めるカタログの数（表の権限の取り消しは同じ種類の列の権限も外す）
const PUBLIC_CATALOG_READS =
  "SELECT count(*)::int AS remaining FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace" +
  " WHERE n.nspname = 'pg_catalog' AND c.relname = ANY (string_to_array(:names, ','))" +
  " AND pg_catalog.has_any_column_privilege('public', c.oid, 'SELECT')";
// 切る相手: 渡したデータベースへの、管理の役割とプロジェクトの役割と superuser のほかのクライアントの接続。
// superuser の接続はクラスタを管理する側のもので、superuser でない管理の役割（Aurora）には切れない
const OTHER_SESSIONS =
  " FROM pg_catalog.pg_stat_activity s WHERE s.datname = :database_name AND s.pid <> pg_backend_pid()" +
  " AND s.backend_type = 'client backend' AND s.usename IS DISTINCT FROM current_user AND s.usename IS DISTINCT FROM :role_name" +
  " AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid = s.usesysid AND r.rolsuper)";
// 終了のシグナルを送るだけで待たない（timeout 0。真はシグナルを送れたことだけを表す）。終わったかは下の読みで確かめる
const SIGNAL_OTHERS = `SELECT count(*) FILTER (WHERE pg_terminate_backend(s.pid, 0))::int AS signalled${OTHER_SESSIONS}`;
// 自動の確定で打つため、文ごとに新しい統計の写しを読む
const REMAINING_OTHERS = `SELECT count(*)::int AS remaining${OTHER_SESSIONS}`;

export type ProvisionOptions = {
  // 手順の 5 で、残る接続が消えるのを待つ期限と読み直しの間隔（既定 15,000 と 500。terminateRoleConnections とそろえる）
  deadlineMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

async function readCount(
  sql: SqlExecutor,
  stmt: string,
  params: SqlParam[] | undefined,
  opts: { database: string; transactionId?: string },
): Promise<{ remaining: number; found?: number }> {
  const [row] = await sql.execute(stmt, params, opts);
  const remaining = row?.remaining;
  // 読めない形は残ったものとして扱う（用意を成功にしない）
  if (typeof remaining !== "number") return { remaining: Number.POSITIVE_INFINITY };
  return typeof row?.found === "number" ? { remaining, found: row.found } : { remaining };
}

// 渡したデータベースのどれかで PUBLIC の CONNECT・TEMPORARY が残っていれば投げる
async function assertPublicDatabaseRevoked(
  sql: SqlExecutor,
  names: readonly string[],
  opts: { database: string; transactionId?: string },
): Promise<void> {
  const got = await readCount(sql, PUBLIC_DATABASE_GRANTS, [{ name: "names", value: names.join(",") }], opts);
  if (got.remaining !== 0 || got.found !== names.length) throw new Error("PUBLIC からデータベースの接続を外せなかった");
}

// 渡した名前のほかの、接続を許すデータベースで PUBLIC が CONNECT を持てば、そこの CONNECT・TEMPORARY を PUBLIC から外して
// 読み直す（新しい接続を断つ）。PUBLIC の CONNECT が戻れば、用意済みのほかのプロジェクトの役割は今その時点でそこへ接続できる。
// 見つけたかによらず、次に権限の無い接続を切って、起動の途中の接続も含めて消えたことを読み直す（繋いだままの接続を断つ）。
// 見つけたときは、断てても用意を止める: 戻った原因（手で打った GRANT など）を見るまで、次の打ち直しに任せる。
// 照らしの行が読めない形なら、何も外さずに投げる
async function closeUnauthorizedAccess(sql: SqlExecutor, names: readonly string[], options: ProvisionOptions): Promise<void> {
  const rows = await sql.execute(OTHER_PUBLIC_DATABASES, [{ name: "names", value: names.join(",") }], ADMIN);
  const exposed = rows.flatMap((r) =>
    typeof r.exposed_oid === "string" && /^[0-9]+$/.test(r.exposed_oid) && typeof r.exposed_name === "string"
      ? [{ oid: r.exposed_oid, name: r.exposed_name }]
      : [],
  );
  if (exposed.length !== rows.length) throw new Error("ほかのデータベースの PUBLIC の接続を読めなかった");
  for (const d of exposed) {
    await sql.execute(`REVOKE CONNECT, TEMPORARY ON DATABASE ${escapeIdentifier(d.name)} FROM PUBLIC`, undefined, ADMIN);
  }
  const oids = exposed.map((d) => d.oid).join(",");
  // 外せなかったときも、外せたデータベースの接続を切ってから投げる
  const left = exposed.length > 0 ? (await sql.execute(EXPOSED_STILL_PUBLIC, [{ name: "oids", value: oids }], ADMIN))[0] : undefined;
  await terminateSessions(
    sql,
    { signal: SIGNAL_UNAUTHORIZED, remaining: REMAINING_UNAUTHORIZED, pending: PENDING_REVOKED },
    [],
    [
      { name: "names", value: SYSTEM_DATABASES.join(",") },
      { name: "oids", value: oids },
    ],
    options,
  );
  if (exposed.length === 0) return;
  if (left?.exposed_remaining !== 0) throw new Error("ほかのデータベースで PUBLIC が接続を持ち、外せなかった");
  throw new Error("ほかのデータベースで PUBLIC が接続を持っていた（外し、権限の無い接続を切った）");
}

// シグナルを送り、起動の途中の接続が無いと読んでから、対象が消えたことを読む。期限の内で繰り返し、期限を過ぎても残れば投げる
// （手順の 1 と 5）。起動の途中の読みを先に打つ: そのとき鎖を持っていた接続は、後の読みでは pg_stat_activity に載っている
async function terminateSessions(
  sql: SqlExecutor,
  stmts: { signal: string; remaining: string; pending: string },
  params: SqlParam[],
  pendingParams: SqlParam[],
  options: ProvisionOptions,
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? 15_000;
  const pollMs = options.pollMs ?? 500;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + deadlineMs;
  for (;;) {
    // 読み直しの間に載った接続にも送る（取り消しの後に照らす接続は、CONNECT を持つ役割だけが繋げる）
    await sql.execute(stmts.signal, params.length > 0 ? params : undefined, ADMIN);
    // 期限を過ぎていても、読み直しを 1 回打ってから決める
    const [row] = await sql.execute(stmts.pending, pendingParams, ADMIN);
    const pending = typeof row?.pending === "number" ? row.pending : Number.POSITIVE_INFINITY;
    const { remaining } = await readCount(sql, stmts.remaining, params.length > 0 ? params : undefined, ADMIN);
    if (pending === 0 && remaining === 0) return;
    const left = deadline - now();
    if (left <= 0) throw new Error("ほかの接続が期限の内に終わらなかった");
    await sleep(Math.min(pollMs, left));
  }
}

// docs/design/data.md の用意の手順の 1〜6。何度打っても、最後に渡したパスワードで同じ結果になる。
// パスワードの平文は SQL の文にも引数にも載せず、SCRAM-SHA-256 の検証子を文に載せる（失敗した文は DB の側のログに書かれうるため）。
// 取り消した権限は読み直して照らし、残っていれば役割に接続を与える前に投げる。
// 毎回、どのデータベースでも今の権限の無い接続を切る。ほかのデータベースで PUBLIC が CONNECT を持つときは、
// そこを PUBLIC から外して権限の無い接続を切り、何も作らずに投げる
export async function provisionProject(
  sql: SqlExecutor,
  project: ProjectIdent & { password: string },
  options: ProvisionOptions = {},
): Promise<void> {
  assertIdent(project);
  // 文を打つ前に作る。印字できない文字のパスワードはここで投げ、何も打たない
  const verifier = escapeLiteral(scramVerifier(project.password));
  const db = escapeIdentifier(project.database);
  const role = escapeIdentifier(project.role);
  const inProject = { database: project.database };
  const dbParam = [{ name: "database_name", value: project.database }];
  const roleParam = [{ name: "role_name", value: project.role }];

  // 1. クラスタに初めからあるデータベースへの接続と一時表を PUBLIC から外す（何度打っても同じ結果）
  for (const name of SYSTEM_DATABASES) {
    await sql.execute(`REVOKE CONNECT, TEMPORARY ON DATABASE ${escapeIdentifier(name)} FROM PUBLIC`, undefined, ADMIN);
  }
  await assertPublicDatabaseRevoked(sql, SYSTEM_DATABASES, ADMIN);
  // ほかのデータベースで PUBLIC の CONNECT が戻っていれば外す。続けて、postgres・template1 を含むすべてのデータベースで
  // 今の権限の無い接続を切り、消えたことを読む。戻っていたときは何も作らずに止める。
  // 残したまま進むと 6 で作る役割がそこへ接続でき、用意済みのほかのプロジェクトの役割も既に接続でき、繋いだままの接続で読み続ける
  await closeUnauthorizedAccess(sql, [...SYSTEM_DATABASES, project.database], options);

  // 2. 権限を整えるまで誰も接続できないように作る。CREATE DATABASE はトランザクションの中で打てないため自動の確定で打つ
  if (!(await readFlag(sql, DATABASE_EXISTS, "found", dbParam, ADMIN))) {
    await sql.execute(`CREATE DATABASE ${db} WITH ALLOW_CONNECTIONS false`, undefined, ADMIN);
  }

  // 3. PUBLIC から外し、外れたことを読み直してから接続を許す。この時点で接続できるのは持ち主の管理の役割だけ
  await inTransaction(sql, ADMIN_DATABASE, async (opts) => {
    await sql.execute(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`, undefined, opts);
    await assertPublicDatabaseRevoked(sql, [project.database], opts);
    await sql.execute(`ALTER DATABASE ${db} WITH ALLOW_CONNECTIONS true`, undefined, opts);
  });

  // 4. プロジェクトのデータベースで、他のデータベースと役割の名前と数を返すカタログと統計の読み取りを PUBLIC から外す（I2）。
  // 読み取りの既定の役割（pg_read_all_stats など）へは入れない
  const nameParam = [{ name: "names", value: CATALOG_READS.join(",") }];
  const catalogs = await sql.execute(EXISTING_CATALOG_READS, nameParam, inProject);
  const names = catalogs.flatMap((r) => (typeof r.name === "string" ? [r.name] : []));
  if (names.length > 0) {
    const list = names.map((n) => `pg_catalog.${escapeIdentifier(n)}`).join(", ");
    await sql.execute(`REVOKE SELECT ON ${list} FROM PUBLIC`, undefined, inProject);
  }
  if ((await readCount(sql, PUBLIC_CATALOG_READS, nameParam, inProject)).remaining !== 0) {
    throw new Error("PUBLIC からカタログの読み取りを外せなかった");
  }

  // 5. 作り直しのとき、権限を整える前から残る接続を断ち、終わったことを確かめる
  await terminateSessions(
    sql,
    { signal: SIGNAL_OTHERS, remaining: REMAINING_OTHERS, pending: PENDING_PROJECT },
    [...dbParam, ...roleParam],
    dbParam,
    options,
  );

  // 6. 役割を作るか（作り直しなら）パスワードを書き直し、専用のスキーマと search_path を置き、最後に接続と一時表を与える。
  // ALTER ROLE は SUPERUSER などの属性を書かない（属性を変えるには superuser が要り、Aurora の管理の役割は superuser でない）
  if (await readFlag(sql, ROLE_EXISTS, "found", roleParam, ADMIN)) {
    await sql.execute(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${verifier}`, undefined, ADMIN);
  } else {
    await sql.execute(`CREATE ROLE ${role} WITH LOGIN PASSWORD ${verifier}`, undefined, ADMIN);
  }
  // スキーマをその役割の持ち物にするには、superuser でない管理の役割はその役割へ SET ROLE できる所属が要る。
  // PostgreSQL 16 で CREATE ROLE の作り手に付くのは ADMIN OPTION だけのため、SET を明示して与える（作り直しでも打つ。
  // 既にあれば何も変えない）。INHERIT は付けず、管理の役割がプロジェクトの役割の権限を受け継がないようにする
  await sql.execute(`GRANT ${role} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`, undefined, ADMIN);
  // スキーマの名前は役割の名前にする（search_path の既定の "$user" とも合う）
  await sql.execute(`CREATE SCHEMA IF NOT EXISTS ${role} AUTHORIZATION ${role}`, undefined, inProject);
  await sql.execute(`ALTER SCHEMA ${role} OWNER TO ${role}`, undefined, inProject);
  await sql.execute(`ALTER ROLE ${role} SET search_path TO ${role}`, undefined, ADMIN);
  await sql.execute(`GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${role}`, undefined, ADMIN);
}
