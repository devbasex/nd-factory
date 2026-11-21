import { randomBytes } from "node:crypto";
import { DatabaseResumingException } from "@aws-sdk/client-rds-data";
import { DB_PREP_ENV, type DbPrepInvocation, type DbPrepOutcome } from "@nd-factory/contracts/db-prep";
import { describe, expect, it } from "vitest";
import {
  DbPrepFunctionError,
  PREP_LOG_REDACT_PATHS,
  type PrepCompletionPort,
  type PrepDeps,
  type PrepTarget,
  createDbPrepHandler,
  createPrepLogger,
} from "../../src/db-prep/handler.ts";
import { CATALOG_READS } from "../../src/db-prep/provision.ts";
import { DataApiUnavailableError, type Row, type SqlExecutor } from "../../src/db-prep/sql-executor.ts";
import { UNWIRED_COMPLETION, readDbPrepConfig } from "../../src/entries/db-prep.ts";
import { FakeSqlExecutor } from "./fake-sql-executor.ts";
import { type TestDatabase, describePgDisposable, withTestDatabase } from "./pg-executor.ts";

// 作り物の値だけを使う
const PROJECT_ID = "prj_01890a5d-ac96-7a3b-8c4d-0123456789ab";
const PREP_ID = "prep_acme_0001";
const DATABASE = "acme_db_secretname";
const ROLE = "acme_role_secretname";
const SECRET = "acme/test/progress-db/acme-secret-name";
const VERSION = "0b9c3c1e-5f0a-4d6b-9a51-2f6c8e1d7a01";
const PASSWORD = "acme-Password-0123456789abcdefghijklmnop";
const URL_VALUE = `postgresql://${ROLE}:${PASSWORD}@acme-progress.example.com:5432/${DATABASE}`;
const TARGET: PrepTarget = { database: DATABASE, role: ROLE, secret: SECRET, secretVersion: VERSION };
// ログに部分の文字列として現れてはならない値
const SECRETS = [PASSWORD, URL_VALUE, DATABASE, ROLE, SECRET];

const CREATE: DbPrepInvocation = { prep_id: PREP_ID, project_id: PROJECT_ID, kind: "create" };
const rotate = (seq: number, prepId = PREP_ID): DbPrepInvocation => ({ prep_id: prepId, project_id: PROJECT_ID, kind: "rotate", rotation_seq: seq });

// 作り物の DB の状態。文を見て答えを返す
type FakeState = {
  // claimPrepRun の挿入が行を返すか
  claim?: "first" | "duplicate";
  bindings?: Array<{ project_id: string; database_name: string; role_name: string }>;
  databaseExists?: boolean;
  guardOthers?: number;
  // 差し替えの番号の読みが、呼ばれるたびに返す行（rotateRole・terminateRoleConnections の順）。undefined は行が無い
  recorded?: Array<{ recorded: number; cutoff_recorded: boolean } | undefined>;
  // terminateRoleConnections の残りの読みが、呼ばれるたびに返す数。尽きたら最後の数を返し続ける
  oldSessions?: number[];
};

function fakeDb(state: FakeState = {}): FakeSqlExecutor {
  const fake = new FakeSqlExecutor();
  let recordedReads = 0;
  let oldReads = 0;
  fake.respond = (sql, params): Row[] => {
    if (sql.includes("RETURNING prep_id")) return (state.claim ?? "first") === "first" ? [{ prep_id: PREP_ID }] : [];
    if (sql.includes("AS pending")) return [{ pending: 0 }];
    if (sql.includes("AS remaining") && sql.includes("nd_prep.rotation_seq r")) {
      const seq = state.oldSessions ?? [0];
      const n = seq[Math.min(oldReads, seq.length - 1)] ?? 0;
      oldReads += 1;
      // 起動の途中と見た pid は無い（どれも載った）
      return [{ remaining: n, starting: "" }];
    }
    // 起動の途中の接続（仮想の取引番号の鎖を持つ pid）は無い
    if (sql.includes("AS holders")) return [{ holders: "" }];
    if (sql.includes("AS remaining") && sql.includes("pg_database d WHERE d.datname")) {
      const names = String(params?.find((p) => p.name === "names")?.value ?? "").split(",");
      return [{ remaining: 0, found: names.length }];
    }
    if (sql.includes("AS remaining")) return [{ remaining: 0 }];
    if (sql.includes("AS recorded")) {
      const rows = state.recorded ?? [undefined];
      const row = rows[Math.min(recordedReads, rows.length - 1)];
      recordedReads += 1;
      return row === undefined ? [] : [row];
    }
    if (sql.includes("AS exposed_oid")) return [];
    if (sql.includes("AS unauthorized_signalled")) return [{ unauthorized_signalled: 0 }];
    if (sql.includes("AS signalled")) return [{ signalled: 0 }];
    if (sql.includes("AS cleared")) return [{ cleared: 1 }];
    if (sql.includes("AS locked")) return [{ locked: 1 }];
    if (sql.includes("AS present")) return [{ present: true }];
    if (sql.includes("FROM nd_prep.bindings")) return state.bindings ?? [];
    if (sql.includes("AS database_exists")) return [{ database_exists: state.databaseExists ?? false, role_exists: false }];
    if (sql.includes("AS others")) return state.guardOthers === undefined ? [] : [{ allow: true, others: state.guardOthers, public_connect: false }];
    if (sql.includes("AS other_databases")) return [{ other_databases: 0 }];
    if (sql.includes("AS found")) return [{ found: false }];
    if (sql.includes("AS name")) return CATALOG_READS.map((name) => ({ name }));
    return [];
  };
  return fake;
}

