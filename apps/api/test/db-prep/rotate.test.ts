import { randomBytes } from "node:crypto";
import { escapeIdentifier } from "pg";
import { describe, expect, it } from "vitest";
import { type TerminateOptions, rotateRole, terminateRoleConnections } from "../../src/db-prep/rotate.ts";
import { ADMIN_DATABASE, type Row, type SqlExecutor } from "../../src/db-prep/sql-executor.ts";
import { FakeSqlExecutor, type SqlCall } from "./fake-sql-executor.ts";
import { type TestDatabase, describePg, withTestDatabase } from "./pg-executor.ts";

// 作り物の値だけを使う
const PROJECT = { projectId: "prj_acme_a", database: "acme_db_aaaaaaaa", role: "acme_role_aaaaaaaa" };
const PASSWORD = "acme-Rotated-0123456789abcdefghijklmnopqrstu";
// 手順の文の長さの上限（Data API の文の長さの上限を確かめていないため、十分小さく縛る）
const STATEMENT_LIMIT = 4 * 1024;

function allText(calls: SqlCall[]): string[] {
  return calls.flatMap((c) => (c.kind === "execute" ? [c.sql, ...(c.params ?? []).map((p) => String(p.value))] : []));
}

function executes(fake: FakeSqlExecutor): Array<Extract<SqlCall, { kind: "execute" }>> {
  return fake.calls.flatMap((c) => (c.kind === "execute" ? [c] : []));
}

// 作り物の DB の状態。文を見て答えを返す
type FakeState = {
  tablePresent?: boolean;
  // 記した番号の行。undefined なら行が無い
  recorded?: { recorded: number; cutoff_recorded: boolean } | undefined;
  // 残りの読みが、呼ばれるたびに返す数。尽きたら最後の数を返し続ける
  remaining?: number[];
  // 切りの文が返す、シグナルを送った数
  signalled?: number;
  // 切りの文が呼ばれたときに走らせる（時計を進めるなど）
  onSignal?: () => void;
};

function fakeDb(state: FakeState = {}): FakeSqlExecutor {
  const fake = new FakeSqlExecutor();
  let reads = 0;
  fake.respond = (sql): Row[] => {
    if (sql.includes("AS present")) return [{ present: state.tablePresent ?? true }];
    if (sql.includes("AS recorded")) return state.recorded ? [state.recorded] : [];
    if (sql.includes("AS signalled")) {
      state.onSignal?.();
      return [{ signalled: state.signalled ?? 0 }];
    }
    if (sql.includes("AS remaining")) {
      const seq = state.remaining ?? [0];
      const n = seq[Math.min(reads, seq.length - 1)];
      reads += 1;
      return [{ remaining: n ?? 0 }];
    }
    if (sql.includes("AS cleared")) return [{ cleared: 1 }];
    if (sql.includes("AS locked")) return [{ locked: 1 }];
    return [];
  };
  return fake;
}

// 差し替えた時計。sleep は待った分だけ時計を進める
function fakeClock(start = 0): { now: () => number; sleeps: number[]; set(t: number): void; options(o?: TerminateOptions): TerminateOptions } {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleeps,
    set(v) {
      t = v;
    },
    options(o = {}) {
      return {
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
        ...o,
      };
    },
  };
}

