import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restrictBootstrapTemplate } from "../lib/app-bootstrap-template.ts";
import type { GuardConfig } from "../lib/assembly-check.ts";
import {
  type AwsCli,
  checkBootstrapVersion,
  checkExecutionRole,
  checkPolicyDocuments,
  checkSettings,
  checkSimulations,
  checkTemplateObject,
  checkTrigger,
  main as guardMain,
  runDeployGuard,
} from "../lib/deploy-guard.ts";
import { BUCKET, GUARD, type Manifest, QUALIFIER, mutated, realAssembly, stackProps } from "./guard-support.ts";
import { TEST_ENV, matches, standardBootstrapTemplate } from "./support.ts";

type Statement = {
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};

// 生成した bootstrap の方針を、アクションと資源と条件で評価する小さなシミュレーター
function evaluate(statements: Statement[], action: string, resource: string, context: Record<string, string>): string {
  const applies = (s: Statement) => {
    const resources = typeof s.Resource === "string" ? [s.Resource] : Array.isArray(s.Resource) ? (s.Resource as string[]) : [];
    // Fn::Sub の資源（アプリ専用の実行のロール）は、その名前にだけ当たる
    const target = resources.length > 0 ? resources : [GUARD.appArns.executionRole];
    if (![s.Action].flat().some((a) => matches(a, action)) || !target.some((r) => matches(r, resource))) return false;
    return Object.entries(s.Condition ?? {}).every(([operator, entries]) =>
      Object.entries(entries).every(([key, value]) => {
        const found = context[key] !== undefined && [value].flat().includes(context[key]);
        return operator === "StringNotEquals" ? !found : found;
      }),
    );
  };
  const found = statements.filter(applies);
  if (found.some((s) => s.Effect === "Deny")) return "explicitDeny";
  return found.length > 0 ? "allowed" : "implicitDeny";
}

const BOOTSTRAP = JSON.parse(
  restrictBootstrapTemplate(standardBootstrapTemplate(), {
    ...TEST_ENV,
    partition: "aws",
    settings: { prefix: "acme", environment: "test" },
    directRoleArns: [],
  }),
) as { Resources: Record<string, { Properties: Record<string, unknown> }> };

const DEPLOY_ROLE_STATEMENTS = (
  BOOTSTRAP.Resources.DeploymentActionRole!.Properties.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }>
)[0]!.PolicyDocument.Statement;
const EXECUTION_STATEMENTS = (BOOTSTRAP.Resources.NdExecutionPolicy!.Properties.PolicyDocument as { Statement: Statement[] })
  .Statement;

const SETTINGS_VALUE = '{\n  "prefix": "acme",\n  "environment": "test"\n}\n';
const SETTINGS_SHA = createHash("sha256").update(SETTINGS_VALUE, "utf8").digest("hex");

type Reply = { status: number; stdout: string; stderr: string };
const ok = (value: unknown): Reply => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
const fail = (code: string): Reply => ({ status: 254, stdout: "", stderr: `An error occurred (${code}) when calling: 作り物` });

type Call = { args: string[]; env: Record<string, string> | undefined };
type Query = { role: string; action: string; resource: string; roleArn: string | undefined };
type World = {
  trigger?: string;
  value?: string;
  version?: number;
  settings?: Reply;
  record?: Reply;
  attached?: string[];
  inline?: string[];
  // 管理ポリシーのデフォルトのバージョンの本文の差し替え
  documents?: Record<string, unknown>;
  decide?: (query: Query) => string | undefined;
  bootstrap?: Reply;
  assume?: Reply;
  object?: string | Reply;
  put?: Reply;
};

const option = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

