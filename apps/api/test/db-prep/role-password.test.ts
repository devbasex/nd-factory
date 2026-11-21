import { randomBytes } from "node:crypto";
import { escapeIdentifier } from "pg";
import { describe, expect, it } from "vitest";
import { auditClasses, paramLogProblem, prepareRolePassword, rolePasswordStatement } from "../../src/db-prep/role-password.ts";
import { ADMIN_DATABASE, type Row, type SqlExecutor } from "../../src/db-prep/sql-executor.ts";
import { FakeSqlExecutor } from "./fake-sql-executor.ts";
import { type PgExecutor, type TestDatabase, createPgExecutor, describePg, withTestDatabase } from "./pg-executor.ts";

// 作り物の値だけを使う
const ROLE = "acme_role_aaaaaaaa";
const PASSWORD = "acme-Role-Password-0123456789abcdefghij";

describe("rolePasswordStatement", () => {
  it("DO の本文に載るのは役割の名前と決まった文だけで、引数の印（:）を持たない", () => {
    for (const mode of ["create_login", "alter_login", "alter"] as const) {
      const s = rolePasswordStatement(ROLE, mode);
      expect(s.startsWith("DO $nd_role_password$")).toBe(true);
      expect(s).toContain(`'${ROLE}'`);
      expect(s).not.toContain(":");
      expect(s).not.toContain("SCRAM-SHA-256");
      // 打った文の失敗と文の取り消しを受けて、決まった文の誤りに替える
      expect(s).toContain("EXCEPTION WHEN query_canceled OR others THEN");
      expect(s).toContain("ERRCODE = SQLSTATE");
    }
  });

  it("形に合わない役割の名前は投げ、例外の文に名前を入れない", () => {
    for (const role of ["Acme_Secret_Role", "acme'); DROP ROLE x; --", "a"]) {
      expect(() => rolePasswordStatement(role, "alter")).toThrow("役割の名前が形に合わない");
    }
  });
});

describe("pgAudit の設定の読み", () => {
  it("分類の並びを pgAudit と同じく左から読み、all と none と引き算と引用符を受ける", () => {
    expect([...(auditClasses("ddl, role") ?? [])].sort()).toEqual(["ddl", "role"]);
    expect(auditClasses("all, -role")?.has("role")).toBe(false);
    expect(auditClasses("ALL")?.has("role")).toBe(true);
    // none はビットを足さないだけで、先に効いた分類を消さない
    expect([...(auditClasses("role, none") ?? [])]).toEqual(["role"]);
    expect(auditClasses("none, role")?.has("role")).toBe(true);
    expect(auditClasses("all, -none")?.has("role")).toBe(true);
    expect(auditClasses("none")?.size).toBe(0);
    // 引用符の付いた名前も分類として読み、大小を問わない
    expect(auditClasses('"role"')?.has("role")).toBe(true);
    expect(auditClasses('ddl,"ROLE"')?.has("role")).toBe(true);
    expect(auditClasses('all, "-role"')?.has("role")).toBe(false);
    expect(auditClasses(" ddl ,\twrite ")?.has("write")).toBe(true);
    expect(auditClasses("")?.size).toBe(0);
    expect(auditClasses("  ")?.size).toBe(0);
  });

  it("pgAudit が受けない並び（形の誤り・知らない分類）は読めないとする", () => {
    for (const list of ["ddl,", ",ddl", "ddl role", '"role', '""', "-\"role\"", "roles", "ddl,,role", '" role"']) {
      expect(auditClasses(list)).toBeUndefined();
    }
  });

  it("pgAudit が無いか、引数の値も役割の文も書かない設定なら通す", () => {
    const safe = { normal: "0", on_error: "0", print_plan: "off", print_parse: "off", print_rewritten: "off", explain_min_duration: null };
    for (const audit of [
      { audit_log: null, audit_parameter: null },
      { audit_log: "none", audit_parameter: "off" },
      { audit_log: "ddl, write", audit_parameter: "off" },
      { audit_log: "all, -role", audit_parameter: "off" },
      { audit_log: "ddl, none", audit_parameter: "off" },
    ]) {
      expect(paramLogProblem({ ...safe, ...audit })).toBeUndefined();
    }
  });

  it("pg_stat_statements が無いか、入れ子の utility 文を追わない設定なら通し、追う設定なら止める", () => {
    const safe = { normal: "0", on_error: "0", print_plan: "off", print_parse: "off", print_rewritten: "off", explain_min_duration: null };
    for (const stmts of [
      { stmts_track: null, stmts_track_utility: null },
      { stmts_track: "top", stmts_track_utility: "on" },
      { stmts_track: "none", stmts_track_utility: "on" },
      { stmts_track: "all", stmts_track_utility: "off" },
    ]) {
      expect(paramLogProblem({ ...safe, ...stmts })).toBeUndefined();
    }
    for (const stmts of [
      { stmts_track: "all", stmts_track_utility: "on" },
      { stmts_track: "ALL", stmts_track_utility: null },
    ]) {
      expect(paramLogProblem({ ...safe, ...stmts })).toContain("pg_stat_statements");
    }
  });
});