// 作り物の口と秘密の器。呼ばれた順を 1 本の列に残す
class FakeWorld {
  events: string[] = [];
  records: Array<{ inv: DbPrepInvocation; outcome: DbPrepOutcome; secretVersion: string }> = [];
  current = true;
  target: PrepTarget = { ...TARGET };
  recordResult: "recorded" | "mismatch" = "recorded";
  // 作り物の秘密の器で AWSCURRENT の付く版
  currentVersion: string | undefined = undefined;
  fail: Partial<Record<"isCurrent" | "readTarget" | "readPassword" | "promote" | "record", Error>> = {};

  port(): PrepCompletionPort {
    return {
      isCurrent: async (projectId, prepId) => {
        this.events.push(`isCurrent:${projectId}:${prepId}`);
        if (this.fail.isCurrent) throw this.fail.isCurrent;
        return this.current;
      },
      readTarget: async (projectId) => {
        this.events.push(`readTarget:${projectId}`);
        if (this.fail.readTarget) throw this.fail.readTarget;
        return this.target;
      },
      record: async (inv, outcome, secretVersion) => {
        this.events.push("record");
        if (this.fail.record) throw this.fail.record;
        this.records.push({ inv, outcome, secretVersion });
        return this.recordResult;
      },
    };
  }

  readPassword = async (secret: string, versionId: string): Promise<string> => {
    this.events.push(`readPassword:${versionId}`);
    expect(secret).toBe(SECRET);
    if (this.fail.readPassword) throw this.fail.readPassword;
    return PASSWORD;
  };

  promote = async (secret: string, versionId: string): Promise<void> => {
    expect(secret).toBe(SECRET);
    if (this.fail.promote) {
      this.events.push("promote");
      throw this.fail.promote;
    }
    // 既に付いていれば移さない（promoteVersion と同じ）
    this.events.push(this.currentVersion === versionId ? "promote:kept" : "promote:moved");
    this.currentVersion = versionId;
  };
}

// 差し替えた時計。sleep は待った分だけ時計を進める
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; set(t: number): void } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    set(v) {
      t = v;
    },
  };
}

type LogLine = Record<string, unknown> & { level: number; msg: string };

function setup(state: FakeState = {}, sql?: SqlExecutor) {
  const db = fakeDb(state);
  const world = new FakeWorld();
  const lines: string[] = [];
  const logger = createPrepLogger({ write: (s: string) => void lines.push(s) });
  const clock = fakeClock();
  const deps: PrepDeps = {
    sql: sql ?? db,
    completion: world.port(),
    readPassword: world.readPassword,
    promote: world.promote,
    logger,
    now: clock.now,
    sleep: clock.sleep,
  };
  return {
    db,
    world,
    lines,
    clock,
    handle: createDbPrepHandler(deps),
    logs: (): LogLine[] => lines.map((l) => JSON.parse(l) as LogLine),
  };
}

function statements(db: FakeSqlExecutor): string[] {
  return db.statements();
}

function prepStatements(db: FakeSqlExecutor): string[] {
  return statements(db).filter((s) => /^(CREATE (DATABASE|ROLE)|ALTER ROLE|GRANT |REVOKE CONNECT|DO \$nd_role_password\$)/.test(s));
}

function expectNoSecretIn(lines: string[]): void {
  for (const line of lines) {
    for (const s of SECRETS) expect(line).not.toContain(s);
  }
}

// 値を message に含む例外（再開の待ちの尽き・SQL の失敗・秘密の器の失敗の作り物）
function leaky(name: string, extra: Record<string, unknown> = {}): Error {
  const e = new Error(`failed: ${URL_VALUE} ${DATABASE} ${ROLE} ${SECRET} ${PASSWORD}`);
  e.name = name;
  Object.assign(e, extra);
  return e;
}

async function caught(p: Promise<unknown>): Promise<Error> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!(e instanceof Error)) throw new Error("投げなかった");
  return e;
}