// 期待どおりの AWS を偽る。実効の権限は、生成した bootstrap の方針で評価する
function fakeAws(world: World = {}) {
  const calls: Call[] = [];
  let stored = world.object;
  const aws: AwsCli = async (args, env) => {
    calls.push({ args, env });
    const command = `${args[0]} ${args[1]}`;
    switch (command) {
      case "codepipeline get-pipeline-execution":
        return ok({ pipelineExecution: { trigger: world.trigger === "" ? {} : { triggerType: world.trigger ?? "WebhookV2" } } });
      case "ssm get-parameter": {
        const name = option(args, "--name")!;
        if (name === GUARD.recordParameter) return world.record ?? fail("ParameterNotFound");
        if (name.startsWith("/cdk-bootstrap/")) return world.bootstrap ?? ok({ Parameter: { Value: "33" } });
        return world.settings ?? ok({ Parameter: { Value: world.value ?? SETTINGS_VALUE, Version: world.version ?? 3 } });
      }
      case "iam list-attached-role-policies":
        return ok({ AttachedPolicies: (world.attached ?? [GUARD.appArns.executionPolicy]).map((PolicyArn) => ({ PolicyArn })) });
      case "iam list-role-policies":
        return ok({ PolicyNames: world.inline ?? [] });
      case "iam get-policy":
        return ok({ Policy: { DefaultVersionId: "v1" } });
      case "iam get-policy-version": {
        const arn = option(args, "--policy-arn")!;
        const resource = arn === GUARD.appArns.executionPolicy ? "NdExecutionPolicy" : "NdAppBoundary";
        const Document = world.documents?.[arn] ?? BOOTSTRAP.Resources[resource]!.Properties.PolicyDocument;
        return ok({ PolicyVersion: { Document } });
      }
      case "iam simulate-principal-policy": {
        const role = option(args, "--policy-source-arn")!;
        const entry = option(args, "--context-entries");
        const query = {
          role,
          action: option(args, "--action-names")!,
          resource: option(args, "--resource-arns")!,
          roleArn: entry ? /ContextKeyValues=([^,]+)/.exec(entry)![1] : undefined,
        };
        const statements = role === GUARD.appArns.deployRole ? DEPLOY_ROLE_STATEMENTS : EXECUTION_STATEMENTS;
        const context: Record<string, string> = query.roleArn ? { "cloudformation:RoleArn": query.roleArn } : {};
        const decision = world.decide?.(query) ?? evaluate(statements, query.action, query.resource, context);
        return ok({ EvaluationResults: [{ EvalDecision: decision }] });
      }
      case "sts assume-role":
        return world.assume ?? ok({ Credentials: { AccessKeyId: "id", SecretAccessKey: "secret", SessionToken: "token" } });
      case "s3api get-object": {
        if (stored === undefined) return fail("NoSuchKey");
        if (typeof stored !== "string") return stored;
        writeFileSync(args[args.indexOf("--output") - 1]!, stored);
        return ok({});
      }
      case "s3api put-object": {
        if (world.put) return world.put;
        stored = readFileSync(option(args, "--body")!, "utf8");
        return ok({});
      }
      default:
        return fail("UnknownCommand");
    }
  };
  const commands = () => calls.map((c) => `${c.args[0]} ${c.args[1]}`);
  return { aws, calls, commands };
}

const GUARD_ENV = {
  ND_GUARD_CONFIG: JSON.stringify(GUARD),
  PIPELINE_EXECUTION_ID: "00000000-0000-0000-0000-210987654321",
  SETTINGS_VERSION: "3",
  SETTINGS_SHA256: SETTINGS_SHA,
};

const templateText = () => readFileSync(join(realAssembly(), "acme-test-app.template.json"), "utf8");