describe("prepareRolePassword（作り物の SqlExecutor）", () => {
  it("検証子を引数で渡し、同じトランザクションで DO を打つ。平文と検証子はどの文の本文にも無い", async () => {
    const fake = new FakeSqlExecutor();
    const opts = { database: ADMIN_DATABASE, transactionId: "tx-1" };
    await prepareRolePassword(ROLE, PASSWORD, "alter")(fake, opts);
    const ex = fake.calls.flatMap((c) => (c.kind === "execute" ? [c] : []));
    expect(ex).toHaveLength(3);
    // 検証子を送る前に、通常の文の設定と pgAudit の設定を読み、失敗の文の設定を置く
    expect(ex[0]!.sql).toContain("current_setting('log_parameter_max_length')");
    expect(ex[0]!.sql).not.toContain("set_config('log_parameter_max_length'");
    expect(ex[0]!.sql).toContain("set_config('log_parameter_max_length_on_error', '0', true)");
    expect(ex[0]!.sql).toContain("set_config('debug_print_plan', 'off', true)");
    expect(ex[0]!.sql).toContain("set_config('debug_print_parse', 'off', true)");
    expect(ex[0]!.sql).toContain("set_config('debug_print_rewritten', 'off', true)");
    expect(ex[0]!.sql).toContain("current_setting('pg_stat_statements.track', true)");
    expect(ex[0]!.sql).toContain("current_setting('pg_stat_statements.track_utility', true)");
    expect(ex[0]!.sql).toContain("current_setting('auto_explain.log_min_duration', true)");
    expect(ex[0]!.sql).toContain("current_setting('pgaudit.log', true)");
    expect(ex[0]!.sql).toContain("current_setting('pgaudit.log_parameter', true)");
    expect(ex[0]!.params).toBeUndefined();
    expect(ex[1]!.sql).toContain("set_config('nd_prep.role_verifier', CAST(:verifier AS text), true)");
    expect(ex[1]!.params).toEqual([{ name: "verifier", value: expect.stringMatching(/^SCRAM-SHA-256\$4096:/) }]);
    for (const c of ex) {
      expect(c.transactionId).toBe("tx-1");
      expect(c.sql).not.toContain("SCRAM-SHA-256$");
      expect(c.sql).not.toContain(PASSWORD);
      expect(JSON.stringify(c.params ?? [])).not.toContain(PASSWORD);
    }
  });

  it("引数の値を記録しない設定か pgAudit の設定が安全と読めなければ、検証子を送らずに投げる", async () => {
    const safe = {
      normal: "0",
      on_error: "0",
      print_plan: "off",
      print_parse: "off",
      print_rewritten: "off",
      explain_min_duration: null,
      audit_log: null,
      audit_parameter: null,
    };
    const rows: Row[] = [
      { ...safe, normal: "-1" },
      { ...safe, normal: "64B" },
      { ...safe, on_error: "64B" },
      { ...safe, print_plan: "on" },
      { ...safe, print_parse: "on" },
      { ...safe, print_rewritten: "on" },
      { ...safe, stmts_track: "all", stmts_track_utility: "on" },
      { ...safe, explain_min_duration: "0" },
      { ...safe, explain_min_duration: "100ms" },
      { ...safe, audit_parameter: "on" },
      { ...safe, audit_log: "ddl, role" },
      { ...safe, audit_log: "all, -misc" },
      { ...safe, audit_log: "role, none" },
      { ...safe, audit_log: '"role"' },
      { ...safe, audit_log: "ddl, roles" },
      {},
    ];
    for (const row of rows) {
      const fake = new FakeSqlExecutor();
      fake.respond = (sql) => (sql.includes("current_setting('log_parameter_max_length')") ? [row] : []);
      const opts = { database: ADMIN_DATABASE, transactionId: "tx-1" };
      await expect(prepareRolePassword(ROLE, PASSWORD, "alter")(fake, opts)).rejects.toThrow("検証子を送らずに止めた");
      expect(fake.statements()).toHaveLength(1);
      expect(JSON.stringify(fake.calls)).not.toContain("SCRAM-SHA-256");
    }
  });

  it("確かめの文が失敗したら、検証子を送らずにその失敗を投げる", async () => {
    const fake = new FakeSqlExecutor();
    fake.failOn = (c) => (c.kind === "execute" && c.sql.includes("log_parameter_max_length") ? new Error("permission denied") : undefined);
    const opts = { database: ADMIN_DATABASE, transactionId: "tx-1" };
    await expect(prepareRolePassword(ROLE, PASSWORD, "alter")(fake, opts)).rejects.toThrow("permission denied");
    expect(fake.statements()).toHaveLength(1);
    expect(JSON.stringify(fake.calls)).not.toContain("SCRAM-SHA-256");
  });

  it("印字できない文字のパスワードは文を作る時に投げ、何も打たない", () => {
    expect(() => prepareRolePassword(ROLE, "acme-パスワード", "alter")).toThrow();
  });
});

