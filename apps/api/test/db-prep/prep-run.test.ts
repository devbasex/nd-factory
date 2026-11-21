import { describe, expect, it } from "vitest";
import { PREP_RUN_RETENTION_DAYS, claimPrepRun } from "../../src/db-prep/prep-run.ts";
import { ADMIN_DATABASE, type SqlExecutor } from "../../src/db-prep/sql-executor.ts";
import { FakeSqlExecutor } from "./fake-sql-executor.ts";
import { describePg, withTestDatabase } from "./pg-executor.ts";

const ADMIN = { database: ADMIN_DATABASE };

describe("claimPrepRun（作り物の SqlExecutor）", () => {
  function fakeWith(present: boolean, inserted: boolean): FakeSqlExecutor {
    const fake = new FakeSqlExecutor();
    fake.respond = (sql) => {
      if (sql.includes("AS present")) return [{ present }];
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

  it("表が無ければ鎖を取ってから見直し、鎖の下で作ってから記す", async () => {
    const fake = fakeWith(false, true);
    expect(await claimPrepRun(fake, "prep-1")).toBe("first");
    const s = fake.statements();
    expect(s[0]).toContain("to_regclass");
    expect(s[1]).toContain("pg_advisory_xact_lock(hashtext('nd-prep:schema'))");
    expect(s[2]).toContain("pg_catalog.pg_class");
    const schema = s.findIndex((x) => x.includes("CREATE SCHEMA IF NOT EXISTS nd_prep"));
    const table = s.findIndex((x) => x.includes("CREATE TABLE IF NOT EXISTS nd_prep.prep_runs"));
    const insert = s.findIndex((x) => x.includes("ON CONFLICT (prep_id) DO NOTHING RETURNING prep_id"));
    expect(schema).toBe(3);
    expect(schema).toBeLessThan(table);
    expect(table).toBeLessThan(insert);
  });

  it("表があれば鎖を取らず、作る文を打たない", async () => {
    const fake = fakeWith(true, true);
    await claimPrepRun(fake, "prep-1");
    expect(fake.statements()[0]).toContain("to_regclass");
    expect(fake.statements().some((x) => x.includes("pg_advisory_xact_lock"))).toBe(false);
    expect(fake.statements().some((x) => x.includes("CREATE"))).toBe(false);
  });

  it("鎖の前に無かった表が鎖の後の見直しで有れば、作る文を打たない", async () => {
    const fake = fakeWith(true, true);
    let looks = 0;
    const respond = fake.respond;
    fake.respond = (sql, params) => {
      if (sql.includes("AS present")) return [{ present: ++looks > 1 }];
      return respond(sql, params);
    };
    expect(await claimPrepRun(fake, "prep-1")).toBe("first");
    expect(looks).toBe(2);
    expect(fake.statements().some((x) => x.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(fake.statements().some((x) => x.includes("CREATE"))).toBe(false);
  });

  it("残す日数は int に決めて make_interval へ渡す（Data API は整数を bigint で渡す）", async () => {
    const fake = fakeWith(true, true);
    await claimPrepRun(fake, "prep-1");
    expect(fake.statements().find((x) => x.includes("DELETE"))).toContain("make_interval(days => CAST(:retention_days AS int))");
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

  it("表の無い間に別の配信が鎖を持てば待ち、その確定の後の見直しで作られた表を見て作らずに first", async () => {
    await withTestDatabase(async (db) => {
      // 別の配信の代わり: 鎖を取り、確定しないまま持つ
      const other = await db.connect();
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock(hashtext('nd-prep:schema'))");
      let holding = true;

      // 受け取りが打った文を、DB へ送る前に残す
      const inner = db.executor();
      const sent: string[] = [];
      const sql: SqlExecutor = {
        ...inner,
        execute: (s, p, o) => {
          sent.push(s);
          return inner.execute(s, p, o);
        },
      };
      // 受け取りの失敗は起動の直後から捕まえる（鎖を待つ前に落ちても、未処理の拒否にせずに下で投げる）
      let settled = false;
      const outcome = claimPrepRun(sql, "prep-a").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      void outcome.finally(() => {
        settled = true;
      });

      try {
        const watcher = await db.connect();
        // 監視は期限で止める。受け取りが鎖を取らなくなる回帰では、Vitest の時間切れより前に落ちて後始末へ届く
        const deadline = performance.now() + 10_000;
        for (;;) {
          if (settled) throw new Error("受け取りが鎖を待たずに終えた", { cause: await outcome });
          if (performance.now() > deadline) throw new Error("受け取りが期限のうちに鎖を待たなかった");
          const res = await watcher.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
          );
          if (res.rows[0]!.n > 0) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        // 鎖なしで表の無いことを見て、鎖を待っている。見直しはまだ打っていない
        expect(sent).toHaveLength(2);
        expect(sent[0]).toContain("to_regclass");
        expect(sent[1]).toContain("pg_advisory_xact_lock");

        // 別の配信が表を作って確定する。受け取りは鎖の後に見直すので、作られた表を見て作る文を打たない
        await other.query("CREATE SCHEMA nd_prep");
        await other.query("CREATE TABLE nd_prep.prep_runs (prep_id text PRIMARY KEY, claimed_at timestamptz NOT NULL DEFAULT now())");
        await other.query("COMMIT");
        holding = false;
      } catch (e) {
        // 持っている鎖を外してから受け取りの終わりを待つ（外さないと受け取りが鎖を待ち続け、後始末へ届かない）
        if (holding) await other.query("ROLLBACK").catch(() => undefined);
        await outcome;
        throw e;
      }
      expect(await outcome).toEqual({ value: "first" });
      // 見直しは syscache の控えでなく、カタログの表を文の写しで読む（to_regclass は 1 回目の「無い」の控えを使い続ける）
      expect(sent[2]).toContain("pg_catalog.pg_class");
      expect(sent.some((x) => x.includes("CREATE"))).toBe(false);
    });
  });

  it("表があれば、別の配信が鎖を持っていても待たずに受け取る", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      expect(await claimPrepRun(sql, "prep-a")).toBe("first");
      const other = await db.connect();
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock(hashtext('nd-prep:schema'))");
      // 鎖を待つ回帰では、鎖を持ったままなので期限で打ち切る。打ち切っても鎖を外し、受け取りの終わりを待ってから照らす
      const claim = claimPrepRun(sql, "prep-b").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), 5_000);
      });
      let first: Awaited<typeof claim> | "timeout";
      try {
        first = await Promise.race([claim, timeout]);
      } finally {
        clearTimeout(timer);
        await other.query("ROLLBACK");
        await claim;
      }
      expect(first).toEqual({ value: "first" });
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
