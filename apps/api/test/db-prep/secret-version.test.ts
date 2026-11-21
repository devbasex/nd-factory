import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
  UpdateSecretVersionStageCommand,
} from "@aws-sdk/client-secrets-manager";
import { describe, expect, it } from "vitest";
import { promoteVersion, readVersionPassword } from "../../src/db-prep/secret-version.ts";

// 作り物の値だけを使う
const SECRET = "acme/test/progress-db/prj_01890a5d-ac96-7a3b-8c4d-0123456789ab";
const VERSION = "0b9c3c1e-5f0a-4d6b-9a51-2f6c8e1d7a01";
const OLD_VERSION = "7d2f4a10-3c8b-4e9f-8a26-91b0c5e4d3f2";
const PASSWORD = "acme-Version-0123456789abcdefghijklmnop";
const URL_VALUE = `postgresql://acme_role_aaaaaaaa:${PASSWORD}@acme-progress.example.com:5432/acme_db_aaaaaaaa`;

type Command = GetSecretValueCommand | DescribeSecretCommand | UpdateSecretVersionStageCommand;

// Secrets Manager のクライアントの代わり。送られた命令を残し、答えを差し込める
class FakeSecrets {
  calls: Command[] = [];
  // 送られた命令ごとの打ち切りの信号
  signals: Array<AbortSignal | undefined> = [];
  handle: (cmd: Command) => unknown = () => ({});

  asClient(): SecretsManagerClient {
    const client = new SecretsManagerClient({
      region: "us-west-2",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    });
    client.send = ((cmd: Command, opts?: { abortSignal?: AbortSignal }) => {
      this.signals.push(opts?.abortSignal);
      return this.send(cmd);
    }) as unknown as SecretsManagerClient["send"];
    return client;
  }

  async send(cmd: Command): Promise<unknown> {
    this.calls.push(cmd);
    return this.handle(cmd);
  }

  updates(): UpdateSecretVersionStageCommand[] {
    return this.calls.filter((c): c is UpdateSecretVersionStageCommand => c instanceof UpdateSecretVersionStageCommand);
  }
}

// 版とラベルの作り物。UpdateSecretVersionStage を受けると AWSCURRENT を移す（moves が偽なら移さない）
function stagesFake(initial: Record<string, string[]>, opts: { moves?: boolean } = {}): FakeSecrets {
  const fake = new FakeSecrets();
  const stages: Record<string, string[]> = structuredClone(initial);
  fake.handle = (cmd) => {
    if (cmd instanceof DescribeSecretCommand) return { VersionIdsToStages: structuredClone(stages) };
    if (cmd instanceof UpdateSecretVersionStageCommand && opts.moves !== false) {
      const { MoveToVersionId: to, RemoveFromVersionId: from, VersionStage: stage } = cmd.input;
      if (from !== undefined) stages[from] = (stages[from] ?? []).filter((s) => s !== stage);
      if (to !== undefined && stage !== undefined) stages[to] = [...(stages[to] ?? []), stage];
    }
    return {};
  };
  return fake;
}

async function caught(p: Promise<unknown>): Promise<Error> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!(e instanceof Error)) throw new Error("投げなかった");
  return e;
}

function expectNoSecret(e: Error): void {
  for (const text of [e.message, e.stack ?? "", String(e.cause ?? "")]) {
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(URL_VALUE);
  }
}