// --- PostgreSQL のサービスコンテナ ---

function newPassword(): string {
  return randomBytes(24).toString("base64url");
}

function newRole(db: TestDatabase): string {
  const role = `acme_rp_role_${randomBytes(5).toString("hex")}`;
  db.dropRoleLater(role);
  return role;
}

async function inTx(sql: SqlExecutor, fn: (opts: { database: string; transactionId: string }) => Promise<void>): Promise<void> {
  const tx = await sql.begin({ database: ADMIN_DATABASE });
  try {
    await fn({ database: ADMIN_DATABASE, transactionId: tx });
  } catch (e) {
    await sql.rollback(tx).catch(() => undefined);
    throw e;
  }
  await sql.commit(tx);
}

async function canConnect(db: TestDatabase, role: string, password: string): Promise<boolean> {
  try {
    const c = await db.connect(db.name, { user: role, password });
    await c.end();
    return true;
  } catch {
    return false;
  }
}

// 誤りがクライアントへ返した項目（サーバーのログに書く文・文脈・内側の文と同じ）のどれにも、検証子が無い
function expectNoVerifierIn(e: unknown): void {
  expect(e).toBeInstanceOf(Error);
  const text = JSON.stringify(e, Object.getOwnPropertyNames(e));
  expect(text).not.toContain("SCRAM-SHA-256");
  const fields = e as { where?: string; internalQuery?: string; message: string };
  expect(fields.message).toBe("nd-prep could not write the role password");
  expect(fields.internalQuery ?? "").not.toContain("PASSWORD");
  expect(fields.where ?? "").not.toContain("SQL statement");
}

// 文のログを全部出し（log_statement・log_min_duration_statement）、失敗のログは引数の値を全部書く設定（-1）にした接続で打つ
// SqlExecutor。通常の文のログの引数の長さはクラスタのパラメータと同じ 0 のまま。extra の文を続けて打つ。
// LOG の知らせをクライアントへも送らせ（client_min_messages）、サーバーのログに書く行と同じ文と詳細を集める
// by は通常の文のログの出し方（文のログか、時間のログか）
function loggingExecutor(
  db: TestDatabase,
  notices: string[],
  by: "statement" | "duration" = "statement",
  extra: string[] = [],
): PgExecutor {
  return createPgExecutor(async (database) => {
    const c = await db.connect(database === ADMIN_DATABASE ? db.name : database);
    c.on("notice", (n) => notices.push(JSON.stringify(n, Object.getOwnPropertyNames(n))));
    for (const stmt of [
      "SET client_min_messages = log",
      by === "statement" ? "SET log_statement = 'all'" : "SET log_statement = 'none'",
      by === "duration" ? "SET log_min_duration_statement = 0" : "SET log_min_duration_statement = -1",
      "SET log_min_error_statement = error",
      "SET log_parameter_max_length_on_error = -1",
      ...extra,
    ]) {
      await c.query(stmt);
    }
    return c;
  });
}

