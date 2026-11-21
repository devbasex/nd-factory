import {
  BadRequestException,
  BeginTransactionCommand,
  CommitTransactionCommand,
  DatabaseResumingException,
  ExecuteStatementCommand,
  type Field,
  RDSDataClient,
  type RDSDataClientConfig,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import pRetry from "p-retry";
import type * as PRetryModule from "p-retry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimPrepRun } from "../../src/db-prep/prep-run.ts";
import {
  ADMIN_DATABASE,
  DataApiUnavailableError,
  RESUME_WAIT_ERRORS,
  createDataApiExecutor,
  createRdsDataClient,
  toRow,
} from "../../src/db-prep/sql-executor.ts";
import { FakeSqlExecutor } from "./fake-sql-executor.ts";
import { describePg, toPositional, withTestDatabase } from "./pg-executor.ts";

// p-retry に渡した値を読むため、本物の関数を包んで呼ばれ方を残す
vi.mock("p-retry", async (importOriginal) => {
  const actual = await importOriginal<typeof PRetryModule>();
  return { ...actual, default: vi.fn(actual.default) };
});

const RESOURCE_ARN = "arn:aws:rds:us-west-2:123456789012:cluster:acme-test-progress";
const SECRET_ARN = "arn:aws:secretsmanager:us-west-2:123456789012:secret:acme/test/progress-db-admin-AbCdEf";

// 2 つの実装が同じ行を同じ値で返すことを照らす文と行
const SAME_ROW_SQL = "SELECT 7::int AS n, 'acme'::text AS s, true AS b, NULL::text AS z";
const SAME_ROW = { n: 7, s: "acme", b: true, z: null };
// SAME_ROW_SQL への Data API の応答（includeResultMetadata の records と columnMetadata）
const SAME_ROW_OUTPUT = {
  columnMetadata: [{ label: "n" }, { label: "s" }, { label: "b" }, { label: "z" }],
  records: [[{ longValue: 7 }, { stringValue: "acme" }, { booleanValue: true }, { isNull: true }]],
};

// 1 列の Data API の応答
function oneColumn(label: string, values: Field[]): { columnMetadata: { label: string }[]; records: Field[][] } {
  return { columnMetadata: [{ label }], records: values.map((v) => [v]) };
}

type Command = ExecuteStatementCommand | BeginTransactionCommand | CommitTransactionCommand | RollbackTransactionCommand;

// RDS Data API のクライアントの代わり。命令と、送られた時の時計の値を残す
class FakeRdsData {
  calls: Command[] = [];
  sentAt: number[] = [];
  handle: (cmd: Command, n: number) => unknown = () => ({});

  // createRdsDataClient で作ったクライアントの送りだけを差し替える（createDataApiExecutor はほかのクライアントを受けない）
  asClient(): RDSDataClient {
    const client = createRdsDataClient({ region: "us-west-2", credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" } });
    client.send = ((cmd: Command) => this.send(cmd)) as unknown as RDSDataClient["send"];
    return client;
  }

  async send(cmd: Command): Promise<unknown> {
    this.calls.push(cmd);
    this.sentAt.push(performance.now());
    return this.handle(cmd, this.calls.length);
  }
}

function resuming(): DatabaseResumingException {
  return new DatabaseResumingException({ message: "The database is resuming", $metadata: {} });
}

function executor(fake: FakeRdsData, retry?: Parameters<typeof createDataApiExecutor>[0]["retry"]) {
  return createDataApiExecutor({ client: fake.asClient(), resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN, retry });
}

// 時計を進めきってから約束の結果を読む。先に catch を付け、未処理の拒否にしない
async function settle<T>(p: Promise<T>): Promise<{ ok: T } | { err: unknown }> {
  const out = p.then(
    (ok) => ({ ok }),
    (err: unknown) => ({ err }),
  );
  await vi.runAllTimersAsync();
  return out;
}

describe("createDataApiExecutor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.mocked(pRetry).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("execute は database と transactionId をそのまま渡し、列の名前を求め、打ち切りの無効を明示する", async () => {
    const fake = new FakeRdsData();
    const sql = executor(fake);
    await sql.execute("SELECT 1", undefined, { database: "acme_db", transactionId: "tx-1" });
    const cmd = fake.calls[0] as ExecuteStatementCommand;
    expect(cmd).toBeInstanceOf(ExecuteStatementCommand);
    expect(cmd.input).toEqual({
      resourceArn: RESOURCE_ARN,
      secretArn: SECRET_ARN,
      database: "acme_db",
      sql: "SELECT 1",
      transactionId: "tx-1",
      includeResultMetadata: true,
      continueAfterTimeout: false,
    });
  });

  it("transactionId の無い execute は transactionId の項目を持たない", async () => {
    const fake = new FakeRdsData();
    await executor(fake).execute("CREATE DATABASE x", undefined, { database: ADMIN_DATABASE });
    const cmd = fake.calls[0] as ExecuteStatementCommand;
    expect(cmd.input.database).toBe(ADMIN_DATABASE);
    expect("transactionId" in cmd.input).toBe(false);
  });

  it("引数を名前つきの値の型へ変えて渡す", async () => {
    const fake = new FakeRdsData();
    await executor(fake).execute(
      "SELECT :s, :i, :d, :b, :n",
      [
        { name: "s", value: "acme" },
        { name: "i", value: 7 },
        { name: "d", value: 1.5 },
        { name: "b", value: true },
        { name: "n", value: null },
      ],
      { database: ADMIN_DATABASE },
    );
    expect((fake.calls[0] as ExecuteStatementCommand).input.parameters).toEqual([
      { name: "s", value: { stringValue: "acme" } },
      { name: "i", value: { longValue: 7 } },
      { name: "d", value: { doubleValue: 1.5 } },
      { name: "b", value: { booleanValue: true } },
      { name: "n", value: { isNull: true } },
    ]);
  });

  it("records と列の名前から Row を組んで返し、行の無い文は空を返す", async () => {
    const fake = new FakeRdsData();
    fake.handle = (_cmd, n) => (n === 1 ? SAME_ROW_OUTPUT : {});
    const sql = executor(fake);
    expect(await sql.execute(SAME_ROW_SQL, undefined, { database: ADMIN_DATABASE })).toEqual([SAME_ROW]);
    expect(await sql.execute("CREATE SCHEMA x", undefined, { database: ADMIN_DATABASE })).toEqual([]);
  });

  it("型の決まらない列（配列・バイト列）と、列の名前の無い行を受けない", async () => {
    const fake = new FakeRdsData();
    const sql = executor(fake);
    fake.handle = () => oneColumn("a", [{ arrayValue: { longValues: [1, 2] } }]);
    await expect(sql.execute("SELECT", undefined, { database: ADMIN_DATABASE })).rejects.toThrow();
    fake.handle = () => oneColumn("a", [{ blobValue: new Uint8Array([1]) }]);
    await expect(sql.execute("SELECT", undefined, { database: ADMIN_DATABASE })).rejects.toThrow();
    fake.handle = () => ({ records: [[{ longValue: 1 }]] });
    await expect(sql.execute("SELECT", undefined, { database: ADMIN_DATABASE })).rejects.toThrow();
  });

  it("claimPrepRun は Data API の応答の形で、挿入の行があれば first、無ければ duplicate", async () => {
    // INSERT … RETURNING の行は records にだけ載り、formattedRecords は SELECT にしか返らない
    for (const [inserted, expected] of [
      [true, "first"],
      [false, "duplicate"],
    ] as const) {
      const fake = new FakeRdsData();
      fake.handle = (cmd) => {
        if (cmd instanceof BeginTransactionCommand) return { transactionId: "tx-1" };
        if (!(cmd instanceof ExecuteStatementCommand)) return {};
        const text = cmd.input.sql ?? "";
        if (text.includes("to_regclass")) return oneColumn("present", [{ booleanValue: true }]);
        if (text.includes("RETURNING")) return oneColumn("prep_id", inserted ? [{ stringValue: "prep-1" }] : []);
        return { numberOfRecordsUpdated: 0 };
      };
      expect(await claimPrepRun(executor(fake), "prep-1")).toBe(expected);
      expect(fake.calls.at(-1)).toBeInstanceOf(CommitTransactionCommand);
    }
  });

  it("createRdsDataClient で作っていないクライアントは、作る時に投げる", () => {
    const fake = new FakeRdsData();
    const client = { config: { maxAttempts: async () => 1 }, send: (cmd: Command) => fake.send(cmd) } as unknown as RDSDataClient;
    expect(() => createDataApiExecutor({ client, resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN })).toThrow(/createRdsDataClient/);
    expect(fake.calls).toHaveLength(0);
  });

  it("begin の返す ID を commit と rollback へ渡す", async () => {
    const fake = new FakeRdsData();
    fake.handle = (cmd) => (cmd instanceof BeginTransactionCommand ? { transactionId: "tx-abc" } : {});
    const sql = executor(fake);
    const id = await sql.begin({ database: ADMIN_DATABASE });
    expect(id).toBe("tx-abc");
    await sql.commit(id);
    await sql.rollback(id);
    expect((fake.calls[0] as BeginTransactionCommand).input).toEqual({
      resourceArn: RESOURCE_ARN,
      secretArn: SECRET_ARN,
      database: ADMIN_DATABASE,
    });
    expect(fake.calls[1]).toBeInstanceOf(CommitTransactionCommand);
    expect((fake.calls[1] as CommitTransactionCommand).input).toEqual({
      resourceArn: RESOURCE_ARN,
      secretArn: SECRET_ARN,
      transactionId: "tx-abc",
    });
    expect(fake.calls[2]).toBeInstanceOf(RollbackTransactionCommand);
    expect((fake.calls[2] as RollbackTransactionCommand).input.transactionId).toBe("tx-abc");
  });

  it("begin が ID を返さなければ投げる", async () => {
    const fake = new FakeRdsData();
    await expect(executor(fake).begin({ database: ADMIN_DATABASE })).rejects.toThrow();
  });

  it("繰り返すのは DatabaseResumingException だけ", () => {
    expect(RESUME_WAIT_ERRORS).toEqual(["DatabaseResumingException"]);
  });

  it("既定の値で p-retry に回数・間隔・期限を渡す", async () => {
    const fake = new FakeRdsData();
    await executor(fake).execute("SELECT 1", undefined, { database: ADMIN_DATABASE });
    const opts = vi.mocked(pRetry).mock.calls[0]?.[1];
    expect(opts).toMatchObject({
      retries: 11,
      factor: 1,
      minTimeout: 5000,
      maxTimeout: 5000,
      randomize: false,
      maxRetryTime: 60000,
    });
    expect(opts).not.toHaveProperty("shouldRetry");
  });

  it("2 回目の試行で再開の待ちが止めば返す", async () => {
    const fake = new FakeRdsData();
    fake.handle = (_cmd, n) => {
      if (n === 1) throw resuming();
      return oneColumn("n", [{ longValue: 1 }]);
    };
    const out = await settle(executor(fake).execute("SELECT 1 AS n", undefined, { database: ADMIN_DATABASE }));
    expect(out).toEqual({ ok: [{ n: 1 }] });
    expect(fake.calls).toHaveLength(2);
    expect(fake.sentAt[1]! - fake.sentAt[0]!).toBe(5000);
  });

  it("begin も再開の待ちを繰り返す", async () => {
    const fake = new FakeRdsData();
    fake.handle = (_cmd, n) => {
      if (n < 3) throw resuming();
      return { transactionId: "tx-1" };
    };
    expect(await settle(executor(fake).begin({ database: ADMIN_DATABASE }))).toEqual({ ok: "tx-1" });
    expect(fake.calls).toHaveLength(3);
  });

  it("再開の待ちが続くと 12 回試して DataApiUnavailableError を投げ、13 回目を打たない", async () => {
    const fake = new FakeRdsData();
    fake.handle = () => {
      throw resuming();
    };
    const out = await settle(executor(fake).execute("SELECT 1", undefined, { database: ADMIN_DATABASE }));
    expect(fake.calls).toHaveLength(12);
    expect(fake.sentAt[11]! - fake.sentAt[0]!).toBe(55_000);
    expect("err" in out && out.err).toBeInstanceOf(DataApiUnavailableError);
    const err = (out as { err: DataApiUnavailableError }).err;
    expect(err.attempts).toBe(12);
    expect((err.cause as Error).name).toBe("DatabaseResumingException");
  });

  it("切り詰めた待ちが期限ちょうどで明けたら、試行の関数は打たずに投げる", async () => {
    const fake = new FakeRdsData();
    fake.handle = () => {
      throw resuming();
    };
    // 0・5,000・10,000 の 3 回の後、p-retry は待ちを残りの 2,000 に切り詰め、12,000 で次の試行を呼ぶ
    const sql = executor(fake, { attempts: 12, delayMs: 5000, deadlineMs: 12_000, now: () => performance.now() });
    const out = await settle(sql.begin({ database: ADMIN_DATABASE }));
    expect(fake.calls).toHaveLength(3);
    expect("err" in out && out.err).toBeInstanceOf(DataApiUnavailableError);
    expect((out as { err: DataApiUnavailableError }).err.attempts).toBe(3);
  });

  it("期限は差し替えた時計で、呼び出しごとの最初の試行から測る", async () => {
    const fake = new FakeRdsData();
    let clock = 0;
    fake.handle = () => {
      // 1 回の試行が 30 秒かかったことにする
      clock += 30_000;
      throw resuming();
    };
    const sql = executor(fake, { attempts: 12, delayMs: 5000, deadlineMs: 60_000, now: () => clock });
    const out = await settle(sql.execute("SELECT 1", undefined, { database: ADMIN_DATABASE }));
    // 試行の始めの時計は 0・30,000 で、3 回目の始めは 60,000（期限ちょうど）で打たない
    expect(fake.calls).toHaveLength(2);
    expect("err" in out && out.err).toBeInstanceOf(DataApiUnavailableError);

    // 次の呼び出しは、その呼び出しの最初の試行から測り直す
    fake.handle = () => ({});
    expect(await settle(sql.execute("SELECT 1", undefined, { database: ADMIN_DATABASE }))).toEqual({ ok: [] });
  });

  it("transactionId を持つ execute は再開の待ちでも繰り返さない", async () => {
    const fake = new FakeRdsData();
    fake.handle = () => {
      throw resuming();
    };
    const out = await settle(executor(fake).execute("SELECT 1", undefined, { database: ADMIN_DATABASE, transactionId: "tx-1" }));
    expect(fake.calls).toHaveLength(1);
    expect((out as { err: Error }).err.name).toBe("DatabaseResumingException");
  });

  it("commit と rollback は再開の待ちでも繰り返さない", async () => {
    const fake = new FakeRdsData();
    fake.handle = () => {
      throw resuming();
    };
    const sql = executor(fake);
    expect(((await settle(sql.commit("tx-1"))) as { err: Error }).err.name).toBe("DatabaseResumingException");
    expect(((await settle(sql.rollback("tx-1"))) as { err: Error }).err.name).toBe("DatabaseResumingException");
    expect(fake.calls).toHaveLength(2);
  });

  it("RESUME_WAIT_ERRORS に無い例外は 1 回で、そのまま投げる", async () => {
    const fake = new FakeRdsData();
    const bad = new BadRequestException({ message: "syntax error", $metadata: {} });
    fake.handle = () => {
      throw bad;
    };
    const sql = executor(fake);
    expect(await settle(sql.execute("SELEC 1", undefined, { database: ADMIN_DATABASE }))).toEqual({ err: bad });
    expect(await settle(sql.begin({ database: ADMIN_DATABASE }))).toEqual({ err: bad });
    expect(fake.calls).toHaveLength(2);
  });

  it("試す回数が 1 未満の設定を受けない", () => {
    expect(() => executor(new FakeRdsData(), { attempts: 0, delayMs: 5000, deadlineMs: 60_000, now: () => 0 })).toThrow();
  });
});