describe("runDeployGuard", () => {
  beforeEach(() => void vi.spyOn(console, "log").mockImplementation(() => {}));
  afterEach(() => void vi.restoreAllMocks());

  it("すべて通れば正常に返り、通った検査を記録に出し、設定の値と資格情報は出さない", async () => {
    const fake = fakeAws({ object: templateText() });
    await expect(runDeployGuard(realAssembly(), GUARD_ENV, fake.aws)).resolves.toBeUndefined();
    const log = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(log).toContain("段階 human");
    expect(log).toContain("設定の版 3");
    expect(log).not.toContain("prefix");
    expect(log).not.toContain("secret");
    expect(fake.commands()).not.toContain("s3api put-object");
  });

  it.each(["ND_GUARD_CONFIG", "PIPELINE_EXECUTION_ID", "SETTINGS_VERSION", "SETTINGS_SHA256"])(
    "%s が無ければ AWS を呼ばずに止まる",
    async (name) => {
      const fake = fakeAws();
      await expect(runDeployGuard(realAssembly(), { ...GUARD_ENV, [name]: "" }, fake.aws)).rejects.toThrow(name);
      expect(fake.calls).toEqual([]);
    },
  );

  it("ND_GUARD_CONFIG を解析できなければ止まる", async () => {
    await expect(runDeployGuard(realAssembly(), { ...GUARD_ENV, ND_GUARD_CONFIG: "{" }, fakeAws().aws)).rejects.toThrow(
      /ND_GUARD_CONFIG/,
    );
  });

  const declared = JSON.stringify({ launch_declared: true, environment_kind: "production" });
  const development = JSON.stringify({ launch_declared: false, environment_kind: "development" });
  const withValue = (value: string) => ({ ...GUARD_ENV, SETTINGS_SHA256: createHash("sha256").update(value).digest("hex") });

  it.each([
    ["始まり方", { trigger: "StartPipelineExecution" }, GUARD_ENV, "ssm get-parameter"],
    ["設定の版", { version: 4 }, GUARD_ENV, "iam list-attached-role-policies"],
    ["宣言した本番", { value: declared }, withValue(declared), "iam list-attached-role-policies"],
    ["宣言の記録", { record: ok({ Parameter: { Value: "x" } }) }, GUARD_ENV, "iam list-attached-role-policies"],
    ["読めない宣言の記録", { record: fail("AccessDeniedException") }, GUARD_ENV, "iam list-attached-role-policies"],
    ["段階の値（ai を期待して未設定）", { value: development }, withValue(development), "iam list-attached-role-policies"],
    ["実行のロール", { attached: [] }, GUARD_ENV, "iam simulate-principal-policy"],
    ["実効の権限", { decide: () => "allowed" }, GUARD_ENV, "sts assume-role"],
    ["bootstrap の版", { bootstrap: ok({ Parameter: { Value: "1" } }) }, GUARD_ENV, "s3api get-object"],
    ["テンプレートの中身", { object: "{}" }, GUARD_ENV, "s3api put-object"],
  ] as Array<[string, World, Record<string, string>, string]>)(
    "%sの検査に失敗すれば止まり、後の検査を打たない",
    async (_name, world, env, later) => {
      const fake = fakeAws(world);
      await expect(runDeployGuard(realAssembly(), env, fake.aws)).rejects.toThrow();
      expect(fake.commands()).not.toContain(later);
    },
  );

  it("合成の結果の形が違えば、実効の権限の検査へ進まない", async () => {
    const dir = mutated<Manifest>("manifest.json", (m) => (stackProps(m).stackName = "acme-test-pipeline"));
    const fake = fakeAws();
    await expect(runDeployGuard(dir, GUARD_ENV, fake.aws)).rejects.toThrow(/アプリのスタックでない/);
    expect(fake.commands()).not.toContain("iam list-attached-role-policies");
  });

  it("main は、失敗すれば理由の 1 行を出して終了コード 1 にする", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const argv = process.argv;
    const before = process.exitCode;
    for (const [key, value] of Object.entries(GUARD_ENV)) vi.stubEnv(key, value);
    try {
      process.argv = ["node", "guard", realAssembly()];
      await guardMain(fakeAws({ object: templateText() }).aws);
      expect(process.exitCode).toBe(before);
      await guardMain(fakeAws({ trigger: "CreatePipeline" }).aws);
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]![0]).toMatch(/^反映しない: .*CreatePipeline/);
    } finally {
      process.argv = argv;
      process.exitCode = before;
      vi.unstubAllEnvs();
    }
  });
});

