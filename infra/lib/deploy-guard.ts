import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GuardConfig,
  checkAssembly,
  checkTemplateRoles,
  checkTemplateStage,
  checkTemplateTransforms,
  policyDigest,
} from "./assembly-check.ts";
import { type RecordState, confirmationStage, refusalReason } from "./confirmation-stage.ts";

// 反映の段で cdk deploy の直前に打つ検査。パイプラインのスタックの合成のときに束ねて反映の手順へ埋め込むので、
// 起点のブランチの変更からは変えられない。1 つでも満たさないか確かめられなければ反映しない。
// 反映の段に node_modules が無いため、node: の組み込みと AWS CLI だけを使う

export type AwsCli = (args: string[], env?: Record<string, string>) => Promise<{ status: number; stdout: string; stderr: string }>;

// 起点のブランチへの push のトリガーで始まった実行だけを反映する
const ALLOWED_TRIGGER = "WebhookV2";

type Decision = "allowed" | "denied";

// 反映のロールの CloudFormation の書き込みの期待。この設置のアプリのスタックの結果で、ほかのスタックは全部拒否
const STACK_SIMULATION_CASES: ReadonlyArray<{ actions: string[]; withRole: boolean; app: Decision }> = [
  { actions: ["UpdateStack", "CreateChangeSet"], withRole: true, app: "allowed" },
  { actions: ["UpdateStack", "CreateChangeSet"], withRole: false, app: "denied" },
  { actions: ["ExecuteChangeSet"], withRole: false, app: "allowed" },
  { actions: ["DeleteStack"], withRole: true, app: "allowed" },
  { actions: ["DeleteStack"], withRole: false, app: "allowed" },
];

// AWS CLI の失敗はエラーの種類だけを出す。応答の全文は記録へ出さない
function errorCode(stderr: string): string {
  return /\(([A-Za-z0-9.]+)\)/.exec(stderr)?.[1] ?? "不明なエラー";
}

async function awsJson<T>(aws: AwsCli, args: string[], env?: Record<string, string>): Promise<T> {
  const result = await aws([...args, "--output", "json"], env);
  const command = args.slice(0, 2).join(" ");
  if (result.status !== 0) throw new Error(`aws ${command} に失敗した（${errorCode(result.stderr)}）`);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`aws ${command} の応答を読めない`);
  }
}

export async function checkTrigger(config: GuardConfig, executionId: string, aws: AwsCli): Promise<void> {
  const response = await awsJson<{ pipelineExecution?: { trigger?: { triggerType?: string } } }>(aws, [
    "codepipeline",
    "get-pipeline-execution",
    "--pipeline-name",
    config.pipelineName,
    "--pipeline-execution-id",
    executionId,
    "--region",
    config.region,
  ]);
  const type = response.pipelineExecution?.trigger?.triggerType;
  if (type !== ALLOWED_TRIGGER) {
    throw new Error(`起点のブランチへの push で始まった実行でない（始まり方 ${type ?? "不明"}）`);
  }
}

type Parameter = { Parameter?: { Value?: string; Version?: number } };

const getParameter = (config: GuardConfig, name: string) => ["ssm", "get-parameter", "--name", name, "--region", config.region];

async function recordState(config: GuardConfig, aws: AwsCli): Promise<RecordState> {
  const result = await aws([...getParameter(config, config.recordParameter), "--output", "json"]);
  if (result.status === 0) return "present";
  return errorCode(result.stderr) === "ParameterNotFound" ? "absent" : "unreadable";
}

// 版と SHA-256 の両方を比べる。消して作り直すと版は 1 から数え直される
export async function checkSettings(
  config: GuardConfig,
  expected: { version: string; sha256: string },
  aws: AwsCli,
): Promise<{ settings: unknown; record: RecordState }> {
  const { Parameter: parameter } = await awsJson<Parameter>(aws, getParameter(config, config.settingsParameter));
  if (typeof parameter?.Value !== "string") throw new Error("設定のパラメーターの値が無い");
  if (String(parameter.Version) !== expected.version) throw new Error("設定のパラメーターの版が準備のものと違う");
  // 準備と同じく、改行を足さない UTF-8 の値で数える
  if (createHash("sha256").update(parameter.Value, "utf8").digest("hex") !== expected.sha256) {
    throw new Error("設定のパラメーターの値が準備のものと違う");
  }
  let settings: unknown;
  try {
    settings = JSON.parse(parameter.Value);
  } catch {
    throw new Error("設定のパラメーターの値を JSON として読めない");
  }
  return { settings, record: await recordState(config, aws) };
}

const nameOfRole = (arn: string) => arn.slice(arn.lastIndexOf("/") + 1);