describe("createDbPrepHandler の呼び出しの照らし", () => {
  it("呼び出しが形に合わなければ、口も SQL も呼ばずに終え、形の誤りだけを出す", async () => {
    const bad: unknown[] = [
      undefined,
      { ...CREATE, password: PASSWORD },
      { ...CREATE, rotation_seq: 1 },
      { prep_id: PREP_ID, project_id: PROJECT_ID, kind: "rotate" },
      { ...CREATE, project_id: DATABASE },
    ];
    for (const event of bad) {
      const t = setup();
      await t.handle(event);
      expect(t.world.events).toEqual([]);
      expect(t.db.calls).toEqual([]);
      const logs = t.logs();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.msg).toBe("呼び出しが形に合わない");
      expect(logs[0]?.level).toBe(50);
      expectNoSecretIn(t.lines);
    }
  });
});

describe("createDbPrepHandler の用意の ID の読み直しと受け取り", () => {
  it("isCurrent が偽なら、SQL・readTarget・readPassword・promote・record のどれも呼ばない", async () => {
    const t = setup();
    t.world.current = false;
    await t.handle(CREATE);
    expect(t.world.events).toEqual([`isCurrent:${PROJECT_ID}:${PREP_ID}`]);
    expect(t.db.calls).toEqual([]);
    expect(t.logs()[0]).toMatchObject({ prep_id: PREP_ID, kind: "create", result: "not_current" });
  });

  it("claimPrepRun が duplicate なら、用意の SQL・readTarget・promote・record を呼ばず、duplicate_delivery を出す", async () => {
    const t = setup({ claim: "duplicate" });
    await t.handle(CREATE);
    expect(t.world.events).toEqual([`isCurrent:${PROJECT_ID}:${PREP_ID}`]);
    expect(prepStatements(t.db)).toEqual([]);
    expect(t.logs()[0]).toMatchObject({ prep_id: PREP_ID, result: "duplicate_delivery" });
  });

  it("claimPrepRun の begin が再開の待ちの尽きで投げたら、failed を含めて record を呼ばずに投げる", async () => {
    const t = setup();
    t.db.failOn = (c) => (c.kind === "begin" ? new DataApiUnavailableError(12, leaky("DatabaseResumingException")) : undefined);
    const e = await caught(t.handle(CREATE));
    expect(e).toBeInstanceOf(DbPrepFunctionError);
    expect((e as DbPrepFunctionError).stage).toBe("claim");
    expect(t.world.events).toEqual([`isCurrent:${PROJECT_ID}:${PREP_ID}`]);
    expect(t.world.records).toEqual([]);
    expect(t.logs().at(-1)).toMatchObject({ stage: "claim", err_name: "DataApiUnavailableError" });
  });

  it("claimPrepRun の commit が投げたら（確定したかが分からない）、record も用意の SQL も呼ばずに投げる", async () => {
    const t = setup();
    t.db.failOn = (c) => (c.kind === "commit" ? leaky("InternalServerErrorException") : undefined);
    await expect(t.handle(CREATE)).rejects.toBeInstanceOf(DbPrepFunctionError);
    expect(t.world.events).toEqual([`isCurrent:${PROJECT_ID}:${PREP_ID}`]);
    expect(prepStatements(t.db)).toEqual([]);
  });

  it("受け取りの失敗: 1 つ目の配信の受け取りが再開の待ちの尽きで投げ、2 つ目が用意を終えると、record は 2 つ目の applied の 1 回だけ", async () => {
    const first = setup();
    first.db.failOn = (c) => (c.kind === "begin" ? new DataApiUnavailableError(12, resumingError()) : undefined);
    const second = setup();
    second.world.records = first.world.records;
    await expect(first.handle(CREATE)).rejects.toThrow();
    await second.handle(CREATE);
    expect(first.world.records.map((r) => r.outcome)).toEqual([{ result: "applied" }]);
    expect(first.world.events).not.toContain("record");
  });
});

function resumingError(): DatabaseResumingException {
  return new DatabaseResumingException({ message: "The database is resuming", $metadata: {} });
}

