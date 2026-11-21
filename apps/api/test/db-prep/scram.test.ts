import { randomBytes } from "node:crypto";
import { escapeIdentifier, escapeLiteral } from "pg";
import { describe, expect, it } from "vitest";
import { scramVerifier } from "../../src/db-prep/scram.ts";
import { describePg, withTestDatabase } from "./pg-executor.ts";

const SHAPE = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

// API が作るパスワードと同じ形の作り物（base64url の文字だけ）
function fakePassword(): string {
  return randomBytes(32).toString("base64url");
}

function roleName(): string {
  return `nd_test_role_${randomBytes(6).toString("hex")}`;
}

describe("scramVerifier", () => {
  it("PostgreSQL の形で、既定は回数 4096・塩 16 バイト", () => {
    const m = SHAPE.exec(scramVerifier(fakePassword()));
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe("4096");
    expect(Buffer.from(m?.[2] ?? "", "base64")).toHaveLength(16);
    expect(Buffer.from(m?.[3] ?? "", "base64")).toHaveLength(32);
    expect(Buffer.from(m?.[4] ?? "", "base64")).toHaveLength(32);
  });

  it("同じ塩と回数なら同じ値になる", () => {
    const salt = randomBytes(16);
    const p = fakePassword();
    expect(scramVerifier(p, { salt, iterations: 4096 })).toBe(scramVerifier(p, { salt, iterations: 4096 }));
    expect(scramVerifier(p, { salt, iterations: 4096 })).not.toBe(scramVerifier(p, { salt, iterations: 4097 }));
  });

  it("呼ぶたびに塩が変わり、同じパスワードでも違う検証子になる", () => {
    const p = fakePassword();
    const a = SHAPE.exec(scramVerifier(p));
    const b = SHAPE.exec(scramVerifier(p));
    expect(a?.[2]).not.toBe(b?.[2]);
    expect(a?.[0]).not.toBe(b?.[0]);
  });

  it("印字できない文字・ASCII の外の文字・空のパスワードで投げる", () => {
    for (const bad of ["pass\u0000word", "tab\tword", "line\nword", "pässword", "あ", ""]) {
      expect(() => scramVerifier(bad)).toThrow();
    }
  });

  it("投げた例外の文にパスワードが現れない", () => {
    const secret = "acme-secret-\u0001";
    let message = "";
    try {
      scramVerifier(secret);
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("acme-secret");
  });

  it("回数が 1 未満・整数でない、塩が空なら投げる", () => {
    expect(() => scramVerifier("abc", { iterations: 0 })).toThrow();
    expect(() => scramVerifier("abc", { iterations: 1.5 })).toThrow();
    expect(() => scramVerifier("abc", { salt: new Uint8Array(0) })).toThrow();
  });
});

describePg("scramVerifier（PostgreSQL）", () => {
  it("PostgreSQL が平文から作った検証子の塩と回数を渡すと、同じ値を返す", async () => {
    await withTestDatabase(async (db) => {
      const admin = await db.connect();
      const role = roleName();
      db.dropRoleLater(role);
      const password = fakePassword();
      await admin.query("SET password_encryption = 'scram-sha-256'");
      await admin.query(`CREATE ROLE ${escapeIdentifier(role)} LOGIN PASSWORD ${escapeLiteral(password)}`);
      // テストの準備でだけ読む（関数は pg_authid を読まない）
      const res = await admin.query<{ rolpassword: string }>("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [role]);
      const stored = res.rows[0]?.rolpassword ?? "";
      const m = SHAPE.exec(stored);
      expect(m).not.toBeNull();
      const iterations = Number(m?.[1]);
      const salt = Buffer.from(m?.[2] ?? "", "base64");
      expect(scramVerifier(password, { salt, iterations })).toBe(stored);
    });
  });

  it("検証子で作った役割へ、平文のパスワードで接続が通り、違う平文では落ちる", async () => {
    await withTestDatabase(async (db) => {
      const admin = await db.connect();
      const role = roleName();
      db.dropRoleLater(role);
      const password = fakePassword();
      await admin.query(`CREATE ROLE ${escapeIdentifier(role)} LOGIN PASSWORD ${escapeLiteral(scramVerifier(password))}`);

      const client = await db.connect(db.name, { user: role, password });
      const who = await client.query<{ u: string }>("SELECT current_user::text AS u");
      expect(who.rows[0]?.u).toBe(role);

      const err = await db.connect(db.name, { user: role, password: fakePassword() }).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("28P01");
    });
  });
});