// SDK の送りの層（requestHandler）を差し替え、SDK の再試行を通す
describe("createRdsDataClient（SDK の再試行）", () => {
  // 一時的な障害（503）を返す送りの層。受けた回数を数える
  function unavailableHandler(): { handle: (req: unknown) => Promise<{ response: unknown }>; count: () => number } {
    let n = 0;
    return {
      handle: async () => {
        n += 1;
        return {
          response: {
            statusCode: 503,
            headers: { "content-type": "application/json", "x-amzn-errortype": "ServiceUnavailableError" },
            body: new TextEncoder().encode(JSON.stringify({ message: "unavailable" })),
          },
        };
      },
      count: () => n,
    };
  }
  const base = {
    region: "us-west-2",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
  };

  it("既定のクライアントは 503 を打ち直す（この差し替えが SDK の再試行を通ることの確かめ）", async () => {
    const h = unavailableHandler();
    const client = new RDSDataClient({ ...base, requestHandler: h });
    await expect(client.send(new CommitTransactionCommand({ resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN, transactionId: "tx-1" }))).rejects.toThrow();
    expect(h.count()).toBeGreaterThan(1);
  });

  it("createRdsDataClient のクライアントでは、commit も文も 1 回だけ送って投げる", async () => {
    const h = unavailableHandler();
    const sql = createDataApiExecutor({
      client: createRdsDataClient({ ...base, requestHandler: h }),
      resourceArn: RESOURCE_ARN,
      secretArn: SECRET_ARN,
    });
    await expect(sql.commit("tx-1")).rejects.toThrow();
    expect(h.count()).toBe(1);
    await expect(sql.execute("SELECT 1", undefined, { database: ADMIN_DATABASE, transactionId: "tx-1" })).rejects.toThrow();
    expect(h.count()).toBe(2);
    // トランザクションの外の文も、再開の待ち（DatabaseResumingException）でなければ打ち直さない
    await expect(sql.execute("SELECT 1", undefined, { database: ADMIN_DATABASE })).rejects.toThrow();
    expect(h.count()).toBe(3);
  });

  it("既定の RDSDataClient を渡すと作る時に投げる", () => {
    const h = unavailableHandler();
    const client = new RDSDataClient({ ...base, requestHandler: h });
    expect(() => createDataApiExecutor({ client, resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN })).toThrow(/createRdsDataClient/);
    expect(h.count()).toBe(0);
  });

  // 打ち直す戦略（3 回まで）。maxAttempts は 1 と答えるが、戦略が文と commit を打ち直す
  function retryingStrategy(): NonNullable<RDSDataClientConfig["retryStrategy"]> {
    type Token = { getRetryCount(): number; getRetryDelay(): number };
    const token = (n: number): Token => ({ getRetryCount: () => n, getRetryDelay: () => 0 });
    return {
      acquireInitialRetryToken: async () => token(0),
      refreshRetryTokenForRetry: async (t: Token, e: unknown) => {
        if (t.getRetryCount() >= 2) throw e;
        return token(t.getRetryCount() + 1);
      },
      recordSuccess: () => undefined,
    };
  }

  it("maxAttempts: 1 と独自の retryStrategy を持つ RDSDataClient を渡すと作る時に投げる", async () => {
    // この差し替えが戦略で打ち直すことの確かめ
    const probe = unavailableHandler();
    const raw = new RDSDataClient({ ...base, maxAttempts: 1, retryStrategy: retryingStrategy(), requestHandler: probe });
    await expect(raw.send(new CommitTransactionCommand({ resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN, transactionId: "tx-1" }))).rejects.toThrow();
    expect(probe.count()).toBeGreaterThan(1);
    expect(await raw.config.maxAttempts()).toBe(1);

    const h = unavailableHandler();
    const client = new RDSDataClient({ ...base, maxAttempts: 1, retryStrategy: retryingStrategy(), requestHandler: h });
    expect(() => createDataApiExecutor({ client, resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN })).toThrow(/createRdsDataClient/);
    expect(h.count()).toBe(0);
  });

  it("createRdsDataClient は型の外から渡された retryStrategy と maxAttempts を捨て、1 回だけ送る", async () => {
    const h = unavailableHandler();
    const config = { ...base, maxAttempts: 5, retryStrategy: retryingStrategy(), requestHandler: h };
    const client = createRdsDataClient(config as Parameters<typeof createRdsDataClient>[0]);
    const sql = createDataApiExecutor({ client, resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN });
    await expect(sql.commit("tx-1")).rejects.toThrow();
    expect(h.count()).toBe(1);
  });

  // configure から setRetryStrategy を呼んで、maxAttempts を 1 のまま戦略を差し替える拡張
  function retryingExtension(): NonNullable<RDSDataClientConfig["extensions"]>[number] {
    const strategy = retryingStrategy();
    return { configure: (c) => c.setRetryStrategy(async () => strategy) };
  }

  it("createRdsDataClient は型の外から渡された extensions を捨て、拡張で戦略を指定しても 1 回だけ送る", async () => {
    // この拡張が maxAttempts を 1 のまま戦略で打ち直すことの確かめ
    const probe = unavailableHandler();
    const raw = new RDSDataClient({ ...base, maxAttempts: 1, extensions: [retryingExtension()], requestHandler: probe });
    await expect(raw.send(new CommitTransactionCommand({ resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN, transactionId: "tx-1" }))).rejects.toThrow();
    expect(probe.count()).toBeGreaterThan(1);
    expect(await raw.config.maxAttempts()).toBe(1);

    const h = unavailableHandler();
    const config = { ...base, extensions: [retryingExtension()], requestHandler: h };
    const client = createRdsDataClient(config as Parameters<typeof createRdsDataClient>[0]);
    const sql = createDataApiExecutor({ client, resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN });
    await expect(sql.commit("tx-1")).rejects.toThrow();
    expect(h.count()).toBe(1);
    await expect(sql.execute("SELECT 1", undefined, { database: ADMIN_DATABASE })).rejects.toThrow();
    expect(h.count()).toBe(2);
  });

  // 作った後に config の戦略と回数を差し替える。どちらも書き換えられない項目のため投げる
  function replaceRetry(client: RDSDataClient): void {
    const strategy = retryingStrategy();
    const config = client.config as { retryStrategy: unknown; maxAttempts: unknown };
    expect(() => {
      config.retryStrategy = async () => strategy;
    }).toThrow(TypeError);
    expect(() => {
      config.maxAttempts = async () => 3;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(config, "retryStrategy", { value: async () => strategy })).toThrow(TypeError);
    // config をオブジェクトごと差し替えて、固めた 2 項目を通らずに戦略を変える
    const holder = client as { config: unknown };
    expect(() => {
      holder.config = { ...client.config, retryStrategy: async () => strategy };
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(client, "config", { value: { ...client.config, retryStrategy: async () => strategy } })).toThrow(TypeError);
  }

  // 戦略のインスタンスを取り出し、refreshRetryTokenForRetry を打ち直すトークンを返すものへ差し替える
  async function replaceStrategyMethod(client: RDSDataClient): Promise<void> {
    const instance = (await client.config.retryStrategy()) as { refreshRetryTokenForRetry: unknown };
    instance.refreshRetryTokenForRetry = (retryingStrategy() as { refreshRetryTokenForRetry: unknown }).refreshRetryTokenForRetry;
  }

  it("createRdsDataClient の戦略のインスタンスは変えられず、変えようとした後も commit は 1 回だけ送る", async () => {
    // SDK の既定の戦略は maxAttempts: 1 でも、インスタンスの refreshRetryTokenForRetry を差し替えると打ち直すことの確かめ
    const probe = unavailableHandler();
    const raw = new RDSDataClient({ ...base, maxAttempts: 1, requestHandler: probe });
    await replaceStrategyMethod(raw);
    await expect(raw.send(new CommitTransactionCommand({ resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN, transactionId: "tx-1" }))).rejects.toThrow();
    expect(probe.count()).toBeGreaterThan(1);

    const h = unavailableHandler();
    const client = createRdsDataClient({ ...base, requestHandler: h });
    await expect(replaceStrategyMethod(client)).rejects.toThrow(TypeError);
    expect(Object.isFrozen(await client.config.retryStrategy())).toBe(true);
    const sql = createDataApiExecutor({ client, resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN });
    await expect(sql.commit("tx-1")).rejects.toThrow(/unavailable/);
    expect(h.count()).toBe(1);
  });

  it("createRdsDataClient で作った後は config の戦略と回数を差し替えられず、commit は 1 回だけ送る", async () => {
    const h = unavailableHandler();
    const client = createRdsDataClient({ ...base, requestHandler: h });
    replaceRetry(client);
    const sql = createDataApiExecutor({ client, resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN });
    await expect(sql.commit("tx-1")).rejects.toThrow();
    expect(h.count()).toBe(1);
  });

  it("送っている commit の途中で戦略を差し替えようとしても、その commit は打ち直されない", async () => {
    const h = unavailableHandler();
    const client = createRdsDataClient({ ...base, requestHandler: h });
    const sql = createDataApiExecutor({ client, resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN });
    const pending = sql.commit("tx-1");
    replaceRetry(client);
    await expect(pending).rejects.toThrow();
    expect(h.count()).toBe(1);
  });

  it("差し替えを試みた後も rollback は送れ、1 回だけ送る", async () => {
    const h = unavailableHandler();
    const client = createRdsDataClient({ ...base, requestHandler: h });
    const sql = createDataApiExecutor({ client, resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN });
    replaceRetry(client);
    // 送りの層まで届き（503 で投げる）、検査では投げない
    await expect(sql.rollback("tx-1")).rejects.toThrow(/unavailable/);
    expect(h.count()).toBe(1);
  });
});

describe("toRow", () => {
  it("文字列・数・真偽・空だけを受ける", () => {
    expect(toRow(SAME_ROW)).toEqual(SAME_ROW);
    expect(() => toRow({ t: new Date(0) })).toThrow();
    expect(() => toRow({ o: { a: 1 } })).toThrow();
    expect(() => toRow([1])).toThrow();
  });
});

describe("toPositional", () => {
  it("名前つきの引数を番号へ変え、同じ名前は同じ番号にする", () => {
    expect(
      toPositional("SELECT :a, :b, :a", [
        { name: "a", value: 1 },
        { name: "b", value: "x" },
      ]),
    ).toEqual({ text: "SELECT $1::bigint, $2, $1::bigint", values: [1, "x"] });
  });

  it("型の決め・文字列・識別子・注釈の中の : を引数にしない", () => {
    const sql = `SELECT :a::int, 'SCRAM-SHA-256$4096:abc$x:y', E'it''s :b', "col:c" -- :d\n, /* :e */ 1`;
    expect(toPositional(sql, [{ name: "a", value: 1 }])).toEqual({
      text: `SELECT $1::bigint::int, 'SCRAM-SHA-256$4096:abc$x:y', E'it''s :b', "col:c" -- :d\n, /* :e */ 1`,
      values: [1],
    });
  });

  it("渡されていない名前・重なる名前・閉じない文字列で投げる", () => {
    expect(() => toPositional("SELECT :a", [])).toThrow();
    expect(() =>
      toPositional("SELECT :a", [
        { name: "a", value: 1 },
        { name: "a", value: 2 },
      ]),
    ).toThrow();
    expect(() => toPositional("SELECT 'a", undefined)).toThrow();
  });
});

describe("手順の文の長さ", () => {
  it("claimPrepRun が渡す文はどれも 4 KiB 未満", async () => {
    // 表が無いとき（作る文を含む）と、あるときの両方の分かれを打つ
    for (const present of [false, true]) {
      const fake = new FakeSqlExecutor();
      fake.respond = (sql) => {
        if (sql.includes("AS present")) return [{ present }];
        if (sql.includes("RETURNING")) return [{ prep_id: "prep-1" }];
        return [];
      };
      await claimPrepRun(fake, "prep-1");
      expect(fake.statements().length).toBeGreaterThan(0);
      for (const s of fake.statements()) expect(Buffer.byteLength(s, "utf8")).toBeLessThan(4096);
    }
  });
});

describePg("createPgExecutor", () => {
  it("Data API の実装と同じ行を同じ値の型で返す", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      expect(await sql.execute(SAME_ROW_SQL, undefined, { database: ADMIN_DATABASE })).toEqual([SAME_ROW]);
    });
  });

  it("名前つきの引数を束ねて打つ", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const rows = await sql.execute(
        "SELECT :i::int AS i, :s::text AS s, :b::boolean AS b",
        [
          { name: "i", value: 3 },
          { name: "s", value: "x:y" },
          { name: "b", value: false },
        ],
        { database: ADMIN_DATABASE },
      );
      expect(rows).toEqual([{ i: 3, s: "x:y", b: false }]);
    });
  });

  it("型を決めない時刻の列を受けない", async () => {
    await withTestDatabase(async (db) => {
      await expect(db.executor().execute("SELECT now() AS t", undefined, { database: ADMIN_DATABASE })).rejects.toThrow();
    });
  });

  it("begin の接続に結んだ文は commit まで外から見えず、rollback で消える", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      await sql.execute("CREATE TABLE t (v int)", undefined, { database: ADMIN_DATABASE });
      const tx = await sql.begin({ database: ADMIN_DATABASE });
      await sql.execute("INSERT INTO t VALUES (1)", undefined, { database: ADMIN_DATABASE, transactionId: tx });
      expect(await sql.execute("SELECT count(*)::int AS c FROM t", undefined, { database: ADMIN_DATABASE })).toEqual([{ c: 0 }]);
      await sql.commit(tx);
      expect(await sql.execute("SELECT count(*)::int AS c FROM t", undefined, { database: ADMIN_DATABASE })).toEqual([{ c: 1 }]);

      const tx2 = await sql.begin({ database: ADMIN_DATABASE });
      await sql.execute("INSERT INTO t VALUES (2)", undefined, { database: ADMIN_DATABASE, transactionId: tx2 });
      await sql.rollback(tx2);
      expect(await sql.execute("SELECT count(*)::int AS c FROM t", undefined, { database: ADMIN_DATABASE })).toEqual([{ c: 1 }]);
    });
  });

  it("失敗した文の後の commit は確定せずに投げる", async () => {
    await withTestDatabase(async (db) => {
      const sql = db.executor();
      const tx = await sql.begin({ database: ADMIN_DATABASE });
      await expect(sql.execute("SELEC 1", undefined, { database: ADMIN_DATABASE, transactionId: tx })).rejects.toThrow();
      await expect(sql.commit(tx)).rejects.toThrow();
    });
  });
});