describe("checkTrigger", () => {
  it("WebhookV2 だけを通す", async () => {
    await expect(checkTrigger(GUARD, "id", fakeAws().aws)).resolves.toBeUndefined();
  });

  it.each(["CreatePipeline", "StartPipelineExecution", "ManualRollback", "Webhook", ""])("%j は拒む", async (trigger) => {
    await expect(checkTrigger(GUARD, "id", fakeAws({ trigger }).aws)).rejects.toThrow(/push/);
  });
});

describe("checkSettings", () => {
  const expected = { version: "3", sha256: SETTINGS_SHA };

  it("版と値が一致し、記録が無ければ absent（末尾の改行も値のまま数える）", async () => {
    expect(await checkSettings(GUARD, expected, fakeAws().aws)).toEqual({
      settings: { prefix: "acme", environment: "test" },
      record: "absent",
    });
  });

  it.each([
    ["版だけが違う", { version: 4 }],
    ["値だけが違う", { value: SETTINGS_VALUE.trimEnd() }],
    ["読めない", { settings: fail("AccessDeniedException") }],
  ] as Array<[string, World]>)("%sと拒む", async (_name, world) => {
    await expect(checkSettings(GUARD, expected, fakeAws(world).aws)).rejects.toThrow();
  });

  it("JSON でない値は拒む", async () => {
    const sha256 = createHash("sha256").update("x").digest("hex");
    await expect(checkSettings(GUARD, { version: "3", sha256 }, fakeAws({ value: "x" }).aws)).rejects.toThrow(/JSON/);
  });
});

describe("checkExecutionRole", () => {
  const admin = "arn:aws:iam::aws:policy/AdministratorAccess";

  it("アプリ専用の管理ポリシー 1 つだけなら通る", async () => {
    await expect(checkExecutionRole(GUARD, fakeAws().aws)).resolves.toBeUndefined();
  });

  it.each([
    ["AdministratorAccess の追加", { attached: [GUARD.appArns.executionPolicy, admin] }],
    ["AdministratorAccess への置き換え", { attached: [admin] }],
    ["インラインポリシー", { inline: ["extra"] }],
  ] as Array<[string, World]>)("%sは拒む", async (_name, world) => {
    await expect(checkExecutionRole(GUARD, fakeAws(world).aws)).rejects.toThrow(/実行のロール/);
  });
});

describe("checkPolicyDocuments", () => {
  it("bootstrap のテンプレートの本文なら通る", async () => {
    await expect(checkPolicyDocuments(GUARD, fakeAws().aws)).resolves.toBeUndefined();
  });

  const widened = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] };
  it.each([
    ["実行の管理ポリシー", GUARD.appArns.executionPolicy],
    ["権限の境界", GUARD.appArns.boundaryPolicy],
  ])("%sの本文が違えば、ARN を出さずに拒む", async (what, arn) => {
    const error = await checkPolicyDocuments(GUARD, fakeAws({ documents: { [arn]: widened } }).aws).catch((e: Error) => e);
    expect((error as Error).message).toBe(`${what}の本文が、承認したものと違う`);
  });
});