describe("createDbPrepHandler の口と秘密の器の失敗", () => {
  it("readTarget が投げたら、用意の SQL も record も呼ばずに投げる", async () => {
    const t = setup();
    t.world.fail.readTarget = leaky("ConditionalCheckFailedException");
    const e = await caught(t.handle(CREATE));
    expect((e as DbPrepFunctionError).stage).toBe("read_target");
    expect(prepStatements(t.db)).toEqual([]);
    expect(t.world.events).not.toContain("record");
  });

  it("isCurrent が投げたら、SQL を打たずに投げる", async () => {
    const t = setup();
    t.world.fail.isCurrent = leaky("AccessDeniedException");
    await expect(t.handle(CREATE)).rejects.toBeInstanceOf(DbPrepFunctionError);
    expect(t.db.calls).toEqual([]);
  });

  it("口が形に合わない名前を返したら、パスワードを読まず用意の SQL を打たずに投げる", async () => {
    for (const target of [
      { ...TARGET, database: "Acme-Db" },
      { ...TARGET, role: "acme role" },
      { ...TARGET, secret: "" },
      { ...TARGET, secretVersion: "" },
    ]) {
      const t = setup();
      t.world.target = target;
      const e = await caught(t.handle(CREATE));
      expect((e as DbPrepFunctionError).stage).toBe("read_target");
      expect(prepStatements(t.db)).toEqual([]);
      expect(t.world.events.some((x) => x.startsWith("readPassword"))).toBe(false);
      expect(t.world.events).not.toContain("record");
      expect(e.message).not.toContain("Acme-Db");
    }
  });

  it("readPassword が投げたら、用意の SQL も record も呼ばずに投げる", async () => {
    const t = setup();
    t.world.fail.readPassword = leaky("ResourceNotFoundException");
    const e = await caught(t.handle(CREATE));
    expect((e as DbPrepFunctionError).stage).toBe("read_password");
    expect(prepStatements(t.db)).toEqual([]);
    expect(t.world.events).not.toContain("record");
  });

  it("promote が投げたら、record を呼ばずに投げる", async () => {
    const t = setup();
    t.world.fail.promote = leaky("AccessDeniedException");
    const e = await caught(t.handle(CREATE));
    expect((e as DbPrepFunctionError).stage).toBe("promote");
    expect(t.world.events).toContain("promote");
    expect(t.world.events).not.toContain("record");
  });

  it("record が投げたら、終わりを記さずに投げる", async () => {
    const t = setup();
    t.world.fail.record = leaky("TransactionCanceledException");
    const e = await caught(t.handle(CREATE));
    expect((e as DbPrepFunctionError).stage).toBe("record");
    expect(t.world.records).toEqual([]);
  });

  it("投げる例外の文に、元の例外の文（名前・URL・パスワード）が現れず、元の例外を繋がない", async () => {
    const t = setup();
    t.world.fail.readPassword = leaky("ResourceNotFoundException");
    const e = await caught(t.handle(CREATE));
    for (const s of SECRETS) {
      expect(e.message).not.toContain(s);
      expect(e.stack ?? "").not.toContain(s);
    }
    expect(e.cause).toBeUndefined();
    expect((e as DbPrepFunctionError).errName).toBe("ResourceNotFoundException");
  });
});

describe("createDbPrepHandler の作る", () => {
  it("用意を終えたら、結んだ版へ promote した後にだけ applied と版の ID を record へ渡す", async () => {
    const t = setup();
    await t.handle(CREATE);
    expect(t.world.events).toEqual([
      `isCurrent:${PROJECT_ID}:${PREP_ID}`,
      `readTarget:${PROJECT_ID}`,
      `readPassword:${VERSION}`,
      "promote:moved",
      "record",
    ]);
    expect(t.world.records).toEqual([{ inv: CREATE, outcome: { result: "applied" }, secretVersion: VERSION }]);
    expect(statements(t.db).some((s) => s.startsWith("CREATE DATABASE"))).toBe(true);
    expect(statements(t.db).some((s) => s.includes("CREATE ROLE %I"))).toBe(true);
    expect(t.logs().at(-1)).toMatchObject({
      prep_id: PREP_ID,
      kind: "create",
      result: "applied",
      record_result: "recorded",
      level: 30,
    });
    expect(typeof t.logs().at(-1)?.duration_ms).toBe("number");
  });

  it("claimBinding が conflict なら、何も作らず promote を呼ばずに failed・guard_conflict", async () => {
    const t = setup({ databaseExists: true });
    await t.handle(CREATE);
    expect(t.world.records.map((r) => r.outcome)).toEqual([{ result: "failed", reason: "guard_conflict" }]);
    expect(prepStatements(t.db)).toEqual([]);
    expect(t.world.events.some((x) => x.startsWith("promote"))).toBe(false);
    expect(t.logs().at(-1)).toMatchObject({ result: "failed", reason: "guard_conflict", level: 50 });
  });

  it("checkIsolationGuard が conflict なら、何も作らずに failed・guard_conflict", async () => {
    const t = setup({ guardOthers: 1 });
    await t.handle(CREATE);
    expect(t.world.records.map((r) => r.outcome)).toEqual([{ result: "failed", reason: "guard_conflict" }]);
    expect(prepStatements(t.db)).toEqual([]);
    expect(statements(t.db).some((s) => s.includes("INSERT INTO nd_prep.bindings"))).toBe(true);
  });

  it("受け取りの後の段で再開の待ちが尽きたら failed・data_api_unavailable", async () => {
    const t = setup();
    t.db.failOn = (c) => (c.kind === "execute" && c.sql.startsWith("CREATE DATABASE") ? new DataApiUnavailableError(12, leaky("DatabaseResumingException")) : undefined);
    await t.handle(CREATE);
    expect(t.world.records.map((r) => r.outcome)).toEqual([{ result: "failed", reason: "data_api_unavailable" }]);
    expect(t.world.events.some((x) => x.startsWith("promote"))).toBe(false);
    expect(t.logs().at(-1)).toMatchObject({ err_name: "DataApiUnavailableError", reason: "data_api_unavailable" });
  });

  it("ほかの SQL の失敗は failed・sql_failed で、例外の名前と SQLSTATE だけを出す", async () => {
    const t = setup();
    t.db.failOn = (c) => (c.kind === "execute" && c.sql.includes("CREATE ROLE %I") ? leaky("DatabaseError", { code: "42710" }) : undefined);
    await t.handle(CREATE);
    expect(t.world.records.map((r) => r.outcome)).toEqual([{ result: "failed", reason: "sql_failed" }]);
    const last = t.logs().at(-1);
    expect(last).toMatchObject({ err_name: "DatabaseError", sqlstate: "42710", reason: "sql_failed" });
    expectNoSecretIn(t.lines);
  });

  it("SQLSTATE の形でないコードと、識別子の形でない例外の名前は出さない", async () => {
    const t = setup();
    t.db.failOn = (c) => (c.kind === "execute" && c.sql.includes("CREATE ROLE %I") ? leaky(`bad ${ROLE}`, { code: `x ${PASSWORD}` }) : undefined);
    await t.handle(CREATE);
    const last = t.logs().at(-1);
    expect(last?.err_name).toBe("Unknown");
    expect(last).not.toHaveProperty("sqlstate");
    expectNoSecretIn(t.lines);
  });

  it("record が mismatch なら書かれずに終え、warn で出す", async () => {
    const t = setup();
    t.world.recordResult = "mismatch";
    await t.handle(CREATE);
    expect(t.logs().at(-1)).toMatchObject({ record_result: "mismatch", level: 40 });
  });
});