// 検証子を置く文を、引数を受けたまま 0 での割り算で失敗させる（失敗のログの引数の書き方を確かめる）
function failingStage(inner: SqlExecutor): SqlExecutor {
  return {
    execute: (sql, params, opts) =>
      inner.execute(sql.includes("nd_prep.role_verifier") && params !== undefined ? `${sql} WHERE 1 / (SELECT 0) = 1` : sql, params, opts),
    begin: (opts) => inner.begin(opts),
    commit: (tx) => inner.commit(tx),
    rollback: (tx) => inner.rollback(tx),
  };
}

// debug_print_plan は定数をバイトの並び（例: "83 67 82 65 77"）で書くため、空白と改行を詰めてその並びも探す
const bytesOf = (text: string): string => [...Buffer.from(text)].join(" ");

function expectNoSecretIn(texts: string[], password: string): void {
  for (const t of texts) {
    expect(t).not.toContain("SCRAM-SHA-256");
    expect(t).not.toContain(password);
    const flat = t.replace(/(\\n|\s)+/g, " ");
    expect(flat).not.toContain(bytesOf("SCRAM-SHA-256"));
    expect(flat).not.toContain(bytesOf(password));
  }
}

describePg("prepareRolePassword のログ（PostgreSQL）", () => {
  it.each(["statement", "duration"] as const)(
    "通常の文のログ（%s）を全部出す設定でも、検証子を置く文のログに引数の値が無く、平文も検証子も出ない",
    async (by) => {
      await withTestDatabase(async (db) => {
        const notices: string[] = [];
        const sql = loggingExecutor(db, notices, by);
        const role = newRole(db);
        const password = newPassword();
        try {
          await inTx(sql, (opts) => prepareRolePassword(role, password, "create_login")(sql, opts));
        } finally {
          await sql.close();
        }
        // ログが出ていることを確かめてから、値の無いことを見る
        const staged = notices.filter((n) => n.includes("nd_prep.role_verifier") && n.includes("set_config"));
        expect(staged.length).toBeGreaterThanOrEqual(1);
        for (const n of staged) expect(n).not.toContain("parameters:");
        expectNoSecretIn(notices, password);
      });
    },
  );

  it("検証子を置く文が失敗しても、失敗のログと返る誤りに引数の値が無く、平文も検証子も出ない", async () => {
    await withTestDatabase(async (db) => {
      const notices: string[] = [];
      const inner = loggingExecutor(db, notices);
      const sql = failingStage(inner);
      const role = newRole(db);
      const password = newPassword();
      const e = await inTx(sql, (opts) => prepareRolePassword(role, password, "create_login")(sql, opts))
        .catch((err: unknown) => err)
        .finally(() => inner.close());
      expect((e as { code?: string }).code).toBe("22012");
      expect(notices.some((n) => n.includes("nd_prep.role_verifier"))).toBe(true);
      expectNoSecretIn([...notices, JSON.stringify(e, Object.getOwnPropertyNames(e))], password);
      expect((e as { where?: string }).where ?? "").not.toContain("parameters");
    });
  });

  it.each([
    ["実行計画を書く設定（debug_print_plan）", "SET debug_print_plan = on", "PLANNEDSTMT"],
    ["構文木を書く設定（debug_print_parse）", "SET debug_print_parse = on", "parse tree:"],
    ["書き換えた構文木を書く設定（debug_print_rewritten）", "SET debug_print_rewritten = on", "rewritten parse tree:"],
  ])("%sでも、トランザクションの中で切り、そのログに検証子も平文も出ない", async (_, stmt, marker) => {
    await withTestDatabase(async (db) => {
      const notices: string[] = [];
      const sql = loggingExecutor(db, notices, "statement", [stmt]);
      const role = newRole(db);
      const password = newPassword();
      try {
        await inTx(sql, (opts) => prepareRolePassword(role, password, "create_login")(sql, opts));
      } finally {
        await sql.close();
      }
      // 確かめの文のログはまだ書かれる（設定が効いていたことを確かめてから、値の無いことを見る）
      expect(notices.some((n) => n.includes(marker))).toBe(true);
      expectNoSecretIn(notices, password);
    });
  });

  it.each([
    ["通常の文のログが引数の値を書く設定", ["SET log_parameter_max_length = -1"]],
    ["auto_explain が実行計画を書く設定", ["LOAD 'auto_explain'", "SET auto_explain.log_min_duration = 0", "SET auto_explain.log_verbose = on"]],
    ["pgAudit が引数の値を書く設定", ["SET pgaudit.log_parameter = 'on'"]],
    ["pgAudit が役割の文を書く設定", ["SET pgaudit.log = 'ddl, role'"]],
    ["pgAudit が none の後にも役割の文を書く設定", ["SET pgaudit.log = 'role, none'"]],
    ["pgAudit が引用符の付いた role で役割の文を書く設定", [`SET pgaudit.log = '"role"'`]],
    [
      "pg_stat_statements が入れ子の utility 文を追う設定",
      ["SET pg_stat_statements.track = 'all'", "SET pg_stat_statements.track_utility = 'on'"],
    ],
  ])("%sでは、検証子を送らずに止まり、パスワードを書かない", async (_, stmts) => {
    await withTestDatabase(async (db) => {
      const notices: string[] = [];
      const sql = loggingExecutor(db, notices, "statement", stmts);
      const role = newRole(db);
      const password = newPassword();
      const e = await inTx(sql, (opts) => prepareRolePassword(role, password, "create_login")(sql, opts))
        .catch((err: unknown) => err)
        .finally(() => sql.close());
      expect((e as Error).message).toContain("検証子を送らずに止めた");
      expect(notices.some((n) => n.includes("nd_prep.role_verifier"))).toBe(false);
      expectNoSecretIn(notices, password);
      const admin = await db.connect();
      const { rows } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      await admin.end();
      expect(rows).toHaveLength(0);
    });
  });

  it("superuser でない管理の役割でも、クラスタの設定が 0 なら権限を要さずに書ける", async () => {
    await withTestDatabase(async (db) => {
      const sql = await db.nonSuperuserExecutor();
      const role = newRole(db);
      await inTx(sql, (opts) => prepareRolePassword(role, newPassword(), "create_login")(sql, opts));
      const admin = await db.connect();
      const { rows } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      await admin.end();
      expect(rows).toHaveLength(1);
    });
  });
});