describe("checkSimulations", () => {
  const appStack = (q: Query) => q.resource.includes("stack/acme-test-app/");
  const when = (condition: (q: Query) => boolean, decision: string) => (q: Query) => (condition(q) ? decision : undefined);

  it("生成した bootstrap の方針は、期待の表のとおりになる", async () => {
    const fake = fakeAws();
    await expect(checkSimulations(GUARD, fake.aws)).resolves.toBeUndefined();
    const executed = fake.calls.filter((c) => option(c.args, "--action-names") === "cloudformation:ExecuteChangeSet");
    expect(executed).toHaveLength(4);
    for (const c of executed) expect(c.args).not.toContain("--context-entries");
    const updates = fake.calls.filter(
      (c) =>
        option(c.args, "--policy-source-arn") === GUARD.appArns.deployRole &&
        option(c.args, "--action-names") === "cloudformation:UpdateStack",
    );
    expect(updates.filter((c) => c.args.includes("--context-entries"))).toHaveLength(4);
    expect(updates.filter((c) => !c.args.includes("--context-entries"))).toHaveLength(4);
    const targets = updates.map((c) => option(c.args, "--resource-arns")!.split("/")[1]);
    expect(new Set(targets)).toEqual(new Set(["acme-test-app", "acme-test-pipeline", "acme-nd-other-app", "nd-other-test-app"]));
  });

  it.each([
    [
      "値を渡した対象のアプリの UpdateStack が拒否",
      when((q) => q.action === "cloudformation:UpdateStack" && appStack(q) && q.roleArn !== undefined, "implicitDeny"),
    ],
    [
      "値を渡さない対象のアプリの UpdateStack が許可",
      when((q) => q.action === "cloudformation:UpdateStack" && appStack(q) && q.roleArn === undefined, "allowed"),
    ],
    ["対象のアプリの ExecuteChangeSet が拒否", when((q) => q.action === "cloudformation:ExecuteChangeSet" && appStack(q), "implicitDeny")],
    ["パイプラインが許可", when((q) => q.resource.includes("stack/acme-test-pipeline/"), "allowed")],
    ["別の設置が許可", when((q) => q.resource.includes("stack/nd-other-test-app/"), "allowed")],
    ["既定の実行のロールの PassRole が許可", when((q) => q.action === "iam:PassRole" && q.resource.includes("hnb659fds"), "allowed")],
    ["実行のロールの設定の書き込みが許可", when((q) => q.action === "ssm:PutParameter", "allowed")],
    ["判定が無い", () => ""],
  ] as Array<[string, (q: Query) => string | undefined]>)("%sと拒む", async (_name, decide) => {
    await expect(checkSimulations(GUARD, fakeAws({ decide }).aws)).rejects.toThrow();
  });

  it("失敗の理由は操作とケースを示し、アカウント ID と ARN を出さない", async () => {
    const decide = when((q) => q.action === "ssm:PutParameter", "allowed");
    const error = await checkSimulations(GUARD, fakeAws({ decide }).aws).catch((e: Error) => e);
    const { message } = error as Error;
    expect(message).toMatch(/ケース \d+（実行のロールから設定のパラメーター）の ssm:PutParameter/);
    expect(message).not.toContain("123456789012");
    expect(message).not.toContain("arn:");
  });
});

// 期待の表の全部のケースを、打つ順に固定する。失敗の理由の番号は、この順の 1 始まり
type Row = [role: string, action: string, resource: string, roleArn: string | undefined, label: string, want: "許可" | "拒否"];