describe("readVersionPassword", () => {
  it("版の ID で読み、URL のパスワードを返す。ラベルを渡さない", async () => {
    const fake = new FakeSecrets();
    fake.handle = () => ({ SecretString: URL_VALUE, VersionId: VERSION });
    expect(await readVersionPassword(fake.asClient(), SECRET, VERSION)).toBe(PASSWORD);
    expect(fake.calls).toHaveLength(1);
    const cmd = fake.calls[0];
    expect(cmd).toBeInstanceOf(GetSecretValueCommand);
    expect(cmd?.input).toEqual({ SecretId: SECRET, VersionId: VERSION });
    expect(cmd?.input).not.toHaveProperty("VersionStage");
  });

  it("URL の中で符号化されたパスワードを戻して返す", async () => {
    const fake = new FakeSecrets();
    fake.handle = () => ({ SecretString: "postgresql://acme_role_aaaaaaaa:acme%2Fpw%40x@example.com:5432/acme_db_aaaaaaaa" });
    expect(await readVersionPassword(fake.asClient(), SECRET, VERSION)).toBe("acme/pw@x");
  });

  it("版が無ければ投げる", async () => {
    const fake = new FakeSecrets();
    fake.handle = () => {
      throw new ResourceNotFoundException({ message: "Secrets Manager can't find the specified secret value", $metadata: {} });
    };
    const e = await caught(readVersionPassword(fake.asClient(), SECRET, VERSION));
    expect(e.name).toBe("ResourceNotFoundException");
  });

  it("値が無い・URL の形でない・URL にパスワードが無い・パスワードを戻せないと投げ、例外の文にパスワードと URL が現れない", async () => {
    const values: Array<string | undefined> = [
      undefined,
      `acme ${PASSWORD} not a url`,
      "postgresql://acme_role_aaaaaaaa@example.com:5432/acme_db_aaaaaaaa",
      `postgresql://acme_role_aaaaaaaa:${PASSWORD}%E0%A4%A@example.com:5432/acme_db_aaaaaaaa`,
    ];
    for (const value of values) {
      const fake = new FakeSecrets();
      fake.handle = () => (value === undefined ? { SecretBinary: new Uint8Array([1]) } : { SecretString: value });
      const e = await caught(readVersionPassword(fake.asClient(), SECRET, VERSION));
      expectNoSecret(e);
    }
  });
});