describe("createDbPrepHandler の差し替え", () => {
  it("記した番号 < n なら書いて古い接続を切り、残り 0 で promote の後に applied", async () => {
    const t = setup({ recorded: [{ recorded: 2, cutoff_recorded: false }, { recorded: 3, cutoff_recorded: false }] });
    await t.handle(rotate(3));
    expect(t.world.events.slice(-2)).toEqual(["promote:moved", "record"]);
    expect(t.world.records).toEqual([{ inv: rotate(3), outcome: { result: "applied" }, secretVersion: VERSION }]);
    expect(statements(t.db).some((s) => s.includes("AS signalled"))).toBe(true);
  });

  it("記した番号 = n なら書かずに切り、残り 0 で promote の後に rotation_superseded（記した番号）", async () => {
    const t = setup({ recorded: [{ recorded: 3, cutoff_recorded: true }] });
    await t.handle(rotate(3));
    expect(statements(t.db).some((s) => s.includes("ALTER ROLE %I"))).toBe(false);
    expect(t.world.events.slice(-2)).toEqual(["promote:moved", "record"]);
    expect(t.world.records.map((r) => r.outcome)).toEqual([{ result: "rotation_superseded", recorded_seq: 3 }]);
  });

  it("rotateRole で記した番号 > n なら、接続を切らず promote を呼ばずに rotation_superseded（記した番号）", async () => {
    const t = setup({ recorded: [{ recorded: 5, cutoff_recorded: true }] });
    await t.handle(rotate(3));
    expect(statements(t.db).some((s) => s.includes("AS signalled"))).toBe(false);
    expect(t.world.events.some((x) => x.startsWith("promote"))).toBe(false);
    expect(t.world.records.map((r) => r.outcome)).toEqual([{ result: "rotation_superseded", recorded_seq: 5 }]);
  });

  it("terminateRoleConnections で記した番号 > n なら、接続を切らず promote を呼ばずに rotation_superseded（記した番号）", async () => {
    const t = setup({ recorded: [{ recorded: 2, cutoff_recorded: false }, { recorded: 4, cutoff_recorded: false }] });
    await t.handle(rotate(3));
    expect(statements(t.db).some((s) => s.includes("AS signalled"))).toBe(false);
    expect(t.world.events.some((x) => x.startsWith("promote"))).toBe(false);
    expect(t.world.records.map((r) => r.outcome)).toEqual([{ result: "rotation_superseded", recorded_seq: 4 }]);
  });

  it("古い接続が期限まで残れば、promote も record も呼ばずに投げる（終わりを記さず、見回りが呼び直す。I17・I22）", async () => {
    const t = setup({ recorded: [{ recorded: 2, cutoff_recorded: false }, { recorded: 3, cutoff_recorded: false }], oldSessions: [1] });
    const e = await caught(t.handle(rotate(3)));
    expect(e).toBeInstanceOf(DbPrepFunctionError);
    expect((e as DbPrepFunctionError).stage).toBe("terminate");
    expect((e as DbPrepFunctionError).errName).toBe("ConnectionsRemainError");
    expect(t.world.events.some((x) => x.startsWith("promote"))).toBe(false);
    expect(t.world.events).not.toContain("record");
    expect(t.logs().at(-1)).toMatchObject({ stage: "terminate", err_name: "ConnectionsRemainError", level: 50 });
    // 期限（15 秒）は差し替えた時計で過ぎる
    expect(t.clock.now()).toBeGreaterThanOrEqual(15_000);
  });

  it("promote は古い接続を切るトランザクションの中で、差し替えの鎖を持ったまま確定の前に打つ", async () => {
    const t = setup({ recorded: [{ recorded: 2, cutoff_recorded: false }, { recorded: 3, cutoff_recorded: false }] });
    let callsAtPromote = -1;
    const inner = t.world.promote;
    t.world.promote = async (secret, versionId) => {
      callsAtPromote = t.db.calls.length;
      await inner(secret, versionId);
    };
    const handle = createDbPrepHandler({
      sql: t.db,
      completion: t.world.port(),
      readPassword: t.world.readPassword,
      promote: t.world.promote,
      logger: createPrepLogger({ write: () => undefined }),
      now: t.clock.now,
      sleep: t.clock.sleep,
    });
    await handle(rotate(3));
    const before = t.db.calls.slice(0, callsAtPromote);
    const after = t.db.calls.slice(callsAtPromote);
    // 最後に始めたトランザクション（古い接続の切り）は、promote の前に鎖を取り、promote の後に確定する
    const lastBegin = before.map((c) => c.kind).lastIndexOf("begin");
    expect(lastBegin).toBeGreaterThan(-1);
    const inTx = before.slice(lastBegin);
    expect(inTx.some((c) => c.kind === "execute" && c.sql.includes("nd-rotate:"))).toBe(true);
    expect(inTx.some((c) => c.kind === "commit" || c.kind === "rollback")).toBe(false);
    expect(after.map((c) => c.kind)).toEqual(["commit"]);
    expect(t.world.records.map((r) => r.outcome)).toEqual([{ result: "applied" }]);
  });

  it("差し替えで promote が投げたら、古い接続を切るトランザクションを巻き戻し、record を呼ばずに段 promote で投げる", async () => {
    const t = setup({ recorded: [{ recorded: 2, cutoff_recorded: false }, { recorded: 3, cutoff_recorded: false }] });
    t.world.fail.promote = leaky("InvalidRequestException");
    const e = await caught(t.handle(rotate(3)));
    expect((e as DbPrepFunctionError).stage).toBe("promote");
    expect((e as DbPrepFunctionError).errName).toBe("InvalidRequestException");
    expect(t.db.calls.at(-1)?.kind).toBe("rollback");
    expect(t.world.events).not.toContain("record");
    expectNoSecretIn(t.lines);
  });

  it("古い接続の 1 回目の読み直しが 1・2 回目が 0 なら applied", async () => {
    const t = setup({ recorded: [{ recorded: 2, cutoff_recorded: false }, { recorded: 3, cutoff_recorded: false }], oldSessions: [1, 0] });
    await t.handle(rotate(3));
    expect(t.world.records.map((r) => r.outcome)).toEqual([{ result: "applied" }]);
  });

  it("中断からの再開: promote の後・record の前で落ちた差し替えを、同じ番号・同じ版・新しい用意の ID で呼び直すと、移さずに確かめてから記す", async () => {
    const t = setup({ recorded: [{ recorded: 2, cutoff_recorded: false }, { recorded: 3, cutoff_recorded: false }, { recorded: 3, cutoff_recorded: true }] });
    t.world.fail.record = new Error("表へ書けない");
    await expect(t.handle(rotate(3))).rejects.toBeInstanceOf(DbPrepFunctionError);
    expect(t.world.currentVersion).toBe(VERSION);
    expect(t.world.records).toEqual([]);

    delete t.world.fail.record;
    t.world.events = [];
    await t.handle(rotate(3, "prep_acme_0002"));
    expect(t.world.events.slice(-2)).toEqual(["promote:kept", "record"]);
    expect(t.world.records).toEqual([
      { inv: rotate(3, "prep_acme_0002"), outcome: { result: "rotation_superseded", recorded_seq: 3 }, secretVersion: VERSION },
    ]);
  });

  it("どの呼び出しでも record は promote の後にだけ呼ばれ、failed では promote が呼ばれない", async () => {
    const cases: Array<{ state: FakeState; inv: DbPrepInvocation; promotes: boolean }> = [
      { state: {}, inv: CREATE, promotes: true },
      { state: { databaseExists: true }, inv: CREATE, promotes: false },
      { state: { recorded: [{ recorded: 3, cutoff_recorded: true }] }, inv: rotate(3), promotes: true },
      { state: { recorded: [{ recorded: 9, cutoff_recorded: true }] }, inv: rotate(3), promotes: false },
    ];
    for (const c of cases) {
      const t = setup(c.state);
      await t.handle(c.inv);
      const promoted = t.world.events.findIndex((x) => x.startsWith("promote"));
      const recorded = t.world.events.indexOf("record");
      expect(recorded).toBeGreaterThan(-1);
      expect(promoted > -1).toBe(c.promotes);
      if (c.promotes) expect(promoted).toBeLessThan(recorded);
    }
  });
});