function expectedTable(config: GuardConfig, otherQualifier: string): Row[] {
  const { executionRole, deployRole, boundaryPolicy, executionPolicy } = config.appArns;
  const at = (service: string, resource: string, region = "us-west-2") => `arn:aws:${service}:${region}:123456789012:${resource}`;
  const iam = (resource: string) => at("iam", resource, "");
  const stack = (name: string) => at("cloudformation", `stack/${name}/nd-guard`);

  const stacks: Array<[name: string, label: string]> = [
    ["my-acme-test-app", "アプリのスタック"],
    ["acme-test-pipeline", "パイプラインのスタック"],
    ["my-acme-nd-other-app", "環境が違う別の設置のスタック"],
    ["nd-other-test-app", "接頭辞が違う別の設置のスタック"],
  ];
  const writes: Array<[action: string, roleArn: string | undefined, app: "許可" | "拒否"]> = [
    ["UpdateStack", executionRole, "許可"],
    ["CreateChangeSet", executionRole, "許可"],
    ["UpdateStack", undefined, "拒否"],
    ["CreateChangeSet", undefined, "拒否"],
    ["ExecuteChangeSet", undefined, "許可"],
    ["DeleteStack", executionRole, "許可"],
    ["DeleteStack", undefined, "許可"],
  ];
  const stackRows = writes.flatMap(([action, roleArn, app]) =>
    stacks.map(([name, label], i): Row => [
      deployRole,
      `cloudformation:${action}`,
      stack(name),
      roleArn,
      `反映のロールから${label}`,
      i === 0 ? app : "拒否",
    ]),
  );

  const passRole = (qualifier: string, label: string): Row => [
    deployRole,
    "iam:PassRole",
    iam(`role/cdk-${qualifier}-cfn-exec-role-123456789012-us-west-2`),
    undefined,
    `反映のロールから${label}`,
    "拒否",
  ];

  const deployProjectRole = iam("role/acme-test-deploy-us-west-2");
  const pipelineStackRole = iam("role/acme-test-pipeline-nd-guard");
  const appRole = iam("role/my-acme-test-app-nd-guard");
  const record = at("ssm", "parameter/acme/test/launch-declared");
  const denied: Array<[action: string, resource: string, label: string]> = [
    ["cloudformation:UpdateStack", stack("acme-test-pipeline"), "パイプラインのスタック"],
    ["iam:UpdateAssumeRolePolicy", deployProjectRole, "反映のプロジェクトのロール"],
    ["iam:PutRolePolicy", deployProjectRole, "反映のプロジェクトのロール"],
    ["iam:AttachRolePolicy", deployProjectRole, "反映のプロジェクトのロール"],
    ["iam:UpdateAssumeRolePolicy", pipelineStackRole, "パイプラインのスタックのロール"],
    ["iam:PutRolePolicy", pipelineStackRole, "パイプラインのスタックのロール"],
    ["iam:AttachRolePolicy", pipelineStackRole, "パイプラインのスタックのロール"],
    ["codepipeline:UpdatePipeline", at("codepipeline", "acme-test-pipeline"), "パイプライン"],
    ["ssm:PutParameter", at("ssm", "parameter/acme/test/settings"), "設定のパラメーター"],
    ["ssm:PutParameter", record, "宣言の記録"],
    ["ssm:DeleteParameter", record, "宣言の記録"],
    ["iam:CreateRole", appRole, "境界を指定しないアプリのロール"],
    ["iam:DeleteRolePermissionsBoundary", appRole, "アプリのロール"],
    ["iam:CreatePolicyVersion", boundaryPolicy, "権限の境界"],
    ["iam:CreatePolicyVersion", executionPolicy, "実行の管理ポリシー"],
  ];

  return [
    ...stackRows,
    passRole("hnb659fds", "既定の qualifier の実行のロール"),
    passRole(otherQualifier, "別の設置の実行のロール"),
    ...denied.map(([action, resource, label]): Row => [executionRole, action, resource, undefined, `実行のロールから${label}`, "拒否"]),
  ];
}

