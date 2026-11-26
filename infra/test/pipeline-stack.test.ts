import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Settings } from "@nd-factory/contracts/settings";
import { App, Stack } from "aws-cdk-lib";
import type { BuildSpec } from "aws-cdk-lib/aws-codebuild";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { ASSEMBLY_DIGEST_SHELL } from "../lib/assembly-digest.ts";
import {
  PipelineStack,
  bundleDeployGuard,
  cdkCliVersion,
  deployBuildSpec,
  guardConfig,
  prepareBuildSpec,
} from "../lib/pipeline-stack.ts";
import { GUARD, QUALIFIER } from "./guard-support.ts";
import { PIPELINE_SETTINGS, TEST_ENV, hourlyCostResources, nameViolations, resources, untaggedResources } from "./support.ts";

type Built = { stack: PipelineStack; template: Template };

// BuildSpec は合成のときに文字列になるため、スタックで解いて読む
function specText(spec: BuildSpec): string {
  return new Stack().resolve(spec.toBuildSpec()) as string;
}

function build(s: Settings): Built {
  const stack = new PipelineStack(new App(), "acme-test-pipeline", { env: TEST_ENV, settings: s, appStackName: "acme-test-app" });
  return { stack, template: Template.fromStack(stack) };
}

type Stage = { Name: string; Actions: Array<Record<string, unknown>> };

function stages(template: Template): Stage[] {
  const p = Object.values(resources(template)).find((r) => r.Type === "AWS::CodePipeline::Pipeline");
  return (p?.Properties?.Stages ?? []) as Stage[];
}

function projectBuildSpec(template: Template, name: string): string {
  const p = Object.values(resources(template)).find((r) => r.Type === "AWS::CodeBuild::Project" && r.Properties?.Name === name);
  const source = p?.Properties?.Source as { BuildSpec: unknown };
  return typeof source.BuildSpec === "string" ? source.BuildSpec : JSON.stringify(source.BuildSpec);
}

function rolePolicyFor(template: Template, projectName: string): string {
  const all = resources(template);
  const project = Object.values(all).find((r) => r.Type === "AWS::CodeBuild::Project" && r.Properties?.Name === projectName);
  const roleRef = JSON.stringify(project?.Properties?.ServiceRole);
  const roleId = /"Fn::GetAtt":\["([^"]+)"/.exec(roleRef)?.[1];
  const policies = Object.values(all).filter(
    (r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties?.Roles).includes(`"${roleId}"`),
  );
  return JSON.stringify(policies.map((p) => p.Properties?.PolicyDocument));
}