describePg("prepareRolePassword（PostgreSQL）", () => {
  it("役割を作ってパスワードを書き、書き直すと新しい平文で通り古い平文で落ちる。書いた後は設定が空", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const role = newRole(db);
      const first = newPassword();
      await inTx(sql, (opts) => prepareRolePassword(role, first, "create_login")(sql, opts));
      const admin = await db.connect();
      await admin.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(db.name)} TO ${escapeIdentifier(role)}`);
      await admin.end();
      expect(await canConnect(db, role, first)).toBe(true);

      const second = newPassword();
      await inTx(sql, async (opts) => {
        await prepareRolePassword(role, second, "alter")(sql, opts);
        const [row] = await sql.execute("SELECT current_setting('nd_prep.role_verifier', true) AS v", undefined, opts);
        expect(row?.v).toBe("");
      });
      expect(await canConnect(db, role, second)).toBe(true);
      expect(await canConnect(db, role, first)).toBe(false);
    });
  });

  it("文が失敗しても（役割が無い）、SQLSTATE を残し、返る誤りのどの項目にも検証子が無い", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const role = newRole(db);
      const e = await inTx(sql, (opts) => prepareRolePassword(role, newPassword(), "alter")(sql, opts)).catch((err: unknown) => err);
      expect((e as { code?: string }).code).toBe("42704");
      expectNoVerifierIn(e);
    });
  });

  it("文が取り消されても（statement_timeout）、SQLSTATE を残し、返る誤りのどの項目にも検証子が無い", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const role = newRole(db);
      await inTx(sql, (opts) => prepareRolePassword(role, newPassword(), "create_login")(sql, opts));
      // ほかの接続が役割の行を書き換えたまま確定しないため、ALTER ROLE は待ち、時間切れで取り消される
      const holder = await db.connect();
      await holder.query("BEGIN");
      await holder.query(`ALTER ROLE ${escapeIdentifier(role)} CONNECTION LIMIT 5`);
      try {
        const e = await inTx(sql, async (opts) => {
          await sql.execute("SET LOCAL statement_timeout = '300ms'", undefined, opts);
          await prepareRolePassword(role, newPassword(), "alter")(sql, opts);
        }).catch((err: unknown) => err);
        expect((e as { code?: string }).code).toBe("57014");
        expectNoVerifierIn(e);
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
      }
    });
  });
});