describe("checkSimulations の期待の表", () => {
  // 接頭辞がハイフンを持つ設置。environment は最後のハイフンの後ろ
  const config: GuardConfig = { ...GUARD, appStack: "my-acme-test-app" };

  // ケースの順に判定を返す。flipped の番目だけ、期待と逆の判定にする
  const answering = (table: Row[], flipped?: number) => {
    const calls: string[][] = [];
    const aws: AwsCli = async (args) => {
      const index = calls.push(args) - 1;
      const allowed = (table[index]![5] === "許可") !== (index === flipped);
      return ok({ EvaluationResults: [{ EvalDecision: allowed ? "allowed" : "implicitDeny" }] });
    };
    return { aws, calls };
  };

  const argsOf = ([role, action, resource, roleArn]: Row) => [
    "iam",
    "simulate-principal-policy",
    "--policy-source-arn",
    role,
    "--action-names",
    action,
    "--resource-arns",
    resource,
    ...(roleArn
      ? ["--context-entries", `ContextKeyName=cloudformation:RoleArn,ContextKeyValues=${roleArn},ContextKeyType=string`]
      : []),
    "--output",
    "json",
  ];

  it.each([
    [QUALIFIER, "nd00000000"],
    ["nd00000000", "nd00000001"],
  ])("qualifier が %s なら、別の設置は %s として、全部のケースをこの順で打つ", async (qualifier, otherQualifier) => {
    const table = expectedTable(config, otherQualifier);
    const fake = answering(table);
    await expect(checkSimulations({ ...config, qualifier }, fake.aws)).resolves.toBeUndefined();
    expect(table).toHaveLength(45);
    expect(fake.calls).toEqual(table.map(argsOf));
  });

  it("どのケースも、期待と逆の判定なら、番号・名前・期待を示してそこで止まる", async () => {
    const table = expectedTable(config, "nd00000000");
    for (const [index, [, action, , roleArn, label, want]] of table.entries()) {
      const fake = answering(table, index);
      const error = await checkSimulations(config, fake.aws).catch((e: Error) => e);
      const got = want === "許可" ? "implicitDeny" : "allowed";
      expect((error as Error).message).toBe(
        `実効の権限が期待と違う: ケース ${index + 1}（${label}）の ${action}（RoleArn ${roleArn ? "あり" : "なし"}）は${want}のはずが ${got}`,
      );
      expect(fake.calls).toHaveLength(index + 1);
    }
  });
});

describe("checkBootstrapVersion", () => {
  const version = (value: string) => ({ bootstrap: ok({ Parameter: { Value: value } }) });

  it.each(["6", "7"])("版 %s は求める版 6 に足り、引き受けた資格情報で読む", async (value) => {
    const fake = fakeAws(version(value));
    await expect(checkBootstrapVersion(GUARD, 6, fake.aws)).resolves.toBeUndefined();
    expect(option(fake.calls[0]!.args, "--role-arn")).toBe(GUARD.appArns.deployRole);
    expect(fake.calls[0]!.env).toBeUndefined();
    expect(fake.calls[1]!.env).toMatchObject({ AWS_SESSION_TOKEN: "token" });
  });

  it.each([
    ["足りない", version("5")],
    ["数でない", version("x")],
    ["無い", { bootstrap: fail("ParameterNotFound") }],
    ["引き受けられない", { assume: fail("AccessDenied") }],
  ] as Array<[string, World]>)("%sと拒む", async (_name, world) => {
    await expect(checkBootstrapVersion(GUARD, 6, fakeAws(world).aws)).rejects.toThrow();
  });
});

describe("checkTemplateObject", () => {
  const template = () => ({ file: join(realAssembly(), "acme-test-app.template.json"), key: "template.json" });

  it("同じ中身なら、ファイルの公開のロールで読んで通る", async () => {
    const fake = fakeAws({ object: templateText() });
    await expect(checkTemplateObject(GUARD, template(), fake.aws)).resolves.toBeUndefined();
    expect(fake.commands()).toEqual(["sts assume-role", "s3api get-object"]);
    expect(option(fake.calls[0]!.args, "--role-arn")).toBe(GUARD.appArns.filePublishingRole);
    expect(option(fake.calls[1]!.args, "--bucket")).toBe(BUCKET);
  });

  it("オブジェクトが無ければ、置いて読み直す", async () => {
    const fake = fakeAws();
    await expect(checkTemplateObject(GUARD, template(), fake.aws)).resolves.toBeUndefined();
    expect(fake.commands()).toEqual(["sts assume-role", "s3api get-object", "s3api put-object", "s3api get-object"]);
  });

  it.each([
    ["違う中身", { object: "{}" }],
    ["読めない", { object: fail("AccessDenied") }],
    ["置けない", { put: fail("AccessDenied") }],
    ["引き受けられない", { assume: fail("AccessDenied") }],
  ] as Array<[string, World]>)("%sと拒む", async (_name, world) => {
    await expect(checkTemplateObject(GUARD, template(), fakeAws(world).aws)).rejects.toThrow();
  });
});