describe("PipelineStack", () => {
  let built: Built;
  beforeAll(() => {
    built = build(PIPELINE_SETTINGS);
  });

  it("取る → 準備 → 反映 の順に段があり、承認の段を持たない", () => {
    const s = stages(built.template);
    expect(s.map((x) => x.Name)).toEqual(["Source", "Prepare", "Deploy"]);
    const owners = s.map((x) => (x.Actions[0]?.ActionTypeId as { Category: string }).Category);
    expect(owners).toEqual(["Source", "Build", "Build"]);
    for (const x of s) expect(x.Actions).toHaveLength(1);
  });

  it("V2 のパイプラインで、実行の扱いは SUPERSEDED", () => {
    built.template.hasResourceProperties("AWS::CodePipeline::Pipeline", {
      Name: "acme-test-pipeline",
      PipelineType: "V2",
      ExecutionMode: "SUPERSEDED",
    });
  });

  it("反映の入力は準備の出力だけで、準備の変数の名前空間は Prepare", () => {
    const s = stages(built.template);
    const prepare = s[1]!.Actions[0]!;
    const deploy = s[2]!.Actions[0]!;
    expect(prepare.Namespace).toBe("Prepare");
    const prepOut = (prepare.OutputArtifacts as Array<{ Name: string }>).map((a) => a.Name);
    const deployIn = (deploy.InputArtifacts as Array<{ Name: string }>).map((a) => a.Name);
    expect(prepOut).toHaveLength(1);
    expect(deployIn).toEqual(prepOut);
    expect(JSON.stringify(deploy.Configuration)).toContain("#{Prepare.ASSEMBLY_DIGEST}");
  });

  it("承認の段を持たず、準備の要約値をそのまま反映の段へ渡す（#164）", () => {
    const s = stages(built.template);
    expect(s.some((x) => x.Name === "Approve")).toBe(false);
    const deploy = s[2]!.Actions[0]! as { Configuration: Record<string, unknown> };
    expect(JSON.stringify(deploy.Configuration)).toContain("#{Prepare.ASSEMBLY_DIGEST}");
  });

  it("取る段は人が有効にする GitHub との接続で起点のブランチを取る", () => {
    built.template.hasResourceProperties("AWS::CodeStarConnections::Connection", {
      ConnectionName: "acme-test-github",
      ProviderType: "GitHub",
    });
    const source = stages(built.template)[0]!.Actions[0]! as { Configuration: Record<string, unknown> };
    expect(source.Configuration.FullRepositoryId).toBe("example-org/example-app");
    expect(source.Configuration.BranchName).toBe("main");
  });

  it("名前を持つ資源はすべて <prefix>-<environment>- で始まる", () => {
    expect(built.stack.stackName).toBe("acme-test-pipeline");
    expect(nameViolations(built.template, PIPELINE_SETTINGS)).toEqual([]);
  });

  it("すべての資源にタグが付き、時間で費用が掛かる資源が無い", () => {
    expect(untaggedResources(built.stack, PIPELINE_SETTINGS)).toEqual([]);
    expect(hourlyCostResources(built.template)).toEqual([]);
  });

  it("成果物の置き場は暗号化し 30 日で消す", () => {
    built.template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: Match.anyValue(),
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 30, Status: "Enabled" })]) },
    });
  });

  it("知らせの宛先にメールを購読させ、実行の失敗を知らせる", () => {
    built.template.hasResourceProperties("AWS::SNS::Topic", { TopicName: "acme-test-notify" });
    built.template.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "ops@example.com" });
    built.template.hasResourceProperties("AWS::Events::Rule", {
      Name: "acme-test-pipeline-failed",
      EventPattern: Match.objectLike({ detail: Match.objectLike({ state: ["FAILED"] }) }),
    });
  });

  it("設定のファイルの全文を SSM のパラメーターに持つ", () => {
    const param = Object.values(resources(built.template)).find((r) => r.Type === "AWS::SSM::Parameter");
    expect(param?.Properties?.Name).toBe("/acme/test/settings");
    expect(JSON.parse(param?.Properties?.Value as string)).toEqual(PIPELINE_SETTINGS);
  });

  it("承認の結果を拒む管理の方針を持たない（管理の方針を作らない）", () => {
    built.template.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
  });

  it("起点のブランチだけを含む push のトリガーを 1 つ持ち、ソースのアクションは変更を検知しない", () => {
    const pipeline = Object.values(resources(built.template)).find((r) => r.Type === "AWS::CodePipeline::Pipeline");
    expect(pipeline?.Properties?.Triggers).toEqual([
      {
        ProviderType: "CodeStarSourceConnection",
        GitConfiguration: { SourceActionName: "Source", Push: [{ Branches: { Includes: ["main"] } }] },
      },
    ]);
    const source = stages(built.template)[0]!.Actions[0]! as { Configuration: Record<string, unknown> };
    expect(source.Configuration.DetectChanges).toBe(false);
  });

  it("パイプラインのスタックの合成は既定の qualifier のまま", () => {
    const app = new App();
    new PipelineStack(app, "acme-test-pipeline", { env: TEST_ENV, settings: PIPELINE_SETTINGS, appStackName: "acme-test-app" });
    const artifact = app.synth().getStackByName("acme-test-pipeline");
    expect(artifact.assumeRoleArn).toContain("cdk-hnb659fds-deploy-role-");
    expect(artifact.cloudFormationExecutionRoleArn).toContain("cdk-hnb659fds-cfn-exec-role-");
  });

  it("準備の役割は、アプリ専用の lookup の役割の引き受けと設定の読み取りだけ", () => {
    const prep = rolePolicyFor(built.template, "acme-test-prepare");
    expect(prep).toContain(`cdk-${QUALIFIER}-lookup-role-123456789012-us-west-2`);
    expect(prep).not.toContain("hnb659fds");
    expect(prep).not.toContain("deploy-role");
    expect(prep).not.toContain("file-publishing-role");
    expect(prep).toContain("ssm:GetParameter");
  });

  it("反映の役割は固定の名前で、決めた一覧の権限だけを持つ", () => {
    built.template.hasResourceProperties("AWS::IAM::Role", { RoleName: "acme-test-deploy-us-west-2" });
    const documents = JSON.parse(rolePolicyFor(built.template, "acme-test-deploy")) as Array<{
      Statement: Array<{ Effect: string; Action: string | string[]; Resource: unknown }>;
    }>;
    const statements = documents.flatMap((d) => d.Statement);
    const actions = statements.flatMap((s) => [s.Action].flat());
    // CDK が付ける成果物とログの権限
    const own = actions.filter((a) => !/^(s3:(GetObject|GetBucket|List|Abort|DeleteObject|PutObject)|logs:|codebuild:(CreateReport|UpdateReport|BatchPut))/.test(a));
    expect(own.sort()).toEqual(
      [
        "sts:AssumeRole",
        "ssm:GetParameter",
        "codepipeline:GetPipelineExecution",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:GetRole",
        "iam:SimulatePrincipalPolicy",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
      ].sort(),
    );
    const resourcesOf = (action: string) =>
      statements.filter((s) => [s.Action].flat().includes(action)).flatMap((s) => [s.Resource].flat());
    const text = (action: string) => JSON.stringify(resourcesOf(action));
    expect(resourcesOf("sts:AssumeRole")).toHaveLength(4);
    for (const kind of ["deploy", "file-publishing", "image-publishing", "cfn-exec"]) {
      expect(text("sts:AssumeRole")).toContain(`cdk-${QUALIFIER}-${kind}-role-123456789012-us-west-2`);
    }
    expect(resourcesOf("ssm:GetParameter")).toHaveLength(2);
    expect(text("ssm:GetParameter")).toContain("parameter/acme/test/settings");
    expect(text("ssm:GetParameter")).toContain("parameter/acme/test/launch-declared");
    expect(resourcesOf("codepipeline:GetPipelineExecution")).toHaveLength(1);
    expect(text("codepipeline:GetPipelineExecution")).toContain(":123456789012:acme-test-pipeline");
    expect(resourcesOf("iam:SimulatePrincipalPolicy")).toHaveLength(2);
    expect(text("iam:SimulatePrincipalPolicy")).toContain(`cdk-${QUALIFIER}-cfn-exec-role-`);
    expect(text("iam:SimulatePrincipalPolicy")).toContain(`cdk-${QUALIFIER}-deploy-role-`);
  });

  it("反映のアクションに、準備の変数と実行の ID を渡し、検査へ渡す値はプロジェクトが持つ", () => {
    const deploy = stages(built.template)[2]!.Actions[0]! as { Configuration: Record<string, unknown> };
    const configuration = JSON.stringify(deploy.Configuration);
    for (const part of [
      "#{Prepare.ASSEMBLY_DIGEST}",
      "#{Prepare.SETTINGS_VERSION}",
      "#{Prepare.SETTINGS_SHA256}",
      "#{codepipeline.PipelineExecutionId}",
    ]) {
      expect(configuration).toContain(part);
    }
    const project = Object.values(resources(built.template)).find(
      (r) => r.Type === "AWS::CodeBuild::Project" && r.Properties?.Name === "acme-test-deploy",
    );
    expect(JSON.stringify(project?.Properties?.Environment)).toContain("ND_GUARD_CONFIG");
  });

  it("反映の手順は、BuildSpec の上限の 25,600 文字に収まる", () => {
    expect(projectBuildSpec(built.template, "acme-test-deploy").length).toBeLessThan(25_600);
  });

  it("反映のプロジェクトの手順に合成が無い", () => {
    const spec = projectBuildSpec(built.template, "acme-test-deploy");
    expect(spec).not.toMatch(/synth/);
    expect(spec).toContain("cdk deploy --app cdk.out");
  });

  it("接続の名前が 32 文字を超える設定では、理由を示して合成を止める", () => {
    const long: Settings = { ...PIPELINE_SETTINGS, prefix: "acme-very-long-name1", environment: "staging01" };
    expect(() => build(long)).toThrow(/32 文字/);
  });

  it("pipeline が無い設定ではスタックを作れない", () => {
    const { pipeline: _p, ...noPipeline } = PIPELINE_SETTINGS;
    expect(() => build(noPipeline)).toThrow(/pipeline/);
  });
});