describe("createDbPrepHandler のログ", () => {
  it("全行に、作り物のパスワード・URL・データベースと役割と秘密の器の名前が現れない（値を message に含む例外を投げても）", async () => {
    const lines: string[] = [];
    const runs: Array<(t: ReturnType<typeof setup>) => void> = [
      () => undefined,
      (t) => {
        t.db.failOn = (c) => (c.kind === "begin" ? new DataApiUnavailableError(12, leaky("DatabaseResumingException")) : undefined);
      },
      (t) => {
        t.db.failOn = (c) => (c.kind === "execute" && c.sql.startsWith("CREATE DATABASE") ? new DataApiUnavailableError(12, leaky("X")) : undefined);
      },
      (t) => {
        t.db.failOn = (c) => (c.kind === "execute" && c.sql.includes("CREATE ROLE %I") ? leaky("DatabaseError", { code: "42710" }) : undefined);
      },
      (t) => {
        t.world.fail.readPassword = leaky("ResourceNotFoundException");
      },
      (t) => {
        t.world.fail.promote = leaky("InvalidRequestException");
      },
      (t) => {
        t.world.fail.record = leaky("TransactionCanceledException");
      },
      (t) => {
        t.world.recordResult = "mismatch";
      },
    ];
    for (const prepare of runs) {
      const t = setup();
      prepare(t);
      await t.handle(CREATE).catch(() => undefined);
      lines.push(...t.lines);
    }
    expect(lines.length).toBeGreaterThanOrEqual(runs.length);
    expectNoSecretIn(lines);
    // 作り物の値が部分の文字列として現れないことを、照らしが実際に読めることでも確かめる
    expect(lines.join("\n")).toContain(PREP_ID);
  });
});

