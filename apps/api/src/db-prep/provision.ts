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

// データベースの CONNECT を持つ役割のうち、管理の役割（current_user。作った持ち主）と渡された役割のほかの数。
// datacl が空なら既定の ACL（持ち主と PUBLIC）で読む。grantee 0 は PUBLIC で、別に返す（接続を許さない間は数えない）
const DATABASE_GRANTS =
  "SELECT d.datallowconn AS allow," +
  " (SELECT count(*)::int FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a" +
  "   WHERE a.privilege_type = 'CONNECT' AND a.grantee <> 0" +
  "   AND a.grantee <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)" +
  "   AND a.grantee IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = :role_name)) AS others," +
  " EXISTS (SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a" +
  "   WHERE a.privilege_type = 'CONNECT' AND a.grantee = 0) AS public_connect" +
  " FROM pg_catalog.pg_database d WHERE d.datname = :database_name";
// 渡された役割が、渡されたデータベースのほかで CONNECT を持つ数（持ち主であることを含む）。PUBLIC の分は数えない
const ROLE_GRANTS =
  "SELECT count(*)::int AS other_databases FROM pg_catalog.pg_database d" +
  " CROSS JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a" +
  " WHERE a.privilege_type = 'CONNECT' AND d.datname <> :database_name" +
  " AND a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = :role_name)";

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
// 管理の役割とプロジェクトの役割のほかの接続を切る。切った数を返すだけで、行は 1 つ（一覧を返さない）
const TERMINATE_OTHERS =
  "SELECT coalesce(sum(CASE WHEN pg_terminate_backend(pid) THEN 1 ELSE 0 END), 0)::int AS terminated" +
  " FROM pg_catalog.pg_stat_activity WHERE datname = :database_name AND pid <> pg_backend_pid()" +
  " AND backend_type = 'client backend' AND usename IS DISTINCT FROM current_user AND usename IS DISTINCT FROM :role_name";

// docs/design/data.md の用意の手順の 1〜6。何度打っても、最後に渡したパスワードで同じ結果になる。
// パスワードの平文は SQL の文にも引数にも載せず、SCRAM-SHA-256 の検証子を文に載せる（失敗した文は DB の側のログに書かれうるため）
export async function provisionProject(sql: SqlExecutor, project: ProjectIdent & { password: string }): Promise<void> {
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

  // 2. 権限を整えるまで誰も接続できないように作る。CREATE DATABASE はトランザクションの中で打てないため自動の確定で打つ
  if (!(await readFlag(sql, DATABASE_EXISTS, "found", dbParam, ADMIN))) {
    await sql.execute(`CREATE DATABASE ${db} WITH ALLOW_CONNECTIONS false`, undefined, ADMIN);
  }

  // 3. PUBLIC から外してから接続を許す。この時点で接続できるのは持ち主の管理の役割だけ
  await inTransaction(sql, ADMIN_DATABASE, async (opts) => {
    await sql.execute(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`, undefined, opts);
    await sql.execute(`ALTER DATABASE ${db} WITH ALLOW_CONNECTIONS true`, undefined, opts);
  });

  // 4. プロジェクトのデータベースで、他のデータベースと役割の名前と数を返すカタログと統計の読み取りを PUBLIC から外す（I2）。
  // 読み取りの既定の役割（pg_read_all_stats など）へは入れない
  const catalogs = await sql.execute(EXISTING_CATALOG_READS, [{ name: "names", value: CATALOG_READS.join(",") }], inProject);
  const names = catalogs.flatMap((r) => (typeof r.name === "string" ? [r.name] : []));
  if (names.length > 0) {
    const list = names.map((n) => `pg_catalog.${escapeIdentifier(n)}`).join(", ");
    await sql.execute(`REVOKE SELECT ON ${list} FROM PUBLIC`, undefined, inProject);
  }

  // 5. 作り直しのとき、権限を整える前から残る接続を断つ
  await sql.execute(TERMINATE_OTHERS, [...dbParam, ...roleParam], ADMIN);

  // 6. 役割を作るか（作り直しなら）パスワードを書き直し、専用のスキーマと search_path を置き、最後に接続と一時表を与える。
  // ALTER ROLE は SUPERUSER などの属性を書かない（属性を変えるには superuser が要り、Aurora の管理の役割は superuser でない）
  if (await readFlag(sql, ROLE_EXISTS, "found", roleParam, ADMIN)) {
    await sql.execute(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${verifier}`, undefined, ADMIN);
  } else {
    await sql.execute(`CREATE ROLE ${role} WITH LOGIN PASSWORD ${verifier}`, undefined, ADMIN);
  }
  // スキーマの名前は役割の名前にする（search_path の既定の "$user" とも合う）
  await sql.execute(`CREATE SCHEMA IF NOT EXISTS ${role} AUTHORIZATION ${role}`, undefined, inProject);
  await sql.execute(`ALTER SCHEMA ${role} OWNER TO ${role}`, undefined, inProject);
  await sql.execute(`ALTER ROLE ${role} SET search_path TO ${role}`, undefined, ADMIN);
  await sql.execute(`GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${role}`, undefined, ADMIN);
}
