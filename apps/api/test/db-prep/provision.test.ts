import { randomBytes } from "node:crypto";
import { escapeIdentifier } from "pg";
import { describe, expect, it } from "vitest";
import {
  CATALOG_READS,
  type ProjectIdent,
  claimBinding,
  checkIsolationGuard,
  provisionProject,
} from "../../src/db-prep/provision.ts";
import { ADMIN_DATABASE, type SqlExecutor } from "../../src/db-prep/sql-executor.ts";
import { FakeSqlExecutor, type SqlCall } from "./fake-sql-executor.ts";
import { type TestDatabase, describePg, withTestDatabase } from "./pg-executor.ts";

// 作り物の値だけを使う
const PROJECT: ProjectIdent = { projectId: "prj_acme_a", database: "acme_db_aaaaaaaa", role: "acme_role_aaaaaaaa" };
const PASSWORD = "acme-Password-0123456789abcdefghijklmnopqrstu";
// 手順の文の長さの上限（Data API の文の長さの上限を確かめていないため、十分小さく縛る）
const STATEMENT_LIMIT = 4 * 1024;

function allText(calls: SqlCall[]): string[] {
  return calls.flatMap((c) => (c.kind === "execute" ? [c.sql, ...(c.params ?? []).map((p) => String(p.value))] : []));
}

// 作り物の DB の状態。文を見て答えを返す
type FakeState = {
  tablePresent?: boolean;
  bindings?: Array<{ project_id: string; database_name: string; role_name: string }>;
  databaseExists?: boolean;
  roleExists?: boolean;
  guardDatabase?: { allow: boolean; others: number; public_connect: boolean } | undefined;
  guardRoleOtherDatabases?: number;
};

function fakeDb(state: FakeState = {}): FakeSqlExecutor {
  const fake = new FakeSqlExecutor();
  fake.respond = (sql) => {
    if (sql.includes("AS present")) return [{ present: state.tablePresent ?? true }];
    if (sql.includes("FROM nd_prep.bindings")) return state.bindings ?? [];
    if (sql.includes("AS database_exists")) {
      return [{ database_exists: state.databaseExists ?? false, role_exists: state.roleExists ?? false }];
    }
    if (sql.includes("AS others")) return state.guardDatabase ? [state.guardDatabase] : [];
    if (sql.includes("AS other_databases")) return [{ other_databases: state.guardRoleOtherDatabases ?? 0 }];
    if (sql.includes("AS found")) {
      if (sql.includes("pg_database")) return [{ found: state.databaseExists ?? false }];
      return [{ found: state.roleExists ?? false }];
    }
    if (sql.includes("AS name")) return CATALOG_READS.map((name) => ({ name }));
    if (sql.includes("AS terminated")) return [{ terminated: 0 }];
    return [];
  };
  return fake;
}