export async function checkExecutionRole(config: GuardConfig, aws: AwsCli): Promise<void> {
  const role = ["--role-name", nameOfRole(config.appArns.executionRole)];
  const attached = await awsJson<{ AttachedPolicies?: Array<{ PolicyArn?: string }> }>(aws, [
    "iam",
    "list-attached-role-policies",
    ...role,
  ]);
  const arns = (attached.AttachedPolicies ?? []).map((p) => p.PolicyArn);
  if (arns.length !== 1 || arns[0] !== config.appArns.executionPolicy) {
    throw new Error("実行のロールの管理ポリシーがアプリ専用の 1 つだけでない");
  }
  const inline = await awsJson<{ PolicyNames?: string[] }>(aws, ["iam", "list-role-policies", ...role]);
  if (inline.PolicyNames?.length !== 0) throw new Error("実行のロールにインラインポリシーがある");
}

// 同じ ARN のまま、デフォルトのバージョンを差し替えて権限を広げられるので、本文を承認した版と照らす
export async function checkPolicyDocuments(config: GuardConfig, aws: AwsCli): Promise<void> {
  const policies = [
    { what: "実行の管理ポリシー", arn: config.appArns.executionPolicy, digest: config.policyDigests.execution },
    { what: "権限の境界", arn: config.appArns.boundaryPolicy, digest: config.policyDigests.boundary },
  ];
  for (const { what, arn, digest } of policies) {
    const { Policy: policy } = await awsJson<{ Policy?: { DefaultVersionId?: string } }>(aws, ["iam", "get-policy", "--policy-arn", arn]);
    if (!policy?.DefaultVersionId) throw new Error(`${what}のデフォルトのバージョンが分からない`);
    const { PolicyVersion: version } = await awsJson<{ PolicyVersion?: { Document?: unknown } }>(aws, [
      "iam",
      "get-policy-version",
      "--policy-arn",
      arn,
      "--version-id",
      policy.DefaultVersionId,
    ]);
    if (policyDigest(version?.Document) !== digest) throw new Error(`${what}の本文が、承認したものと違う`);
  }
}

// label は失敗の記録に出す名前。ロールの名前と ARN はアカウント ID を含むので、記録へ出さない
type Simulation = { role: string; action: string; resource: string; label: string; expected: Decision; roleArn?: string };

const arnOf = ({ partition, account }: GuardConfig, service: string, resource: string, region: string) =>
  `arn:${partition}:${service}:${region}:${account}:${resource}`;
const iamArn = (config: GuardConfig, resource: string) => arnOf(config, "iam", resource, "");
const stackArn = (config: GuardConfig, name: string) => arnOf(config, "cloudformation", `stack/${name}/nd-guard`, config.region);

// 反映のロールの CloudFormation の書き込み。自分のアプリのスタックと、ほかのスタックを照らす
function deployRoleSimulations(config: GuardConfig): Simulation[] {
  const { appStack, appArns } = config;
  // アプリのスタックの名前は <prefix>-<environment>-app で、environment はハイフンを持たない
  const base = appStack.slice(0, -"-app".length);
  const prefix = base.slice(0, base.lastIndexOf("-"));
  const environment = base.slice(base.lastIndexOf("-") + 1);
  const stacks = [
    { name: appStack, label: "アプリのスタック" },
    { name: config.pipelineStack, label: "パイプラインのスタック" },
    { name: `${prefix}-nd-other-app`, label: "環境が違う別の設置のスタック" },
    { name: `nd-other-${environment}-app`, label: "接頭辞が違う別の設置のスタック" },
  ];

  return STACK_SIMULATION_CASES.flatMap((c) =>
    c.actions.flatMap((action) =>
      stacks.map(({ name, label }): Simulation => ({
        role: appArns.deployRole,
        action: `cloudformation:${action}`,
        resource: stackArn(config, name),
        label: `反映のロールから${label}`,
        expected: name === appStack ? c.app : "denied",
        ...(c.withRole ? { roleArn: appArns.executionRole } : {}),
      })),
    ),
  );
}

// 反映のロールから、この設置のものでない実行のロールは渡せない
function passRoleSimulations(config: GuardConfig): Simulation[] {
  const { region, account, appArns } = config;
  const otherQualifier = config.qualifier === "nd00000000" ? "nd00000001" : "nd00000000";
  return [
    { qualifier: "hnb659fds", label: "既定の qualifier の実行のロール" },
    { qualifier: otherQualifier, label: "別の設置の実行のロール" },
  ].map(({ qualifier, label }): Simulation => ({
    role: appArns.deployRole,
    action: "iam:PassRole",
    resource: iamArn(config, `role/cdk-${qualifier}-cfn-exec-role-${account}-${region}`),
    label: `反映のロールから${label}`,
    expected: "denied",
  }));
}