describe("prepareBuildSpec", () => {
  const spec = specText(prepareBuildSpec(PIPELINE_SETTINGS, "acme-test-app"));

  it("要約値を ASSEMBLY_DIGEST_SHELL で作り、変数として書き出す", () => {
    expect(spec).toContain(JSON.stringify(ASSEMBLY_DIGEST_SHELL).slice(1, -1));
    const parsed = JSON.parse(spec) as { env: { "exported-variables": string[] } };
    expect(parsed.env["exported-variables"]).toEqual(
      expect.arrayContaining(["COMMIT", "ASSEMBLY_DIGEST", "DIGEST_PREFIX", "STACKS", "BUILD_URL"]),
    );
  });

  it("SSM から設定を書き出し、アプリのスタックだけを合成し、保存した結果の差分を残す", () => {
    expect(spec).toContain("/acme/test/settings");
    expect(spec).toContain("ND_STACKS=app");
    expect(spec).toContain("cdk diff --app cdk.out --method=template acme-test-app");
    expect(spec).toContain("approval/diff.txt");
  });

  const commands = (JSON.parse(spec) as { phases: { build: { commands: string[] } } }).phases.build.commands;
  const indexOf = (part: string) => commands.findIndex((c) => c.includes(part));
  const CONTRACT = "npm run ndf-contract -- --summary infra/approval/ndf-contract.md";

  it("npm ci の後、画面のビルドと合成の前に、出力先を作ってから契約を照合する", () => {
    const check = commands.indexOf(CONTRACT);
    expect(check).toBeGreaterThan(indexOf("npm ci"));
    expect(indexOf("mkdir -p infra/approval")).toBeGreaterThanOrEqual(0);
    expect(indexOf("mkdir -p infra/approval")).toBeLessThan(check);
    expect(check).toBeLessThan(indexOf("npm run build:web"));
    expect(check).toBeLessThan(indexOf("cdk synth"));
  });

  it("照合の失敗を打ち消さない（1 行そのままで、失敗しても続ける指定が無い）", () => {
    // 行の全体が一致するので、パイプ・|| ・; でつないだ行は見つからない
    expect(commands.filter((c) => c.includes("ndf-contract --"))).toEqual([CONTRACT]);
    expect(spec).not.toContain("on-failure");
  });

  it("版を先に読み、その版を指定して値を読み、版と SHA-256 を出力の変数にする", () => {
    const version = indexOf("--query Parameter.Version");
    const value = indexOf('--name "/acme/test/settings:$SETTINGS_VERSION"');
    expect(version).toBeGreaterThanOrEqual(0);
    expect(value).toBeGreaterThan(version);
    expect(commands[value]).toContain("--query Parameter.Value --output json");
    expect(indexOf("SETTINGS_SHA256=")).toBeGreaterThan(value);
    expect(indexOf("cdk synth")).toBeGreaterThan(indexOf("SETTINGS_SHA256="));
    expect(commands).toContain("export SETTINGS_VERSION SETTINGS_SHA256");
    const parsed = JSON.parse(spec) as { env: { "exported-variables": string[] } };
    expect(parsed.env["exported-variables"]).toEqual(expect.arrayContaining(["SETTINGS_VERSION", "SETTINGS_SHA256"]));
  });

  it("値の JSON の文字列を解いて改行を足さずに書き、書いた中身の SHA-256 を数える", () => {
    const line = commands[indexOf("SETTINGS_SHA256=")]!;
    const script = /node -e '([^']+)'/.exec(line)?.[1];
    const dir = mkdtempSync(join(tmpdir(), "nd-prepare-"));
    const raw = join(dir, "value.json");
    const out = join(dir, "settings.json");
    const value = '{\n  "prefix": "acme",\n  "note": "作り物"\n}';
    writeFileSync(raw, JSON.stringify(value));
    const sha = execFileSync(process.execPath, ["-e", script!, raw, out], { encoding: "utf8" });
    expect(readFileSync(out, "utf8")).toBe(value);
    expect(sha).toBe(createHash("sha256").update(value, "utf8").digest("hex"));
  });

  it("出力の成果物は cdk.out と approval だけ", () => {
    const parsed = JSON.parse(spec) as { artifacts: { files: string[] } };
    expect(parsed.artifacts.files).toEqual(["cdk.out/**/*", "approval/**/*"]);
  });
});

