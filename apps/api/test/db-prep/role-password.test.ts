import { randomBytes } from "node:crypto";
import { escapeIdentifier } from "pg";
import { describe, expect, it } from "vitest";
import { prepareRolePassword, rolePasswordStatement } from "../../src/db-prep/role-password.ts";
import { ADMIN_DATABASE, type SqlExecutor } from "../../src/db-prep/sql-executor.ts";
import { FakeSqlExecutor } from "./fake-sql-executor.ts";
import { type TestDatabase, describePg, withTestDatabase } from "./pg-executor.ts";

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

describe("prepareRolePassword（作り物の SqlExecutor）", () => {
  it("検証子を引数で渡し、同じトランザクションで DO を打つ。平文と検証子はどの文の本文にも無い", async () => {
    const fake = new FakeSqlExecutor();
    const opts = { database: ADMIN_DATABASE, transactionId: "tx-1" };
    await prepareRolePassword(ROLE, PASSWORD, "alter")(fake, opts);
    const ex = fake.calls.flatMap((c) => (c.kind === "execute" ? [c] : []));
    expect(ex).toHaveLength(2);
    expect(ex[0]!.sql).toContain("set_config('nd_prep.role_verifier', CAST(:verifier AS text), true)");
    expect(ex[0]!.params).toEqual([{ name: "verifier", value: expect.stringMatching(/^SCRAM-SHA-256\$4096:/) }]);
    for (const c of ex) {
      expect(c.transactionId).toBe("tx-1");
      expect(c.sql).not.toContain("SCRAM-SHA-256$");
      expect(c.sql).not.toContain(PASSWORD);
      expect(JSON.stringify(c.params ?? [])).not.toContain(PASSWORD);
    }
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