describe("createPrepLogger の設定", () => {
  it("伏せるキーの各々に値を入れた物を渡すと、出力にそのキーが無い", () => {
    const lines: string[] = [];
    const logger = createPrepLogger({ write: (s: string) => void lines.push(s) });
    const top: Record<string, unknown> = {};
    const nested: Record<string, unknown> = {};
    for (const path of PREP_LOG_REDACT_PATHS) {
      const key = path.replace(/^\*\./, "");
      if (path.startsWith("*.")) nested[key] = PASSWORD;
      else top[key] = PASSWORD;
    }
    logger.info({ ...top, inner: nested, prep_id: PREP_ID }, "照らし");
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    for (const key of Object.keys(top)) expect(out).not.toHaveProperty(key);
    const inner = out.inner as Record<string, unknown>;
    for (const key of Object.keys(nested)) expect(inner).not.toHaveProperty(key);
    expect(out.prep_id).toBe(PREP_ID);
    expect(lines[0]).not.toContain(PASSWORD);
  });
});

describe("DB の用意の関数の起点", () => {
  it("環境変数の 3 つを読み、1 つでも無ければ投げる", () => {
    const env = {
      [DB_PREP_ENV.clusterArn]: "arn:aws:rds:us-west-2:123456789012:cluster:acme-test-progress",
      [DB_PREP_ENV.adminSecretArn]: "arn:aws:secretsmanager:us-west-2:123456789012:secret:acme/test/progress-db-admin-AbCdEf",
      [DB_PREP_ENV.secretPrefix]: "acme/test/progress-db/",
    };
    expect(readDbPrepConfig(env)).toEqual({
      clusterArn: env[DB_PREP_ENV.clusterArn],
      adminSecretArn: env[DB_PREP_ENV.adminSecretArn],
      secretPrefix: "acme/test/progress-db/",
    });
    for (const name of Object.values(DB_PREP_ENV)) {
      expect(() => readDbPrepConfig({ ...env, [name]: undefined })).toThrow(name);
      expect(() => readDbPrepConfig({ ...env, [name]: " " })).toThrow(name);
    }
  });

  it("口がつながる前（#6 の前）の起点は、SQL の前に止まり終わりを記さない", async () => {
    const t = setup();
    const handle = createDbPrepHandler({
      sql: t.db,
      completion: UNWIRED_COMPLETION,
      readPassword: t.world.readPassword,
      promote: t.world.promote,
      logger: createPrepLogger({ write: () => undefined }),
      now: () => 0,
    });
    await expect(handle(CREATE)).rejects.toBeInstanceOf(DbPrepFunctionError);
    expect(t.db.calls).toEqual([]);
  });
});

// --- PostgreSQL のサービスコンテナ ---