describe("deployBuildSpec", () => {
  const spec = specText(deployBuildSpec("acme-test-app", "2.1148.1", "Z3VhcmQ="));
  const commands = (JSON.parse(spec) as { phases: { build: { commands: string[] } } }).phases.build.commands;
  const indexOf = (part: string) => commands.findIndex((c) => c.includes(part));

  it("直前の検査 → 要約値の照合 → 反映 の順", () => {
    expect(commands[0]).toBe("printf %s 'Z3VhcmQ=' | base64 -d | gunzip > /tmp/nd-deploy-guard.mjs");
    expect(commands[1]).toBe("node /tmp/nd-deploy-guard.mjs cdk.out");
    expect(indexOf("ACTUAL_DIGEST=")).toBeGreaterThan(1);
    expect(indexOf("cdk deploy")).toBe(commands.length - 1);
    expect(spec).not.toContain("on-failure");
  });

  it("要約値を数え直して準備の変数と比べ、違えば exit 1、同じなら保存した合成の結果を反映する", () => {
    expect(spec).toContain(JSON.stringify(ASSEMBLY_DIGEST_SHELL).slice(1, -1));
    expect(spec).toContain("EXPECTED_DIGEST");
    expect(spec).toContain("exit 1");
    expect(spec).toContain("cdk deploy --app cdk.out --require-approval never acme-test-app");
    expect(spec).toContain("aws-cdk@2.1148.1");
  });

  it("合成を含まない", () => {
    expect(spec).not.toMatch(/synth/);
  });
});

