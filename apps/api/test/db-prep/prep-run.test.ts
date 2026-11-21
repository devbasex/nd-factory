import { describe, expect, it } from "vitest";
import { PREP_RUN_RETENTION_DAYS, claimPrepRun } from "../../src/db-prep/prep-run.ts";
import { ADMIN_DATABASE } from "../../src/db-prep/sql-executor.ts";
import { FakeSqlExecutor } from "./fake-sql-executor.ts";
import { describePg, withTestDatabase } from "./pg-executor.ts";

const ADMIN = { database: ADMIN_DATABASE };

describe("claimPrepRun（作り物の SqlExecutor）", () => {
  function fakeWith(present: boolean, inserted: boolean): FakeSqlExecutor {
    const fake = new FakeSqlExecutor();
    fake.respond = (sql) => {
      if (sql.includes("to_regclass")) return [{ present }];
      if (sql.includes("RETURNING")) return inserted ? [{ prep_id: "prep-1" }] : [];
      return [];
    };
    return fake;
  }

  it("管理のデータベースの 1 つのトランザクションで打ち、値は引数で渡す", async () => {
    const fake = fakeWith(true, true);
    expect(await claimPrepRun(fake, "prep-1")).toBe("first");
    expect(fake.calls[0]).toEqual({ kind: "begin", database: ADMIN_DATABASE });
    expect(fake.calls.at(-1)).toEqual({ kind: "commit", transactionId: "tx-1" });
    const executes = fake.calls.filter((c) => c.kind === "execute");
    for (const c of executes) {
      expect(c.transactionId).toBe("tx-1");
      expect(c.database).toBe(ADMIN_DATABASE);
      expect(c.sql).not.toContain("prep-1");
    }
    expect(executes.flatMap((c) => c.params ?? [])).toEqual(
      expect.arrayContaining([
        { name: "prep_id", value: "prep-1" },
        { name: "retention_days", value: PREP_RUN_RETENTION_DAYS },
      ]),
    );
    expect(PREP_RUN_RETENTION_DAYS).toBe(7);
  });

  it("表が無ければ排他の鎖の下で作ってから記す", async () => {
    const fake = fakeWith(false, true);
    expect(await claimPrepRun(fake, "prep-1")).toBe("first");
    const s = fake.statements();
    const lock = s.findIndex((x) => x.includes("pg_advisory_xact_lock(hashtext('nd-prep:schema'))"));
    const schema = s.findIndex((x) => x.includes("CREATE SCHEMA IF NOT EXISTS nd_prep"));
    const table = s.findIndex((x) => x.includes("CREATE TABLE IF NOT EXISTS nd_prep.prep_runs"));
    const insert = s.findIndex((x) => x.includes("ON CONFLICT (prep_id) DO NOTHING RETURNING prep_id"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(schema);
    expect(schema).toBeLessThan(table);
    expect(table).toBeLessThan(insert);
  });

  it("表があれば作る文を打たない", async () => {
    const fake = fakeWith(true, true);
    await claimPrepRun(fake, "prep-1");
    expect(fake.statements().some((x) => x.includes("CREATE"))).toBe(false);
  });

  it("行を返さなければ duplicate", async () => {
    expect(await claimPrepRun(fakeWith(true, false), "prep-1")).toBe("duplicate");
  });

  it("途中の文が投げたら rollback して投げ、commit を呼ばない", async () => {
    const fake = fakeWith(true, true);
    const failure = new Error("boom");
    fake.failOn = (c) => (c.kind === "execute" && c.sql.includes("INSERT") ? failure : undefined);
    await expect(claimPrepRun(fake, "prep-1")).rejects.toBe(failure);
    expect(fake.calls.at(-1)).toEqual({ kind: "rollback", transactionId: "tx-1" });
    expect(fake.calls.some((c) => c.kind === "commit")).toBe(false);
  });

  it("rollback も投げたら、元の失敗を投げる", async () => {
    const fake = fakeWith(true, true);
    const failure = new Error("boom");
    fake.failOn = (c) => {
      if (c.kind === "execute" && c.sql.includes("INSERT")) return failure;
      if (c.kind === "rollback") return new Error("rollback failed");
      return undefined;
    };
    await expect(claimPrepRun(fake, "prep-1")).rejects.toBe(failure);
  });

  it("commit が投げたら（確定したかが分からない）そのまま投げる", async () => {
    const fake = fakeWith(true, true);
    const failure = new Error("commit lost");
    fake.failOn = (c) => (c.kind === "commit" ? failure : undefined);
    await expect(claimPrepRun(fake, "prep-1")).rejects.toBe(failure);
  });

  it("begin が投げたら何も打たずに投げる", async () => {
    const fake = fakeWith(true, true);
    const failure = new Error("unavailable");
    fake.failOn = (c) => (c.kind === "begin" ? failure : undefined);
    await expect(claimPrepRun(fake, "prep-1")).rejects.toBe(failure);
    expect(fake.calls).toHaveLength(1);
  });

  it("空の用意の ID を受けない", async () => {
    const fake = fakeWith(true, true);
    await expect(claimPrepRun(fake, "")).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});

describePg("claimPrepRun（PostgreSQL）", () => {
  it("表の無い DB で表を作り、新しい用意の ID で first", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      expect(
        await sql.execute("SELECT to_regclass('nd_prep.prep_runs') IS NOT NULL AS present", undefined, ADMIN),
      ).toEqual([{ present: false }]);
      expect(await claimPrepRun(sql, "prep-a")).toBe("first");
      expect(
        await sql.execute(
          `SELECT to_regclass('nd_prep.prep_runs') IS NOT NULL AS present,
                  has_schema_privilege('public', 'nd_prep', 'USAGE') AS public_usage,
                  has_table_privilege('public', 'nd_prep.prep_runs', 'SELECT') AS public_select`,
          undefined,
          ADMIN,
        ),
      ).toEqual([{ present: true, public_usage: false, public_select: false }]);
      expect(await claimPrepRun(sql, "prep-b")).toBe("first");
    });
  });

  it("同じ用意の ID の 2 回目は duplicate", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      expect(await claimPrepRun(sql, "prep-a")).toBe("first");
      expect(await claimPrepRun(sql, "prep-a")).toBe("duplicate");
      expect(
        await sql.execute("SELECT count(*)::int AS c FROM nd_prep.prep_runs WHERE prep_id = :id", [{ name: "id", value: "prep-a" }], ADMIN),
      ).toEqual([{ c: 1 }]);
    });
  });

  it("8 日前の行は消え、6 日前の行は残る", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      await claimPrepRun(sql, "prep-now");
      await sql.execute(
        `INSERT INTO nd_prep.prep_runs (prep_id, claimed_at) VALUES
           ('prep-8d', now() - interval '8 days'),
           ('prep-6d', now() - interval '6 days')`,
        undefined,
        ADMIN,
      );
      expect(await claimPrepRun(sql, "prep-next")).toBe("first");
      const rows = await sql.execute("SELECT prep_id::text AS id FROM nd_prep.prep_runs ORDER BY prep_id", undefined, ADMIN);
      expect(rows).toEqual([{ id: "prep-6d" }, { id: "prep-next" }, { id: "prep-now" }]);
    });
  });

  it("同じ用意の ID を 2 つの接続から同時に打つと、ちょうど 1 つだけが first", async () => {
    await withTestDatabase(async (db) => {
      const a = db.executor();
      const b = db.executor();
      // 1 回目は表の無い DB で、作る文どうしも重ねる
      for (let i = 0; i < 6; i++) {
        const id = `prep-race-${i}`;
        const results = await Promise.all([claimPrepRun(a, id), claimPrepRun(b, id)]);
        expect(results.sort()).toEqual(["duplicate", "first"]);
      }
    });
  });
});