// 作り物の口。readTarget はテストのプロジェクトの名前を返し、record は呼ばれた順に残す
function pgWorld(target: PrepTarget, password: string) {
  const records: DbPrepOutcome[] = [];
  const port: PrepCompletionPort = {
    isCurrent: async () => true,
    readTarget: async () => target,
    record: async (_inv, outcome) => {
      records.push(outcome);
      return "recorded";
    },
  };
  return { records, port, readPassword: async () => password, promote: async () => undefined };
}

// 打った文を数える SqlExecutor
function counting(inner: SqlExecutor, seen: string[]): SqlExecutor {
  return {
    ...inner,
    execute: (s, p, o) => {
      seen.push(s);
      return inner.execute(s, p, o);
    },
  };
}

function newTarget(db: TestDatabase): PrepTarget {
  const s = randomBytes(5).toString("hex");
  const target = { database: `acme_h_db_${s}`, role: `acme_h_role_${s}`, secret: "acme/test/progress-db/h", secretVersion: VERSION };
  db.dropDatabaseLater(target.database);
  db.dropRoleLater(target.role);
  return target;
}

describePgDisposable("createDbPrepHandler（PostgreSQL）", () => {
  it("重複の配信: 同じ create の呼び出しを 2 つ同時に打つと、CREATE DATABASE と CREATE ROLE を打つのは 1 つだけで、record は applied の 1 回だけ", async () => {
    await withTestDatabase(async (db) => {
      const target = newTarget(db);
      const world = pgWorld(target, randomBytes(24).toString("base64url"));
      const seen: string[][] = [[], []];
      const handles = seen.map((s) =>
        createDbPrepHandler({
          sql: counting(db.executor(), s),
          completion: world.port,
          readPassword: world.readPassword,
          promote: world.promote,
          logger: createPrepLogger({ write: () => undefined }),
          now: () => performance.now(),
        }),
      );
      await Promise.all(handles.map((h) => h(CREATE)));
      const creates = seen.map((s) => s.filter((x) => x.startsWith("CREATE DATABASE") || x.includes("CREATE ROLE %I")).length);
      expect(creates.sort()).toEqual([0, 2]);
      expect(world.records).toEqual([{ result: "applied" }]);
    });
  });

  it("重なった差し替え: 古い番号の呼び出しが版を移す間は鎖を持ち、新しい番号の呼び出しは待ってから移すため、最後に AWSCURRENT が付くのは新しい版", async () => {
    await withTestDatabase(async (db) => {
      const target = newTarget(db);
      const versions: Record<string, string> = { v0: randomBytes(24).toString("base64url"), v1: randomBytes(24).toString("base64url"), v2: randomBytes(24).toString("base64url") };
      let current: string | undefined;
      const promoted: string[] = [];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let oldPromoting: () => void = () => undefined;
      const oldReachedPromote = new Promise<void>((resolve) => {
        oldPromoting = resolve;
      });
      const records: Array<{ seq: number | undefined; outcome: DbPrepOutcome }> = [];
      const handlerFor = (version: string, gated: boolean) =>
        createDbPrepHandler({
          sql: db.executor(),
          completion: {
            isCurrent: async () => true,
            readTarget: async () => ({ ...target, secretVersion: version }),
            record: async (inv, outcome) => {
              records.push({ seq: inv.kind === "rotate" ? inv.rotation_seq : undefined, outcome });
              return "recorded";
            },
          },
          readPassword: async (_secret, versionId) => versions[versionId] ?? "",
          promote: async (_secret, versionId) => {
            if (gated) {
              oldPromoting();
              await gate;
            }
            promoted.push(versionId);
            current = versionId;
          },
          logger: createPrepLogger({ write: () => undefined }),
          now: () => performance.now(),
        });
      await handlerFor("v0", false)(CREATE);
      const older = handlerFor("v1", true)(rotate(1, "prep_acme_old"));
      await oldReachedPromote;
      const newer = handlerFor("v2", false)(rotate(2, "prep_acme_new"));
      // 新しい呼び出しは鎖を待つため、古い呼び出しが移し終えるまで進めない（進めば先に終わる）
      const newerFirst = await Promise.race([newer.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1_000))]);
      release();
      await Promise.all([older, newer]);
      expect(newerFirst).toBe(false);
      expect(promoted).toEqual(["v0", "v1", "v2"]);
      expect(current).toBe("v2");
      // DB のパスワードも新しい版と合う
      const ok = await db.connect(target.database, { user: target.role, password: versions.v2 ?? "" }).then(
        async (c) => {
          await c.end();
          return true;
        },
        () => false,
      );
      expect(ok).toBe(true);
      expect(records.filter((r) => r.seq !== undefined).map((r) => [r.seq, r.outcome.result])).toEqual([
        [1, "applied"],
        [2, "applied"],
      ]);
    });
  });
});