// 実行のロールから、検査の土台（パイプライン、設定、記録、方針）と境界は変えられない
function executionRoleSimulations(config: GuardConfig): Simulation[] {
  const { region, appStack, appArns } = config;
  const parameter = (name: string) => arnOf(config, "ssm", `parameter${name}`, region);
  const pipelineRoles = [
    { arn: iamArn(config, `role/${config.deployRoleName}`), label: "反映のプロジェクトのロール" },
    { arn: iamArn(config, `role/${config.pipelineStack}-nd-guard`), label: "パイプラインのスタックのロール" },
  ];
  const appRole = iamArn(config, `role/${appStack}-nd-guard`);
  const denied: Array<[action: string, resource: string, label: string]> = [
    ["cloudformation:UpdateStack", stackArn(config, config.pipelineStack), "パイプラインのスタック"],
    ...pipelineRoles.flatMap(({ arn: role, label }): Array<[string, string, string]> => [
      ["iam:UpdateAssumeRolePolicy", role, label],
      ["iam:PutRolePolicy", role, label],
      ["iam:AttachRolePolicy", role, label],
    ]),
    ["codepipeline:UpdatePipeline", arnOf(config, "codepipeline", config.pipelineName, region), "パイプライン"],
    ["ssm:PutParameter", parameter(config.settingsParameter), "設定のパラメーター"],
    ["ssm:PutParameter", parameter(config.recordParameter), "宣言の記録"],
    ["ssm:DeleteParameter", parameter(config.recordParameter), "宣言の記録"],
    // 境界を指定しない作成
    ["iam:CreateRole", appRole, "境界を指定しないアプリのロール"],
    ["iam:DeleteRolePermissionsBoundary", appRole, "アプリのロール"],
    ["iam:CreatePolicyVersion", appArns.boundaryPolicy, "権限の境界"],
    ["iam:CreatePolicyVersion", appArns.executionPolicy, "実行の管理ポリシー"],
  ];
  return denied.map(([action, resource, label]): Simulation => ({
    role: appArns.executionRole,
    action,
    resource,
    label: `実行のロールから${label}`,
    expected: "denied",
  }));
}

// 期待の表。「拒否」は判定が allowed でないこと。並びの順は失敗の記録のケースの番号になる
function simulations(config: GuardConfig): Simulation[] {
  return [...deployRoleSimulations(config), ...passRoleSimulations(config), ...executionRoleSimulations(config)];
}

export async function checkSimulations(config: GuardConfig, aws: AwsCli): Promise<void> {
  for (const [index, s] of simulations(config).entries()) {
    const context = s.roleArn
      ? ["--context-entries", `ContextKeyName=cloudformation:RoleArn,ContextKeyValues=${s.roleArn},ContextKeyType=string`]
      : [];
    const response = await awsJson<{ EvaluationResults?: Array<{ EvalDecision?: string }> }>(aws, [
      "iam",
      "simulate-principal-policy",
      "--policy-source-arn",
      s.role,
      "--action-names",
      s.action,
      "--resource-arns",
      s.resource,
      ...context,
    ]);
    const decision = response.EvaluationResults?.[0]?.EvalDecision;
    if (!decision) throw new Error(`${s.action} のシミュレーションの判定が無い`);
    if ((decision === "allowed") !== (s.expected === "allowed")) {
      const want = s.expected === "allowed" ? "許可" : "拒否";
      throw new Error(
        `実効の権限が期待と違う: ケース ${index + 1}（${s.label}）の ${s.action}（RoleArn ${s.roleArn ? "あり" : "なし"}）は${want}のはずが ${decision}`,
      );
    }
  }
}

// 引き受けた資格情報は、子プロセスの環境変数にだけ渡す
async function assume(config: GuardConfig, roleArn: string, what: string, aws: AwsCli): Promise<Record<string, string>> {
  const response = await awsJson<{ Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string } }>(aws, [
    "sts",
    "assume-role",
    "--role-arn",
    roleArn,
    "--role-session-name",
    "nd-deploy-guard",
    "--region",
    config.region,
  ]);
  const c = response.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error(`${what}を引き受けられない`);
  return { AWS_ACCESS_KEY_ID: c.AccessKeyId, AWS_SECRET_ACCESS_KEY: c.SecretAccessKey, AWS_SESSION_TOKEN: c.SessionToken };
}