describe("bundleDeployGuard", () => {
  const code = () => gunzipSync(Buffer.from(bundleDeployGuard(), "base64")).toString("utf8");

  it("束ねた結果の import は node: の組み込みだけで、同じ入力からは同じ文字列", () => {
    const imports = [...code().matchAll(/(?:from|import)\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => !i.startsWith("node:"))).toEqual([]);
    expect(bundleDeployGuard()).toBe(bundleDeployGuard());
  });

  it("束ねた検査は、指定が無ければ理由の 1 行を出して 1 で終わる", () => {
    const path = join(mkdtempSync(join(tmpdir(), "nd-guard-bundle-")), "guard.mjs");
    writeFileSync(path, code());
    const result = spawnSync(process.execPath, [path], { encoding: "utf8", env: {} });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("反映しない: 合成の結果の置き場の指定が無い");
  });
});

describe("guardConfig", () => {
  it("作り物の設定から、検査へ渡す名前と ARN を作る", () => {
    const stack = new Stack(new App(), "S", { env: TEST_ENV });
    const config = guardConfig(stack, PIPELINE_SETTINGS, "acme-test-app");
    expect(JSON.parse(JSON.stringify(stack.resolve(config.appStack)))).toBe("acme-test-app");
    expect({ ...config, partition: "aws", appArns: undefined }).toMatchObject({ ...GUARD, appArns: undefined });
  });

  it("アプリ専用の役割・アセットのバケット・管理ポリシーの ARN は、スタックのパーティションで組み立てる", () => {
    const stack = new Stack(new App(), "S", { env: TEST_ENV });
    const { appArns } = guardConfig(stack, PIPELINE_SETTINGS, "acme-test-app");
    // パーティションの token を含む Fn::Join を、1 つの文字列に戻して照らす
    const flat = (value: unknown): string => {
      if (typeof value === "string") return value;
      const node = value as { Ref?: string; "Fn::Join"?: [string, unknown[]] };
      if (node.Ref) return `<${node.Ref}>`;
      const [separator, parts] = node["Fn::Join"]!;
      return parts.map(flat).join(separator);
    };
    const inStack = (arn: string) => arn.replace(/^arn:aws:/, "arn:<AWS::Partition>:");
    expect(Object.fromEntries(Object.entries(appArns).map(([key, arn]) => [key, flat(stack.resolve(arn))]))).toEqual(
      Object.fromEntries(Object.entries(GUARD.appArns).map(([key, arn]) => [key, inStack(arn)])),
    );
  });
});