describe("名前の形の照らし", () => {
  const bad: Array<[string, ProjectIdent]> = [
    ["データベースの名前が形に合わない", { ...PROJECT, database: "Acme-DB" }],
    ["役割の名前が形に合わない", { ...PROJECT, role: "acme role" }],
    ["データベースの名前が短すぎる", { ...PROJECT, database: "acme" }],
    ["プロジェクトの ID が空", { ...PROJECT, projectId: "" }],
  ];
  for (const [name, project] of bad) {
    it(`${name}なら SQL を打たずに投げる`, async () => {
      for (const run of [
        (s: SqlExecutor) => claimBinding(s, project),
        (s: SqlExecutor) => checkIsolationGuard(s, project),
        (s: SqlExecutor) => provisionProject(s, { ...project, password: PASSWORD }),
      ]) {
        const fake = fakeDb();
        await expect(run(fake)).rejects.toThrow();
        expect(fake.calls).toHaveLength(0);
      }
    });
  }

  it("例外の文に渡された名前を入れない", async () => {
    const fake = fakeDb();
    const err = await provisionProject(fake, { ...PROJECT, database: "Acme-Secret-Name", password: PASSWORD }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("Acme-Secret-Name");
  });
});

describe("claimBinding（作り物の SqlExecutor）", () => {
  it("管理のデータベースの 1 つのトランザクションで、結び付きの鎖を取ってから引く。値は引数で渡す", async () => {
    const fake = fakeDb();
    expect(await claimBinding(fake, PROJECT)).toBe("bound");
    expect(fake.calls[0]).toEqual({ kind: "begin", database: ADMIN_DATABASE });
    expect(fake.calls.at(-1)).toEqual({ kind: "commit", transactionId: "tx-1" });
    const executes = fake.calls.filter((c) => c.kind === "execute");
    expect(executes[0]!.sql).toContain("pg_advisory_xact_lock(hashtext('nd-prep:bindings'))");
    for (const c of executes) {
      expect(c.transactionId).toBe("tx-1");
      expect(c.database).toBe(ADMIN_DATABASE);
      for (const v of [PROJECT.projectId, PROJECT.database, PROJECT.role]) expect(c.sql).not.toContain(v);
    }
    const insert = executes.find((c) => c.sql.includes("INSERT INTO nd_prep.bindings"));
    expect(insert?.params).toEqual(
      expect.arrayContaining([
        { name: "project_id", value: PROJECT.projectId },
        { name: "database_name", value: PROJECT.database },
        { name: "role_name", value: PROJECT.role },
      ]),
    );
  });

  it("表が無ければ、結び付きの鎖の後にスキーマの鎖を取り、カタログを読み直してから作る", async () => {
    const fake = fakeDb({ tablePresent: false });
    expect(await claimBinding(fake, PROJECT)).toBe("bound");
    const s = fake.statements();
    const bindingsLock = s.findIndex((x) => x.includes("hashtext('nd-prep:bindings')"));
    const schemaLock = s.findIndex((x) => x.includes("hashtext('nd-prep:schema')"));
    const create = s.findIndex((x) => x.includes("CREATE TABLE nd_prep.bindings"));
    expect(bindingsLock).toBe(0);
    expect(schemaLock).toBeGreaterThan(bindingsLock);
    expect(create).toBeGreaterThan(schemaLock);
    expect(s.filter((x) => x.includes("AS present")).every((x) => x.includes("pg_catalog.pg_class") || x.includes("pg_catalog.pg_namespace"))).toBe(
      true,
    );
    expect(s.some((x) => x.includes("REVOKE ALL ON nd_prep.bindings FROM PUBLIC"))).toBe(true);
  });

  it("表があれば作る文とスキーマの鎖を打たない", async () => {
    const fake = fakeDb({ tablePresent: true });
    await claimBinding(fake, PROJECT);
    expect(fake.statements().some((x) => x.includes("CREATE"))).toBe(false);
    expect(fake.statements().some((x) => x.includes("nd-prep:schema"))).toBe(false);
  });

  it("当たる行も資源も無ければ bound で行を足す", async () => {
    const fake = fakeDb();
    expect(await claimBinding(fake, PROJECT)).toBe("bound");
    expect(fake.statements().some((x) => x.includes("INSERT INTO nd_prep.bindings"))).toBe(true);
  });

  it("当たる行が無いがデータベースか役割が既にあれば conflict で行を足さない", async () => {
    for (const s of [{ databaseExists: true }, { roleExists: true }]) {
      const fake = fakeDb(s);
      expect(await claimBinding(fake, PROJECT)).toBe("conflict");
      expect(fake.statements().some((x) => x.includes("INSERT"))).toBe(false);
    }
  });

  it("当たる行が 1 つで 3 つの値がすべて同じなら retry", async () => {
    const fake = fakeDb({
      bindings: [{ project_id: PROJECT.projectId, database_name: PROJECT.database, role_name: PROJECT.role }],
      databaseExists: true,
      roleExists: true,
    });
    expect(await claimBinding(fake, PROJECT)).toBe("retry");
    expect(fake.statements().some((x) => x.includes("INSERT"))).toBe(false);
  });

  it("当たる行の値のどれかが違うか、当たる行が 2 つ以上なら conflict", async () => {
    const row = { project_id: PROJECT.projectId, database_name: PROJECT.database, role_name: PROJECT.role };
    for (const bindings of [
      [{ ...row, project_id: "prj_acme_b" }],
      [{ ...row, database_name: "acme_db_bbbbbbbb" }],
      [{ ...row, role_name: "acme_role_bbbbbbbb" }],
      [
        { ...row, role_name: "acme_role_bbbbbbbb" },
        { ...row, project_id: "prj_acme_c", database_name: "acme_db_cccccccc" },
      ],
    ]) {
      const fake = fakeDb({ bindings });
      expect(await claimBinding(fake, PROJECT)).toBe("conflict");
      expect(fake.statements().some((x) => x.includes("INSERT"))).toBe(false);
    }
  });

  it("途中の文が投げたら rollback して投げ、commit を呼ばない", async () => {
    const fake = fakeDb();
    const failure = new Error("boom");
    fake.failOn = (c) => (c.kind === "execute" && c.sql.includes("INSERT") ? failure : undefined);
    await expect(claimBinding(fake, PROJECT)).rejects.toBe(failure);
    expect(fake.calls.at(-1)).toEqual({ kind: "rollback", transactionId: "tx-1" });
    expect(fake.calls.some((c) => c.kind === "commit")).toBe(false);
  });

  it("rollback も投げたら元の失敗を投げる", async () => {
    const fake = fakeDb();
    const failure = new Error("boom");
    fake.failOn = (c) => {
      if (c.kind === "execute" && c.sql.includes("INSERT")) return failure;
      if (c.kind === "rollback") return new Error("rollback failed");
      return undefined;
    };
    await expect(claimBinding(fake, PROJECT)).rejects.toBe(failure);
  });

  it("commit が投げたらそのまま投げる", async () => {
    const fake = fakeDb();
    const failure = new Error("commit lost");
    fake.failOn = (c) => (c.kind === "commit" ? failure : undefined);
    await expect(claimBinding(fake, PROJECT)).rejects.toBe(failure);
  });
});

describe("checkIsolationGuard（作り物の SqlExecutor）", () => {
  it("データベースも役割も無ければ ok", async () => {
    expect(await checkIsolationGuard(fakeDb({ guardDatabase: undefined }), PROJECT)).toBe("ok");
  });

  it("接続を許さないデータベースでは PUBLIC の CONNECT を数えない", async () => {
    const fake = fakeDb({ guardDatabase: { allow: false, others: 0, public_connect: true } });
    expect(await checkIsolationGuard(fake, PROJECT)).toBe("ok");
  });

  it("接続を許すデータベースで PUBLIC が CONNECT を持てば conflict", async () => {
    const fake = fakeDb({ guardDatabase: { allow: true, others: 0, public_connect: true } });
    expect(await checkIsolationGuard(fake, PROJECT)).toBe("conflict");
  });

  it("データベースがほかの役割へ結ばれていれば conflict", async () => {
    const fake = fakeDb({ guardDatabase: { allow: true, others: 1, public_connect: false } });
    expect(await checkIsolationGuard(fake, PROJECT)).toBe("conflict");
  });

  it("役割がほかのデータベースへ結ばれていれば conflict", async () => {
    const fake = fakeDb({ guardDatabase: undefined, guardRoleOtherDatabases: 1 });
    expect(await checkIsolationGuard(fake, PROJECT)).toBe("conflict");
  });

  it("管理のデータベースで打ち、名前は引数で渡す", async () => {
    const fake = fakeDb();
    await checkIsolationGuard(fake, PROJECT);
    for (const c of fake.calls) {
      expect(c.kind).toBe("execute");
      if (c.kind !== "execute") continue;
      expect(c.database).toBe(ADMIN_DATABASE);
      expect(c.sql).not.toContain(PROJECT.database);
      expect(c.sql).not.toContain(PROJECT.role);
    }
  });
});

describe("provisionProject（作り物の SqlExecutor）", () => {
  it("CREATE DATABASE は管理のデータベースでトランザクションの外で打ち、ALLOW_CONNECTIONS false で作る", async () => {
    const fake = fakeDb({ databaseExists: false });
    await provisionProject(fake, { ...PROJECT, password: PASSWORD });
    const create = fake.calls.find((c) => c.kind === "execute" && c.sql.startsWith("CREATE DATABASE"));
    expect(create).toMatchObject({ database: ADMIN_DATABASE, transactionId: undefined });
    expect(create?.kind === "execute" && create.sql).toBe(`CREATE DATABASE ${escapeIdentifier(PROJECT.database)} WITH ALLOW_CONNECTIONS false`);
  });

  it("手順の 1〜6 の順に打つ", async () => {
    const fake = fakeDb({ databaseExists: false, roleExists: false });
    await provisionProject(fake, { ...PROJECT, password: PASSWORD });
    const s = fake.statements();
    const db = escapeIdentifier(PROJECT.database);
    const role = escapeIdentifier(PROJECT.role);
    const at = (needle: string): number => {
      const i = s.findIndex((x) => x.includes(needle));
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at('REVOKE CONNECT, TEMPORARY ON DATABASE "postgres" FROM PUBLIC'),
      at('REVOKE CONNECT, TEMPORARY ON DATABASE "template1" FROM PUBLIC'),
      at("CREATE DATABASE"),
      at(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`),
      at(`ALTER DATABASE ${db} WITH ALLOW_CONNECTIONS true`),
      at("REVOKE SELECT ON"),
      at("pg_terminate_backend"),
      at(`CREATE ROLE ${role} WITH LOGIN PASSWORD`),
      at(`CREATE SCHEMA IF NOT EXISTS ${role} AUTHORIZATION ${role}`),
      at(`ALTER ROLE ${role} SET search_path TO ${role}`),
      at(`GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${role}`),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 最後に与える
    expect(order.at(-1)).toBe(s.length - 1);
  });

  it("4 のカタログの外しと 6 のスキーマはプロジェクトのデータベースで打ち、ほかは管理のデータベースで打つ", async () => {
    const fake = fakeDb();
    await provisionProject(fake, { ...PROJECT, password: PASSWORD });
    for (const c of fake.calls) {
      if (c.kind !== "execute") continue;
      const inProject = c.sql.startsWith("REVOKE SELECT ON") || c.sql.includes("AS name") || c.sql.includes("SCHEMA");
      expect(c.database, c.sql).toBe(inProject ? PROJECT.database : ADMIN_DATABASE);
    }
  });

  it("3 の REVOKE と ALLOW_CONNECTIONS true を 1 つのトランザクションで打つ", async () => {
    const fake = fakeDb();
    await provisionProject(fake, { ...PROJECT, password: PASSWORD });
    const db = escapeIdentifier(PROJECT.database);
    const revoke = fake.calls.find((c) => c.kind === "execute" && c.sql === `REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
    const allow = fake.calls.find((c) => c.kind === "execute" && c.sql === `ALTER DATABASE ${db} WITH ALLOW_CONNECTIONS true`);
    expect(revoke?.kind === "execute" && revoke.transactionId).toBeTruthy();
    expect(allow?.kind === "execute" && allow.transactionId).toBe(revoke?.kind === "execute" && revoke.transactionId);
  });

  it("データベースが既にあれば作らない（作り直し）", async () => {
    const fake = fakeDb({ databaseExists: true });
    await provisionProject(fake, { ...PROJECT, password: PASSWORD });
    expect(fake.statements().some((x) => x.startsWith("CREATE DATABASE"))).toBe(false);
  });

  it("役割が既にあれば ALTER ROLE でパスワードを書き直す（作り直し）", async () => {
    const fake = fakeDb({ databaseExists: true, roleExists: true });
    await provisionProject(fake, { ...PROJECT, password: PASSWORD });
    const role = escapeIdentifier(PROJECT.role);
    expect(fake.statements().some((x) => x.startsWith(`ALTER ROLE ${role} WITH LOGIN PASSWORD 'SCRAM-SHA-256$4096:`))).toBe(true);
    expect(fake.statements().some((x) => x.startsWith("CREATE ROLE"))).toBe(false);
  });

  it("文と引数のどれにもパスワードの平文が現れない（作る・作り直しの両方）", async () => {
    for (const roleExists of [false, true]) {
      const fake = fakeDb({ roleExists, databaseExists: roleExists });
      await provisionProject(fake, { ...PROJECT, password: PASSWORD });
      const texts = allText(fake.calls);
      expect(texts.some((t) => t.includes("SCRAM-SHA-256$"))).toBe(true);
      for (const t of texts) expect(t).not.toContain(PASSWORD);
    }
  });

  it("用意の文と結び付きと守りの文はどれも 4 KiB 未満", async () => {
    const calls: SqlCall[] = [];
    for (const state of [{ tablePresent: false }, { roleExists: true, databaseExists: true }, {}]) {
      const fake = fakeDb(state);
      await claimBinding(fake, PROJECT);
      await checkIsolationGuard(fake, PROJECT);
      await provisionProject(fake, { ...PROJECT, password: PASSWORD });
      calls.push(...fake.calls);
    }
    const sizes = calls.flatMap((c) => (c.kind === "execute" ? [Buffer.byteLength(c.sql, "utf8")] : []));
    expect(sizes.length).toBeGreaterThan(10);
    for (const n of sizes) expect(n).toBeLessThan(STATEMENT_LIMIT);
  });

  it("SQL が投げたら、その先を打たずに投げる", async () => {
    const fake = fakeDb();
    const failure = new Error("boom");
    fake.failOn = (c) => (c.kind === "execute" && c.sql.startsWith("CREATE DATABASE") ? failure : undefined);
    await expect(provisionProject(fake, { ...PROJECT, password: PASSWORD })).rejects.toBe(failure);
    expect(fake.statements().some((x) => x.includes("CREATE ROLE"))).toBe(false);
  });

  it("トランザクションの中の文が投げたら rollback して投げる", async () => {
    const fake = fakeDb();
    const failure = new Error("boom");
    fake.failOn = (c) => (c.kind === "execute" && c.sql.startsWith("ALTER DATABASE") ? failure : undefined);
    await expect(provisionProject(fake, { ...PROJECT, password: PASSWORD })).rejects.toBe(failure);
    expect(fake.calls.at(-1)?.kind).toBe("rollback");
  });

  it("印字できない文字のパスワードは SQL を打たずに投げる", async () => {
    const fake = fakeDb();
    await expect(provisionProject(fake, { ...PROJECT, password: "acme\u0000pw" })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});

// --- PostgreSQL のサービスコンテナ ---

function suffix(): string {
  return randomBytes(5).toString("hex");
}

type TestProject = ProjectIdent & { password: string };

function newProject(db: TestDatabase, label: string): TestProject {
  const s = suffix();
  const p: TestProject = {
    projectId: `prj_acme_${label}_${s}`,
    database: `acme_${label}_db_${s}`,
    role: `acme_${label}_role_${s}`,
    password: randomBytes(24).toString("base64url"),
  };
  db.dropDatabaseLater(p.database);
  db.dropRoleLater(p.role);
  return p;
}

// 関数の用意の段（結び付き → 守り → 手順）。どちらかが conflict なら手順を打たない
async function prepare(sql: SqlExecutor, p: TestProject): Promise<"bound" | "retry" | "conflict"> {
  const bound = await claimBinding(sql, p);
  if (bound === "conflict") return bound;
  if ((await checkIsolationGuard(sql, p)) === "conflict") return "conflict";
  await provisionProject(sql, p);
  return bound;
}

// 指定の文で投げる SqlExecutor。途中で止まった作成を作る
function stopAt(inner: SqlExecutor, matches: (sql: string) => boolean): SqlExecutor {
  return {
    ...inner,
    execute: (s, p, o) => (matches(s) ? Promise.reject(new Error("止めた")) : inner.execute(s, p, o)),
  };
}

async function canConnect(db: TestDatabase, database: string, p: TestProject, password = p.password): Promise<boolean> {
  try {
    const c = await db.connect(database, { user: p.role, password });
    await c.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// その役割の接続から読める名前。読めなければ空
async function readableNames(db: TestDatabase, p: TestProject, query: string): Promise<string[]> {
  const c = await db.connect(p.database, { user: p.role, password: p.password });
  try {
    const res = await c.query<{ name: string }>(query);
    return res.rows.map((r) => r.name);
  } catch {
    return [];
  }
}

// 管理の役割（所有者）のほかに CONNECT を持つ役割
async function connectGrantees(db: TestDatabase, database: string): Promise<string[]> {
  const c = await db.connect();
  const res = await c.query<{ name: string }>(
    `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname::text END AS name
       FROM pg_database d
       CROSS JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
       LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE d.datname = $1 AND a.privilege_type = 'CONNECT' AND a.grantee <> d.datdba
      ORDER BY 1`,
    [database],
  );
  return res.rows.map((r) => r.name);
}

describePg("provisionProject（PostgreSQL）", () => {
  it("2 つのプロジェクトを作り、A の役割で A へ接続でき、B・postgres・template1 へ接続できない", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      const b = newProject(db, "b");
      expect(await prepare(sql, a)).toBe("bound");
      expect(await prepare(sql, b)).toBe("bound");

      expect(await canConnect(db, a.database, a)).toBe(true);
      expect(await canConnect(db, b.database, a)).toBe(false);
      expect(await canConnect(db, "postgres", a)).toBe(false);
      expect(await canConnect(db, "template1", a)).toBe(false);
      expect(await canConnect(db, b.database, b)).toBe(true);
      expect(await canConnect(db, a.database, b)).toBe(false);
      // ほかの役割の CONNECT は無い
      expect(await connectGrantees(db, a.database)).toEqual([a.role]);
    });
  });

  it("A の役割で pg_database と pg_roles から B の名前を読めない", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      const b = newProject(db, "b");
      await prepare(sql, a);
      await prepare(sql, b);
      const databases = await readableNames(db, a, "SELECT datname::text AS name FROM pg_database");
      const roles = await readableNames(db, a, "SELECT rolname::text AS name FROM pg_roles");
      const activity = await readableNames(db, a, "SELECT coalesce(datname, '')::text AS name FROM pg_stat_activity");
      expect(databases).not.toContain(b.database);
      expect(roles).not.toContain(b.role);
      expect(activity).not.toContain(b.database);
    });
  });

  it("役割は自分のスキーマを持ち、search_path がそこを指し、一時表を作れる", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      await prepare(sql, a);
      const c = await db.connect(a.database, { user: a.role, password: a.password });
      expect((await c.query<{ p: string }>("SHOW search_path")).rows[0]?.p).toBe(a.role);
      await c.query("CREATE TABLE acme_t (id int)");
      const owner = await c.query<{ s: string }>("SELECT n.nspname::text AS s FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace WHERE t.relname = 'acme_t'");
      expect(owner.rows[0]?.s).toBe(a.role);
      await c.query("CREATE TEMPORARY TABLE acme_tmp (id int)");
    });
  });

  it("同じ値で 2 回打っても同じ結果になる", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      expect(await prepare(sql, a)).toBe("bound");
      const grantees = await connectGrantees(db, a.database);
      expect(await prepare(sql, a)).toBe("retry");
      expect(await connectGrantees(db, a.database)).toEqual(grantees);
      expect(await canConnect(db, a.database, a)).toBe(true);
    });
  });

  it("作り直しで渡したパスワードに書き直し、古いパスワードで接続できない", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      await prepare(sql, a);
      const old = a.password;
      const again = { ...a, password: randomBytes(24).toString("base64url") };
      expect(await prepare(sql, again)).toBe("retry");
      expect(await canConnect(db, a.database, again)).toBe(true);
      expect(await canConnect(db, a.database, again, old)).toBe(false);
    });
  });

  it("作り直しで、権限を整える前から残る他の役割の接続を切る", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      await prepare(sql, a);
      // 管理の手で別の役割を作って A のデータベースへ繋がせ、作り直しで切られることを見る
      const intruder = `acme_x_role_${suffix()}`;
      const intruderPassword = randomBytes(24).toString("base64url");
      db.dropRoleLater(intruder);
      const admin = await db.connect();
      await admin.query(`CREATE ROLE ${escapeIdentifier(intruder)} LOGIN PASSWORD '${intruderPassword}'`);
      await admin.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(a.database)} TO ${escapeIdentifier(intruder)}`);
      const conn = await db.connect(a.database, { user: intruder, password: intruderPassword });
      await conn.query("SELECT 1");
      await admin.query(`REVOKE CONNECT ON DATABASE ${escapeIdentifier(a.database)} FROM ${escapeIdentifier(intruder)}`);
      await provisionProject(sql, a);
      await expect(conn.query("SELECT 1")).rejects.toThrow();
    });
  });
});

describePg("claimBinding（PostgreSQL）", () => {
  it("新しい名前で bound", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      expect(await claimBinding(sql, a)).toBe("bound");
      const rows = await sql.execute(
        "SELECT project_id::text AS p, database_name::text AS d, role_name::text AS r FROM nd_prep.bindings",
        undefined,
        { database: ADMIN_DATABASE },
      );
      expect(rows).toEqual([{ p: a.projectId, d: a.database, r: a.role }]);
      const acl = await sql.execute(
        `SELECT has_table_privilege('public', 'nd_prep.bindings', 'SELECT') AS public_select,
                has_schema_privilege('public', 'nd_prep', 'USAGE') AS public_usage`,
        undefined,
        { database: ADMIN_DATABASE },
      );
      expect(acl).toEqual([{ public_select: false, public_usage: false }]);
    });
  });

  it("受け取りの表が先にあるスキーマにも表を作る", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      await sql.execute("CREATE SCHEMA nd_prep", undefined, { database: ADMIN_DATABASE });
      expect(await claimBinding(sql, newProject(db, "a"))).toBe("bound");
    });
  });

  it("A の作成を最後の GRANT の前で止めると、A の打ち直しが retry で用意を終える", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      const stopped = stopAt(sql, (s) => s.startsWith("GRANT CONNECT"));
      await expect(prepare(stopped, a)).rejects.toThrow("止めた");
      expect(await canConnect(db, a.database, a)).toBe(false);
      expect(await prepare(sql, a)).toBe("retry");
      expect(await canConnect(db, a.database, a)).toBe(true);
    });
  });

  it("途中で止まった A の名前を B が渡すと、どの組み合わせでも conflict", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      const b = newProject(db, "b");
      await expect(prepare(stopAt(sql, (s) => s.startsWith("GRANT CONNECT")), a)).rejects.toThrow("止めた");
      for (const ident of [
        { projectId: b.projectId, database: a.database, role: b.role },
        { projectId: b.projectId, database: b.database, role: a.role },
        { projectId: b.projectId, database: a.database, role: a.role },
        // A の ID で別の名前を渡す
        { projectId: a.projectId, database: b.database, role: b.role },
      ]) {
        expect(await claimBinding(sql, ident), JSON.stringify(ident)).toBe("conflict");
      }
      // 何も足していない
      const rows = await sql.execute("SELECT count(*)::int AS n FROM nd_prep.bindings", undefined, { database: ADMIN_DATABASE });
      expect(rows).toEqual([{ n: 1 }]);
    });
  });

  it("結び付きの行の無い既存のデータベースか役割で conflict", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      const b = newProject(db, "b");
      const admin = await db.connect();
      await admin.query(`CREATE DATABASE ${escapeIdentifier(a.database)}`);
      await admin.query(`CREATE ROLE ${escapeIdentifier(b.role)}`);
      expect(await claimBinding(sql, a)).toBe("conflict");
      expect(await claimBinding(sql, b)).toBe("conflict");
      // 管理のデータベースの名前も行が無いため conflict
      expect(await claimBinding(sql, { ...newProject(db, "c"), database: "template1" })).toBe("conflict");
    });
  });

  it("同じ名前の 2 つのプロジェクトを同時に打つと、片方だけが bound", async () => {
    await withTestDatabase(async (db) => {
      const x = db.executor();
      const y = db.executor();
      // 1 回目は表の無い DB で、表を作る段も重ねる
      for (let i = 0; i < 4; i++) {
        const a = newProject(db, "a");
        const b = { ...a, projectId: `${a.projectId}_other` };
        const results = await Promise.all([claimBinding(x, a), claimBinding(y, b)]);
        expect(results.sort()).toEqual(["bound", "conflict"]);
      }
    });
  });
});

describePg("checkIsolationGuard（PostgreSQL）", () => {
  it("新しい名前で ok", async () => {
    await withTestDatabase(async (db) => {
      expect(await checkIsolationGuard(db.executor(), newProject(db, "a"))).toBe("ok");
    });
  });

  it("作り直し（片方だけある）で ok", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      await prepare(sql, a);
      const admin = await db.connect();
      // 役割だけ残す
      await admin.query(`DROP DATABASE ${escapeIdentifier(a.database)} WITH (FORCE)`);
      expect(await checkIsolationGuard(sql, a)).toBe("ok");
      // データベースだけ残す（役割の持つスキーマと権限を外してから役割を消す）
      const b = newProject(db, "b");
      await prepare(sql, b);
      const inB = await db.connect(b.database);
      await inB.query(`DROP OWNED BY ${escapeIdentifier(b.role)}`);
      await inB.end();
      await admin.query(`DROP ROLE ${escapeIdentifier(b.role)}`);
      expect(await checkIsolationGuard(sql, b)).toBe("ok");
    });
  });

  it("A の作成を ALLOW_CONNECTIONS false の直後・REVOKE の前で止めると、打ち直しが ok で用意を終え、A の役割だけが CONNECT を持つ", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      const revoke = `REVOKE CONNECT, TEMPORARY ON DATABASE ${escapeIdentifier(a.database)} FROM PUBLIC`;
      await expect(prepare(stopAt(sql, (s) => s === revoke), a)).rejects.toThrow("止めた");
      expect(await connectGrantees(db, a.database)).toEqual(["PUBLIC"]);
      expect(await checkIsolationGuard(sql, a)).toBe("ok");
      expect(await prepare(sql, a)).toBe("retry");
      expect(await connectGrantees(db, a.database)).toEqual([a.role]);
    });
  });

  it("B のデータベースに A の役割を渡す・A の役割に B のデータベースを渡すと conflict", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const a = newProject(db, "a");
      const b = newProject(db, "b");
      await prepare(sql, a);
      await prepare(sql, b);
      expect(await checkIsolationGuard(sql, { projectId: a.projectId, database: b.database, role: a.role })).toBe("conflict");
      expect(await checkIsolationGuard(sql, { projectId: b.projectId, database: b.database, role: a.role })).toBe("conflict");
      expect(await checkIsolationGuard(sql, { projectId: a.projectId, database: a.database, role: b.role })).toBe("conflict");
    });
  });

  it("ALLOW_CONNECTIONS true で PUBLIC が CONNECT を持つ既存のデータベースで conflict", async () => {
    await withTestDatabase(async (db) => {
      const a = newProject(db, "a");
      const admin = await db.connect();
      await admin.query(`CREATE DATABASE ${escapeIdentifier(a.database)}`);
      expect(await checkIsolationGuard(db.executor(), a)).toBe("conflict");
    });
  });
});