// 版のパラメーターは反映のプロジェクトのロールで読めないので、反映のロールを引き受けて読む
export async function checkBootstrapVersion(config: GuardConfig, required: number, aws: AwsCli): Promise<void> {
  const env = await assume(config, config.appArns.deployRole, "反映のロール", aws);
  const { Parameter: parameter } = await awsJson<Parameter>(
    aws,
    getParameter(config, `/cdk-bootstrap/${config.qualifier}/version`),
    env,
  );
  const version = Number(parameter?.Value);
  if (!Number.isInteger(version)) throw new Error("アプリ専用の bootstrap の版が数でない");
  if (version < required) throw new Error(`アプリ専用の bootstrap の版 ${version} が、求める版 ${required} に足りない`);
}

const fileDigest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

// cdk deploy は同じキーのオブジェクトがあればアップロードを省くので、置かれた中身を照らす
export async function checkTemplateObject(config: GuardConfig, template: { file: string; key: string }, aws: AwsCli): Promise<void> {
  const env = await assume(config, config.appArns.filePublishingRole, "ファイルの公開のロール", aws);
  const object = [
    "--bucket",
    config.appArns.assetsBucket.split(":::")[1]!,
    "--key",
    template.key,
    "--expected-bucket-owner",
    config.account,
    "--region",
    config.region,
  ];
  const work = await mkdtemp(join(tmpdir(), "nd-guard-"));
  try {
    const copy = join(work, "template.json");
    const download = () => aws(["s3api", "get-object", ...object, copy, "--output", "json"], env);
    let result = await download();
    if (result.status !== 0 && errorCode(result.stderr) === "NoSuchKey") {
      await awsJson(aws, ["s3api", "put-object", ...object, "--body", template.file], env);
      result = await download();
    }
    if (result.status !== 0) throw new Error(`テンプレートのオブジェクトを読めない（${errorCode(result.stderr)}）`);
    if ((await fileDigest(copy)) !== (await fileDigest(template.file))) {
      throw new Error("S3 のテンプレートの中身が、検査したファイルと違う");
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`環境変数 ${name} が無い`);
  return value;
}

function guardConfigFrom(text: string): GuardConfig {
  try {
    return JSON.parse(text) as GuardConfig;
  } catch {
    throw new Error("ND_GUARD_CONFIG を解析できない");
  }
}

export async function runDeployGuard(dir: string, env: Record<string, string | undefined>, aws: AwsCli): Promise<void> {
  const config = guardConfigFrom(required(env, "ND_GUARD_CONFIG"));
  const executionId = required(env, "PIPELINE_EXECUTION_ID");
  const expected = { version: required(env, "SETTINGS_VERSION"), sha256: required(env, "SETTINGS_SHA256") };
  const passed = (what: string) => console.log(`検査を通った: ${what}`);

  await checkTrigger(config, executionId, aws);
  passed(`始まり方（${ALLOWED_TRIGGER}）`);
  const { settings, record } = await checkSettings(config, expected, aws);
  passed(`設定の版 ${expected.version} と値`);
  const refusal = refusalReason(settings, record);
  if (refusal) throw new Error(refusal);
  passed("宣言した本番でなく、宣言の記録が無い");

  const assembly = checkAssembly(dir, config);
  passed("合成の結果の形");
  const templateFile = join(dir, assembly.templateFile);
  const template: unknown = JSON.parse(await readFile(templateFile, "utf8"));
  const stage = confirmationStage(settings);
  const violations = [
    ...checkTemplateTransforms(template),
    ...checkTemplateStage(template, stage),
    ...checkTemplateRoles(template, config.appArns.boundaryPolicy),
  ];
  if (violations.length > 0) throw new Error(violations.join(" / "));
  passed(`段階 ${stage} と IAM のロール`);

  await checkExecutionRole(config, aws);
  await checkPolicyDocuments(config, aws);
  await checkSimulations(config, aws);
  passed("実行のロール、方針の本文、実効の権限");
  await checkBootstrapVersion(config, assembly.requiredBootstrapVersion, aws);
  passed("アプリ専用の bootstrap の版");
  await checkTemplateObject(config, { file: templateFile, key: assembly.templateKey }, aws);
  passed("S3 のテンプレートの中身");
}

// シェルを通さずに打つ
const awsCli: AwsCli = (args, env) =>
  new Promise((done) => {
    execFile("aws", args, { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      done({ status, stdout, stderr: stderr || (error?.message ?? "") });
    });
  });

export async function main(aws: AwsCli = awsCli): Promise<void> {
  try {
    const dir = process.argv[2];
    if (!dir) throw new Error("合成の結果の置き場の指定が無い");
    await runDeployGuard(dir, process.env, aws);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`反映しない: ${message.replace(/\s*\n\s*/g, " ")}`);
    process.exitCode = 1;
  }
}