describe("cdkCliVersion", () => {
  it("最上位の package.json の aws-cdk の版を返す", () => {
    const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(cdkCliVersion()).toBe(root.devDependencies["aws-cdk"]);
    expect(cdkCliVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("PipelineStack の準備と反映のプロジェクトとその権限", () => {
  let built: Built;
  beforeAll(() => {
    built = build(PIPELINE_SETTINGS);
  });

  // 名前を固定した資源は、論理 ID が変わると置き換えになって反映が失敗する
  it("プロジェクトと役割と方針の論理 ID", () => {
    const ids = Object.entries(resources(built.template))
      .filter(([id, r]) => /^(Prepare|DeployProject)/.test(id) && /^AWS::(CodeBuild|IAM)::/.test(r.Type))
      .map(([id]) => id);
    expect(ids.sort()).toEqual([
      "DeployProject1CF7CB79",
      "DeployProjectRole0C7F6EB1",
      "DeployProjectRoleDefaultPolicyB3525A14",
      "PrepareProjectCCCEB6FC",
      "PrepareProjectRoleD85ED828",
      "PrepareProjectRoleDefaultPolicy9F6A3CC8",
    ]);
  });

  const properties = (id: string) => resources(built.template)[id]!.Properties!;
  const environment = { ComputeType: "BUILD_GENERAL1_SMALL", Image: "aws/codebuild/standard:7.0", PrivilegedMode: false };
  const buildSpecOf = (id: string) => (properties(id).Source as { BuildSpec: string }).BuildSpec;

  it("準備のプロジェクトの名前・環境・時間の上限・手順・役割", () => {
    const project = properties("PrepareProjectCCCEB6FC");
    expect(project).toMatchObject({
      Name: "acme-test-prepare",
      TimeoutInMinutes: 30,
      Environment: environment,
      ServiceRole: { "Fn::GetAtt": ["PrepareProjectRoleD85ED828", "Arn"] },
    });
    expect(project.Environment).not.toHaveProperty("EnvironmentVariables");
    expect(buildSpecOf("PrepareProjectCCCEB6FC")).toBe(specText(prepareBuildSpec(PIPELINE_SETTINGS, "acme-test-app")));
  });

  it("反映のプロジェクトの名前・環境・時間の上限・手順・役割と、検査へ渡す値", () => {
    const project = properties("DeployProject1CF7CB79");
    const stack = new Stack(new App(), "acme-test-pipeline", { env: TEST_ENV });
    const guard = guardConfig(stack, PIPELINE_SETTINGS, "acme-test-app");
    expect(project).toMatchObject({
      Name: "acme-test-deploy",
      TimeoutInMinutes: 60,
      Environment: environment,
      ServiceRole: { "Fn::GetAtt": ["DeployProjectRole0C7F6EB1", "Arn"] },
    });
    expect((project.Environment as { EnvironmentVariables: unknown }).EnvironmentVariables).toEqual([
      { Name: "ND_GUARD_CONFIG", Type: "PLAINTEXT", Value: stack.resolve(stack.toJsonString(guard)) as unknown },
    ]);
    expect(buildSpecOf("DeployProject1CF7CB79")).toBe(
      specText(deployBuildSpec("acme-test-app", cdkCliVersion(), bundleDeployGuard())),
    );
    expect(properties("DeployProjectRole0C7F6EB1")).toMatchObject({
      RoleName: "acme-test-deploy-us-west-2",
      AssumeRolePolicyDocument: {
        Statement: [{ Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "codebuild.amazonaws.com" } }],
      },
    });
  });

  // CDK が付けるログ・レポート・成果物の権限を除いた、スタックが書いた文を順のまま返す
  const ownStatements = (policyId: string) => {
    const { Statement } = properties(policyId).PolicyDocument as { Statement: Array<{ Action: string | string[] }> };
    return Statement.filter((s) => ![s.Action].flat().some((a) => /^(logs|codebuild|s3):/.test(a)));
  };
  const arn = (rest: string) => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:${rest}`]] });
  const iam = (rest: string) => arn(`iam::123456789012:${rest}`);
  const role = (kind: string) => iam(`role/cdk-${QUALIFIER}-${kind}-role-123456789012-us-west-2`);
  const allow = (Action: string | string[], Resource: unknown) => ({ Action, Effect: "Allow", Resource });

  it("準備の役割に書いた権限の文", () => {
    expect(ownStatements("PrepareProjectRoleDefaultPolicy9F6A3CC8")).toEqual([
      allow("ssm:GetParameter", {
        "Fn::Join": [
          "",
          ["arn:", { Ref: "AWS::Partition" }, ":ssm:us-west-2:123456789012:parameter", { Ref: "SettingsParameter5C8DE5DF" }],
        ],
      }),
      allow("sts:AssumeRole", role("lookup")),
    ]);
  });

  it("反映の役割に書いた権限の文", () => {
    expect(ownStatements("DeployProjectRoleDefaultPolicyB3525A14")).toEqual([
      allow("sts:AssumeRole", ["deploy", "file-publishing", "image-publishing", "cfn-exec"].map(role)),
      allow(
        "ssm:GetParameter",
        ["settings", "launch-declared"].map((name) => arn(`ssm:us-west-2:123456789012:parameter/acme/test/${name}`)),
      ),
      allow("codepipeline:GetPipelineExecution", arn("codepipeline:us-west-2:123456789012:acme-test-pipeline")),
      allow(
        ["iam:ListAttachedRolePolicies", "iam:ListRolePolicies", "iam:GetRole", "iam:SimulatePrincipalPolicy"],
        [role("cfn-exec"), role("deploy")],
      ),
      allow(
        ["iam:GetPolicy", "iam:GetPolicyVersion"],
        [iam("policy/acme-test-app-cfn-exec"), iam("policy/acme-test-app-boundary")],
      ),
    ]);
  });
});