describe("名前と番号の形の照らし", () => {
  it("形に合わない役割の名前・番号・空のプロジェクトの ID・印字できないパスワードなら SQL を打たずに投げる", async () => {
    const runs: Array<(s: SqlExecutor) => Promise<unknown>> = [
      (s) => rotateRole(s, { ...PROJECT, role: "acme role", password: PASSWORD, seq: 1 }),
      (s) => rotateRole(s, { ...PROJECT, projectId: "", password: PASSWORD, seq: 1 }),
      (s) => rotateRole(s, { ...PROJECT, password: PASSWORD, seq: 0 }),
      (s) => rotateRole(s, { ...PROJECT, password: PASSWORD, seq: 1.5 }),
      (s) => rotateRole(s, { ...PROJECT, password: "acme\u0000pw", seq: 1 }),
      (s) => terminateRoleConnections(s, "Acme-Role", 1),
      (s) => terminateRoleConnections(s, PROJECT.role, 0),
    ];
    for (const run of runs) {
      const fake = fakeDb();
      await expect(run(fake)).rejects.toThrow();
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("例外の文に渡された名前を入れない", async () => {
    const err = await terminateRoleConnections(fakeDb(), "Acme-Secret-Role", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("Acme-Secret-Role");
  });
});

describe("rotateRole（作り物の SqlExecutor）", () => {
  it("記した番号が n より小さければ、管理のデータベースの 1 つのトランザクションで、鎖を取ってからパスワードと番号を書く", async () => {
    const fake = fakeDb({ recorded: { recorded: 2, cutoff_recorded: true } });
    expect(await rotateRole(fake, { ...PROJECT, password: PASSWORD, seq: 3 })).toEqual({ kind: "applied", recorded: 3 });
    expect(fake.calls[0]).toEqual({ kind: "begin", database: ADMIN_DATABASE });
    expect(fake.calls.at(-1)).toEqual({ kind: "commit", transactionId: "tx-1" });
    const ex = executes(fake);
    for (const c of ex) {
      expect(c.transactionId).toBe("tx-1");
      expect(c.database).toBe(ADMIN_DATABASE);
    }
    expect(ex[0]!.sql).toContain("pg_advisory_xact_lock(hashtext('nd-rotate:' ||");
    expect(ex[0]!.params).toEqual([{ name: "role_name", value: PROJECT.role }]);
    const s = fake.statements();
    const read = s.findIndex((x) => x.includes("AS recorded"));
    const alter = s.findIndex((x) => x.startsWith(`ALTER ROLE ${escapeIdentifier(PROJECT.role)} WITH PASSWORD 'SCRAM-SHA-256$`));
    const write = s.findIndex((x) => x.includes("INSERT INTO nd_prep.rotation_seq"));
    expect(read).toBeGreaterThan(0);
    expect(alter).toBeGreaterThan(read);
    expect(write).toBeGreaterThan(read);
    // 書くと境の時刻を空へ戻す
    expect(s[write]).toContain("old_conn_cutoff = NULL");
    expect(ex[write]!.params).toEqual(expect.arrayContaining([{ name: "seq", value: 3 }]));
  });

  it("行が無ければ（初めての差し替え）書く", async () => {
    const fake = fakeDb({ recorded: undefined });
    expect(await rotateRole(fake, { ...PROJECT, password: PASSWORD, seq: 1 })).toEqual({ kind: "applied", recorded: 1 });
    expect(fake.statements().some((x) => x.startsWith("ALTER ROLE"))).toBe(true);
  });

  it("記した番号 = n なら書かずに superseded_equal", async () => {
    const fake = fakeDb({ recorded: { recorded: 3, cutoff_recorded: false } });
    expect(await rotateRole(fake, { ...PROJECT, password: PASSWORD, seq: 3 })).toEqual({ kind: "superseded_equal", recorded: 3 });
    expect(fake.statements().some((x) => x.startsWith("ALTER ROLE") || x.includes("INSERT") || x.includes("UPDATE"))).toBe(false);
    expect(fake.calls.at(-1)).toEqual({ kind: "commit", transactionId: "tx-1" });
  });

  it("記した番号 > n なら何も変えずに superseded_greater と記した番号", async () => {
    const fake = fakeDb({ recorded: { recorded: 4, cutoff_recorded: true } });
    expect(await rotateRole(fake, { ...PROJECT, password: PASSWORD, seq: 3 })).toEqual({ kind: "superseded_greater", recorded: 4 });
    expect(fake.statements().some((x) => x.startsWith("ALTER ROLE") || x.includes("INSERT") || x.includes("UPDATE"))).toBe(false);
  });

  it("表が無ければ、差し替えの鎖の後にスキーマの鎖を取り、カタログを読み直してから作る", async () => {
    const fake = fakeDb({ tablePresent: false });
    await rotateRole(fake, { ...PROJECT, password: PASSWORD, seq: 1 });
    const s = fake.statements();
    const rotateLock = s.findIndex((x) => x.includes("nd-rotate:"));
    const schemaLock = s.findIndex((x) => x.includes("hashtext('nd-prep:schema')"));
    const create = s.findIndex((x) => x.includes("CREATE TABLE nd_prep.rotation_seq"));
    expect(rotateLock).toBe(0);
    expect(schemaLock).toBeGreaterThan(rotateLock);
    expect(create).toBeGreaterThan(schemaLock);
    // 鎖の後の見直しは控えを通さずカタログを読む
    const afterLock = s.slice(schemaLock).filter((x) => x.includes("AS present"));
    expect(afterLock.length).toBeGreaterThan(0);
    expect(afterLock.every((x) => x.includes("pg_catalog.pg_class") || x.includes("pg_catalog.pg_namespace"))).toBe(true);
    expect(s).toContain("REVOKE ALL ON nd_prep.rotation_seq FROM PUBLIC");
    expect(s).toContain("REVOKE ALL ON SCHEMA nd_prep FROM PUBLIC");
  });

  it("表があれば作る文とスキーマの鎖を打たない", async () => {
    const fake = fakeDb({ tablePresent: true });
    await rotateRole(fake, { ...PROJECT, password: PASSWORD, seq: 1 });
    expect(fake.statements().some((x) => x.includes("CREATE") || x.includes("nd-prep:schema"))).toBe(false);
  });

  it("文と引数のどれにもパスワードの平文が現れない", async () => {
    const fake = fakeDb({ tablePresent: false });
    await rotateRole(fake, { ...PROJECT, password: PASSWORD, seq: 1 });
    for (const t of allText(fake.calls)) expect(t).not.toContain(PASSWORD);
  });

  it("途中の文が投げたら rollback して投げ、commit を呼ばない。rollback も投げたら元の失敗を投げる", async () => {
    for (const rollbackFails of [false, true]) {
      const fake = fakeDb();
      const failure = new Error("boom");
      fake.failOn = (c) => {
        if (c.kind === "execute" && c.sql.startsWith("ALTER ROLE")) return failure;
        if (rollbackFails && c.kind === "rollback") return new Error("rollback failed");
        return undefined;
      };
      await expect(rotateRole(fake, { ...PROJECT, password: PASSWORD, seq: 1 })).rejects.toBe(failure);
      expect(fake.calls.some((c) => c.kind === "commit")).toBe(false);
      expect(fake.calls.at(-1)).toEqual({ kind: "rollback", transactionId: "tx-1" });
    }
  });

  it("記した番号の行が読めない形なら書かずに投げる", async () => {
    const fake = fakeDb();
    fake.respond = (sql) => (sql.includes("AS recorded") ? [{ recorded: "3", cutoff_recorded: true }] : sql.includes("AS present") ? [{ present: true }] : []);
    await expect(rotateRole(fake, { ...PROJECT, password: PASSWORD, seq: 4 })).rejects.toThrow();
    expect(fake.statements().some((x) => x.startsWith("ALTER ROLE"))).toBe(false);
  });
});

describe("terminateRoleConnections（作り物の SqlExecutor）", () => {
  const current = { recorded: 3, cutoff_recorded: true };

  it("管理のデータベースの 1 つのトランザクションで、差し替えと同じ鎖を取ってから打つ", async () => {
    const fake = fakeDb({ recorded: current });
    const clock = fakeClock();
    expect(await terminateRoleConnections(fake, PROJECT.role, 3, clock.options())).toEqual({ kind: "done", remaining: 0 });
    expect(fake.calls[0]).toEqual({ kind: "begin", database: ADMIN_DATABASE });
    expect(fake.calls.at(-1)).toEqual({ kind: "commit", transactionId: "tx-1" });
    const ex = executes(fake);
    expect(ex[0]!.sql).toContain("pg_advisory_xact_lock(hashtext('nd-rotate:' ||");
    for (const c of ex) {
      expect(c.transactionId).toBe("tx-1");
      expect(c.database).toBe(ADMIN_DATABASE);
      expect(c.sql).not.toContain(PROJECT.role);
    }
  });

  it("記した番号が n より大きければ何も切らず、境の時刻も記さずに superseded_greater", async () => {
    const fake = fakeDb({ recorded: { recorded: 4, cutoff_recorded: false } });
    expect(await terminateRoleConnections(fake, PROJECT.role, 3, fakeClock().options())).toEqual({ kind: "superseded_greater", recorded: 4 });
    const s = fake.statements();
    expect(s.some((x) => x.includes("pg_terminate_backend") || x.includes("UPDATE") || x.includes("pg_stat_activity"))).toBe(false);
  });

  it("行が無いか記した番号が n より小さければ、何も切らずに投げる", async () => {
    for (const recorded of [undefined, { recorded: 2, cutoff_recorded: false }]) {
      const fake = fakeDb({ recorded });
      await expect(terminateRoleConnections(fake, PROJECT.role, 3, fakeClock().options())).rejects.toThrow();
      expect(fake.statements().some((x) => x.includes("pg_terminate_backend"))).toBe(false);
      expect(fake.calls.at(-1)).toEqual({ kind: "rollback", transactionId: "tx-1" });
    }
  });

  it("境の時刻が空なら、番号 n の行に切りの前に記す", async () => {
    const fake = fakeDb({ recorded: { recorded: 3, cutoff_recorded: false } });
    await terminateRoleConnections(fake, PROJECT.role, 3, fakeClock().options());
    const ex = executes(fake);
    const update = ex.findIndex((c) => c.sql.includes("SET old_conn_cutoff = clock_timestamp()"));
    const signal = ex.findIndex((c) => c.sql.includes("pg_terminate_backend"));
    expect(update).toBeGreaterThan(0);
    expect(signal).toBeGreaterThan(update);
    expect(ex[update]!.sql).toContain("old_conn_cutoff IS NULL");
    expect(ex[update]!.params).toEqual(expect.arrayContaining([{ name: "seq", value: 3 }, { name: "role_name", value: PROJECT.role }]));
  });

  it("境の時刻が記されていれば記し直さない", async () => {
    const fake = fakeDb({ recorded: current });
    await terminateRoleConnections(fake, PROJECT.role, 3, fakeClock().options());
    expect(fake.statements().some((x) => x.includes("UPDATE"))).toBe(false);
  });

  it("一覧を読む前と、残りの読みの直前ごとに pg_stat_clear_snapshot() を打つ", async () => {
    const fake = fakeDb({ recorded: current, remaining: [2, 1, 0] });
    await terminateRoleConnections(fake, PROJECT.role, 3, fakeClock().options());
    const s = fake.statements();
    const signal = s.findIndex((x) => x.includes("pg_terminate_backend"));
    expect(s[signal - 1]).toContain("pg_stat_clear_snapshot()");
    const reads = s.flatMap((x, i) => (x.includes("AS remaining") ? [i] : []));
    expect(reads).toHaveLength(3);
    for (const i of reads) expect(s[i - 1]).toContain("pg_stat_clear_snapshot()");
  });

  it("切りの文は pg_terminate_backend(pid, 0) の 1 回で、接続の数（1 本・10 本）で呼ぶ回数が変わらない", async () => {
    const counts: number[] = [];
    for (const signalled of [1, 10]) {
      const fake = fakeDb({ recorded: current, signalled, remaining: [signalled, 0] });
      await terminateRoleConnections(fake, PROJECT.role, 3, fakeClock().options());
      const signals = fake.statements().filter((x) => x.includes("pg_terminate_backend"));
      expect(signals).toHaveLength(1);
      expect(signals[0]).toContain("pg_terminate_backend(s.pid, 0)");
      // 境の時刻より前に始まったその役割の接続だけ
      expect(signals[0]).toContain("s.backend_start < r.old_conn_cutoff");
      counts.push(fake.calls.length);
    }
    expect(counts[0]).toBe(counts[1]);
  });

  it("1 回目の読み直しが 1、2 回目が 0 なら 0 を返す。待ちは pollMs", async () => {
    const fake = fakeDb({ recorded: current, remaining: [1, 0] });
    const clock = fakeClock();
    expect(await terminateRoleConnections(fake, PROJECT.role, 3, clock.options({ pollMs: 500 }))).toEqual({ kind: "done", remaining: 0 });
    expect(clock.sleeps).toEqual([500]);
  });

  it("読みが 1 のまま期限の 15 秒を過ぎれば最後の読みの 1 を返し、期限の後に次の読みを打たない。待ちは pollMs と期限までの残りの小さい方", async () => {
    const fake = fakeDb({ recorded: current, remaining: [1] });
    const clock = fakeClock(1_000);
    // 既定の期限 15,000。間隔 400 で 37 回待つと 14,800 進み、残りの 200 で切り詰める
    expect(await terminateRoleConnections(fake, PROJECT.role, 3, clock.options({ pollMs: 400 }))).toEqual({ kind: "done", remaining: 1 });
    expect(clock.now()).toBe(16_000);
    expect(clock.sleeps.slice(0, -1).every((ms) => ms === 400)).toBe(true);
    expect(clock.sleeps.at(-1)).toBe(200);
    // 読みは待ちの数より 1 回多い（最初の読みと、各待ちの後の読み）
    const reads = fake.statements().filter((x) => x.includes("AS remaining"));
    expect(reads).toHaveLength(clock.sleeps.length + 1);
    expect(fake.calls.at(-1)).toEqual({ kind: "commit", transactionId: "tx-1" });
  });

  it("切りの文が戻るまでに時計が期限の後へ進んでも、残りを 1 回読んでから、その数を返す", async () => {
    for (const [left, expected] of [
      [0, 0],
      [2, 2],
    ] as const) {
      const clock = fakeClock();
      const fake = fakeDb({ recorded: current, remaining: [left], onSignal: () => clock.set(20_000) });
      expect(await terminateRoleConnections(fake, PROJECT.role, 3, clock.options())).toEqual({ kind: "done", remaining: expected });
      expect(fake.statements().filter((x) => x.includes("AS remaining"))).toHaveLength(1);
      expect(clock.sleeps).toEqual([]);
    }
  });

  it("残りの数が読めない形なら投げて巻き戻す", async () => {
    const fake = fakeDb({ recorded: current });
    const inner = fake.respond;
    fake.respond = (sql, params) => (sql.includes("AS remaining") ? [{ remaining: null }] : inner(sql, params));
    await expect(terminateRoleConnections(fake, PROJECT.role, 3, fakeClock().options())).rejects.toThrow();
    expect(fake.calls.at(-1)).toEqual({ kind: "rollback", transactionId: "tx-1" });
  });
});

describe("文の長さ", () => {
  it("rotateRole と terminateRoleConnections の文はどれも 4 KiB 未満", async () => {
    const rotate = fakeDb({ tablePresent: false });
    await rotateRole(rotate, { ...PROJECT, password: PASSWORD, seq: 1 });
    const terminate = fakeDb({ recorded: { recorded: 1, cutoff_recorded: false }, remaining: [1, 0] });
    await terminateRoleConnections(terminate, PROJECT.role, 1, fakeClock().options());
    for (const s of [...rotate.statements(), ...terminate.statements()]) {
      expect(new TextEncoder().encode(s).length).toBeLessThan(STATEMENT_LIMIT);
    }
  });
});

// --- PostgreSQL のサービスコンテナ ---
// 役割は管理の手で作り、使い捨てのデータベースへだけ CONNECT を与える（クラスタ全体の権限は変えない）

type TestRole = { projectId: string; database: string; role: string; password: string };

function newPassword(): string {
  return randomBytes(24).toString("base64url");
}

async function newRole(db: TestDatabase): Promise<TestRole> {
  const s = randomBytes(5).toString("hex");
  const r: TestRole = { projectId: `prj_acme_${s}`, database: db.name, role: `acme_rot_role_${s}`, password: newPassword() };
  db.dropRoleLater(r.role);
  const admin = await db.connect();
  await admin.query(`CREATE ROLE ${escapeIdentifier(r.role)} LOGIN PASSWORD '${r.password}'`);
  await admin.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(db.name)} TO ${escapeIdentifier(r.role)}`);
  await admin.end();
  return r;
}

async function connectAs(db: TestDatabase, r: TestRole, password = r.password) {
  return db.connect(db.name, { user: r.role, password });
}

async function canConnect(db: TestDatabase, r: TestRole, password: string): Promise<boolean> {
  try {
    const c = await connectAs(db, r, password);
    await c.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

async function alive(c: { query(q: string): Promise<unknown> }): Promise<boolean> {
  try {
    await c.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

async function recordedSeq(db: TestDatabase, role: string): Promise<{ seq: number; cutoff: string | null } | undefined> {
  const admin = await db.connect();
  try {
    const res = await admin.query<{ seq: number; cutoff: string | null }>(
      "SELECT seq::int AS seq, old_conn_cutoff::text AS cutoff FROM nd_prep.rotation_seq WHERE role_name = $1",
      [role],
    );
    return res.rows[0];
  } finally {
    await admin.end();
  }
}

// 関数の差し替えの段（パスワードを書く → 古い接続を切る）
async function rotateAndTerminate(sql: SqlExecutor, r: TestRole, seq: number): Promise<unknown> {
  const rotated = await rotateRole(sql, { ...r, seq });
  if (rotated.kind === "superseded_greater") return rotated;
  return terminateRoleConnections(sql, r.role, seq);
}

describePg("rotateRole（PostgreSQL）", () => {
  it("記した番号 < n で書き、新しい平文で通り、古い平文で落ちる。表が無ければ作る", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const r = await newRole(db);
      const next = { ...r, password: newPassword() };
      expect(await rotateRole(sql, { ...next, seq: 1 })).toEqual({ kind: "applied", recorded: 1 });
      expect(await canConnect(db, r, next.password)).toBe(true);
      expect(await canConnect(db, r, r.password)).toBe(false);
      expect((await recordedSeq(db, r.role))?.seq).toBe(1);
      const third = { ...r, password: newPassword() };
      expect(await rotateRole(sql, { ...third, seq: 2 })).toEqual({ kind: "applied", recorded: 2 });
      expect(await canConnect(db, r, third.password)).toBe(true);
      expect(await canConnect(db, r, next.password)).toBe(false);
    });
  });

  it("記した番号 = n で書かず、> n で何も変えない", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const r = await newRole(db);
      const second = { ...r, password: newPassword() };
      await rotateRole(sql, { ...second, seq: 2 });
      const before = await recordedSeq(db, r.role);
      expect(await rotateRole(sql, { ...r, password: newPassword(), seq: 2 })).toEqual({ kind: "superseded_equal", recorded: 2 });
      expect(await rotateRole(sql, { ...r, password: newPassword(), seq: 1 })).toEqual({ kind: "superseded_greater", recorded: 2 });
      expect(await canConnect(db, r, second.password)).toBe(true);
      expect(await recordedSeq(db, r.role)).toEqual(before);
    });
  });

  it("2 つを同時に打つと、番号の大きい方だけが残る", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const r = await newRole(db);
      const low = { ...r, password: newPassword(), seq: 2 };
      const high = { ...r, password: newPassword(), seq: 3 };
      await Promise.all([rotateRole(sql, low), rotateRole(sql, high)]);
      expect((await recordedSeq(db, r.role))?.seq).toBe(3);
      expect(await canConnect(db, r, high.password)).toBe(true);
      expect(await canConnect(db, r, low.password)).toBe(false);
    });
  });
});

describePg("terminateRoleConnections（PostgreSQL）", () => {
  it("書く前に開いた役割の接続 3 本を切り、同じトランザクションの中の読み直しで残り 0 を返す", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const r = await newRole(db);
      const old = await Promise.all([connectAs(db, r), connectAs(db, r), connectAs(db, r)]);
      for (const c of old) await c.query("SELECT 1");
      const next = { ...r, password: newPassword() };
      expect(await rotateRole(sql, { ...next, seq: 1 })).toMatchObject({ kind: "applied" });
      expect(await terminateRoleConnections(sql, r.role, 1)).toEqual({ kind: "done", remaining: 0 });
      for (const c of old) expect(await alive(c)).toBe(false);
      // 管理の役割の接続は切らない
      const admin = await db.connect();
      expect(await alive(admin)).toBe(true);
    });
  });

  it("境の時刻が記されていれば記し直さない", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const r = await newRole(db);
      await rotateRole(sql, { ...r, password: newPassword(), seq: 1 });
      await terminateRoleConnections(sql, r.role, 1);
      const first = (await recordedSeq(db, r.role))?.cutoff;
      expect(first).toEqual(expect.any(String));
      await terminateRoleConnections(sql, r.role, 1);
      expect((await recordedSeq(db, r.role))?.cutoff).toBe(first);
    });
  });

  it("順序の逆転: T1 が番号 n を書いて切りの前で止まり、T2 が終えた後に開いた接続 C を、再開した T1 は切らない", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const r = await newRole(db);
      const next = { ...r, password: newPassword() };
      const old = await connectAs(db, r);
      // T1: 番号 1 を書いて止まる
      expect(await rotateRole(sql, { ...next, seq: 1 })).toMatchObject({ kind: "applied" });
      // T2: 同じ番号の呼び直しが終わりまで進む
      expect(await rotateAndTerminate(sql, next, 1)).toEqual({ kind: "done", remaining: 0 });
      expect(await alive(old)).toBe(false);
      const c = await connectAs(db, r, next.password);
      await c.query("SELECT 1");
      // T1 の再開
      expect(await terminateRoleConnections(sql, r.role, 1)).toEqual({ kind: "done", remaining: 0 });
      expect(await alive(c)).toBe(true);
    });
  });

  it("順序の逆転: T1 が rotateRole の前で止まり、T2 が終えて C を開いた後に T1 を最初から打っても C が残る", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const r = await newRole(db);
      const next = { ...r, password: newPassword() };
      expect(await rotateAndTerminate(sql, next, 1)).toEqual({ kind: "done", remaining: 0 });
      const c = await connectAs(db, r, next.password);
      await c.query("SELECT 1");
      expect(await rotateRole(sql, { ...next, seq: 1 })).toEqual({ kind: "superseded_equal", recorded: 1 });
      expect(await terminateRoleConnections(sql, r.role, 1)).toEqual({ kind: "done", remaining: 0 });
      expect(await alive(c)).toBe(true);
    });
  });

  it("記した番号が n+1 に上がった後の T1（n）は、何も切らずに superseded_greater", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const r = await newRole(db);
      const first = { ...r, password: newPassword() };
      const second = { ...r, password: newPassword() };
      // 差し替えの前から開いた接続。切るのは番号 2 の呼び出しで、T1 は切らない
      const old = await connectAs(db, r);
      await old.query("SELECT 1");
      expect(await rotateRole(sql, { ...first, seq: 1 })).toMatchObject({ kind: "applied" });
      expect(await rotateRole(sql, { ...second, seq: 2 })).toMatchObject({ kind: "applied" });
      expect(await terminateRoleConnections(sql, r.role, 1)).toEqual({ kind: "superseded_greater", recorded: 2 });
      expect(await alive(old)).toBe(true);
      // 番号 2 の境の時刻も記さない
      expect((await recordedSeq(db, r.role))?.cutoff).toBeNull();
    });
  });
});