describe("promoteVersion", () => {
  it("AWSCURRENT の付かない版へ、今の版から移し、読み直す", async () => {
    const fake = stagesFake({ [OLD_VERSION]: ["AWSCURRENT"], [VERSION]: ["AWSPENDING"] });
    await promoteVersion(fake.asClient(), SECRET, VERSION);
    expect(fake.calls.map((c) => c.constructor.name)).toEqual([
      "DescribeSecretCommand",
      "UpdateSecretVersionStageCommand",
      "DescribeSecretCommand",
    ]);
    expect(fake.calls[0]?.input).toEqual({ SecretId: SECRET });
    expect(fake.updates()[0]?.input).toEqual({
      SecretId: SECRET,
      VersionStage: "AWSCURRENT",
      MoveToVersionId: VERSION,
      RemoveFromVersionId: OLD_VERSION,
    });
  });

  it("どの版にも AWSCURRENT が付いていなければ、外す版を渡さずに移す", async () => {
    const fake = stagesFake({ [VERSION]: ["AWSPENDING"] });
    await promoteVersion(fake.asClient(), SECRET, VERSION);
    expect(fake.updates()[0]?.input).toEqual({ SecretId: SECRET, VersionStage: "AWSCURRENT", MoveToVersionId: VERSION });
  });

  it("既に付いていれば UpdateSecretVersionStage を呼ばない（中断からの再開）", async () => {
    const fake = stagesFake({ [OLD_VERSION]: [], [VERSION]: ["AWSCURRENT", "AWSPENDING"] });
    await promoteVersion(fake.asClient(), SECRET, VERSION);
    expect(fake.updates()).toHaveLength(0);
    expect(fake.calls).toHaveLength(1);
  });

  it("読み直しが期限まで付いていないままなら、移しを打ち直さずに投げる", async () => {
    const fake = stagesFake({ [OLD_VERSION]: ["AWSCURRENT"], [VERSION]: ["AWSPENDING"] }, { moves: false });
    let t = 0;
    const waits: number[] = [];
    const options = {
      now: () => t,
      sleep: async (ms: number) => {
        waits.push(ms);
        t += ms;
      },
    };
    await expect(promoteVersion(fake.asClient(), SECRET, VERSION, options)).rejects.toThrow("AWSCURRENT を移せなかった");
    expect(fake.updates()).toHaveLength(1);
    // 既定の期限 20 秒まで、250 ms から 2 秒まで倍にして読み直し、期限を越えて待たない
    expect(t).toBe(20_000);
    expect(waits.slice(0, 5)).toEqual([250, 500, 1_000, 2_000, 2_000]);
    expect(fake.calls.at(-1)).toBeInstanceOf(DescribeSecretCommand);
  });

  it("移した直後の読みが移す前を返しても（結果整合）、移しを打ち直さずに読み直して確かめる", async () => {
    const fake = stagesFake({ [OLD_VERSION]: ["AWSCURRENT"], [VERSION]: ["AWSPENDING"] });
    const inner = fake.handle;
    let describes = 0;
    fake.handle = (cmd) => {
      // 移した後の 1・2 回目の読みは、移す前の状態を返す
      if (cmd instanceof DescribeSecretCommand && (describes += 1) > 1 && describes <= 3) {
        return { VersionIdsToStages: { [OLD_VERSION]: ["AWSCURRENT"], [VERSION]: ["AWSPENDING"] } };
      }
      return inner(cmd);
    };
    const waits: number[] = [];
    await promoteVersion(fake.asClient(), SECRET, VERSION, { now: () => 0, sleep: async (ms) => void waits.push(ms) });
    expect(fake.updates()).toHaveLength(1);
    expect(describes).toBe(4);
    expect(waits).toEqual([250, 500]);
  });

  it("期限は最初の読みの前に決め、どの送信も期限までの残りで打ち切る", async () => {
    const fake = stagesFake({ [OLD_VERSION]: ["AWSCURRENT"], [VERSION]: ["AWSPENDING"] });
    let t = 1_000;
    const inner = fake.handle;
    // 送るたびに 3 秒かかる
    fake.handle = (cmd) => {
      t += 3_000;
      return inner(cmd);
    };
    const lefts: number[] = [];
    await promoteVersion(fake.asClient(), SECRET, VERSION, {
      now: () => t,
      sleep: async (ms) => void (t += ms),
      abortAfter: (ms) => {
        lefts.push(ms);
        return new AbortController().signal;
      },
    });
    expect(lefts).toEqual([20_000, 17_000, 14_000]);
    expect(fake.signals.every((x) => x instanceof AbortSignal)).toBe(true);
  });

  it("最初の読みが期限を越えて遅れたら、移しを送らずに投げる（鎖が外れた後に古い版へ戻さない）", async () => {
    const fake = stagesFake({ [OLD_VERSION]: ["AWSCURRENT"], [VERSION]: ["AWSPENDING"] });
    let t = 0;
    const inner = fake.handle;
    fake.handle = (cmd) => {
      if (cmd instanceof DescribeSecretCommand) t += 25_000;
      return inner(cmd);
    };
    const e = await caught(promoteVersion(fake.asClient(), SECRET, VERSION, { now: () => t, sleep: async () => undefined }));
    expect(e.name).toBe("PromoteDeadlineError");
    expect(fake.updates()).toHaveLength(0);
    expect(fake.calls).toHaveLength(1);
  });

  it("移しの後の読み直しの途中で期限を過ぎたら、次の読みを送らずに投げる", async () => {
    const fake = stagesFake({ [OLD_VERSION]: ["AWSCURRENT"], [VERSION]: ["AWSPENDING"] }, { moves: false });
    let t = 0;
    const inner = fake.handle;
    fake.handle = (cmd) => {
      if (cmd instanceof UpdateSecretVersionStageCommand) t += 19_900;
      return inner(cmd);
    };
    // 読み直しは 1 回送り、待ちで期限に届いた後は送らない
    await expect(promoteVersion(fake.asClient(), SECRET, VERSION, { now: () => t, sleep: async (ms) => void (t += ms) })).rejects.toThrow();
    expect(fake.updates()).toHaveLength(1);
    expect(fake.calls.filter((c) => c instanceof DescribeSecretCommand)).toHaveLength(2);
  });

  it("送った要求が期限で打ち切られたら（SDK が AbortError で落とす）、そのまま投げる", async () => {
    const fake = stagesFake({ [OLD_VERSION]: ["AWSCURRENT"], [VERSION]: ["AWSPENDING"] });
    const inner = fake.handle;
    fake.handle = (cmd) => {
      if (cmd instanceof UpdateSecretVersionStageCommand) {
        const e = new Error("Request aborted");
        e.name = "AbortError";
        throw e;
      }
      return inner(cmd);
    };
    const e = await caught(promoteVersion(fake.asClient(), SECRET, VERSION));
    expect(e.name).toBe("AbortError");
    expect(fake.calls.filter((c) => c instanceof DescribeSecretCommand)).toHaveLength(1);
  });

  it("移しが投げれば、そのまま投げる", async () => {
    const fake = stagesFake({ [OLD_VERSION]: ["AWSCURRENT"] });
    const inner = fake.handle;
    fake.handle = (cmd) => {
      if (cmd instanceof UpdateSecretVersionStageCommand) throw new Error("権限が無い");
      return inner(cmd);
    };
    await expect(promoteVersion(fake.asClient(), SECRET, VERSION)).rejects.toThrow("権限が無い");
    expect(fake.calls).toHaveLength(2);
  });
});
