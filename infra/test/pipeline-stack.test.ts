import { readFileSync } from "node:fs";
import type { Settings } from "@nd-factory/contracts/settings";
import { App, Stack } from "aws-cdk-lib";
import type { BuildSpec } from "aws-cdk-lib/aws-codebuild";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { ASSEMBLY_DIGEST_SHELL } from "../lib/assembly-digest.ts";
import { PipelineStack, cdkCliVersion, deployBuildSpec, prepareBuildSpec } from "../lib/pipeline-stack.ts";
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

  it("取る → 準備 → 承認 → 反映 の順に段がある", () => {
    const s = stages(built.template);
    expect(s.map((x) => x.Name)).toEqual(["Source", "Prepare", "Approve", "Deploy"]);
    const owners = s.map((x) => (x.Actions[0]?.ActionTypeId as { Category: string }).Category);
    expect(owners).toEqual(["Source", "Build", "Approval", "Build"]);
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
    const deploy = s[3]!.Actions[0]!;
    expect(prepare.Namespace).toBe("Prepare");
    const prepOut = (prepare.OutputArtifacts as Array<{ Name: string }>).map((a) => a.Name);
    const deployIn = (deploy.InputArtifacts as Array<{ Name: string }>).map((a) => a.Name);
    expect(prepOut).toHaveLength(1);
    expect(deployIn).toEqual(prepOut);
    expect(JSON.stringify(deploy.Configuration)).toContain("#{Prepare.ASSEMBLY_DIGEST}");
  });

  it("承認の資料はコミット・要約値・スタックと準備の記録の URL で、依頼は知らせの宛先へ送る", () => {
    const approve = stages(built.template)[2]!.Actions[0]! as { Configuration: Record<string, unknown> };
    const custom = approve.Configuration.CustomData as string;
    expect(custom).toContain("#{Prepare.COMMIT}");
    expect(custom).toContain("#{Prepare.DIGEST_PREFIX}");
    expect(custom).toContain("#{Prepare.STACKS}");
    expect(approve.Configuration.ExternalEntityLink).toBe("#{Prepare.BUILD_URL}");
    expect(approve.Configuration.NotificationArn).toBeDefined();
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

  it("承認を拒む管理の方針を作り、どの主体にも付けない", () => {
    const policies = Object.entries(resources(built.template)).filter(([, r]) => r.Type === "AWS::IAM::ManagedPolicy");
    expect(policies).toHaveLength(1);
    const [policyId, policy] = policies[0]!;
    expect(policy.Properties?.ManagedPolicyName).toBe("acme-test-deny-approval");
    expect(policy.Properties?.Users).toBeUndefined();
    expect(policy.Properties?.Roles).toBeUndefined();
    expect(policy.Properties?.Groups).toBeUndefined();
    expect(policy.Properties?.PolicyDocument).toMatchObject({
      Statement: [{ Effect: "Deny", Action: "codepipeline:PutApprovalResult" }],
    });
    // どの役割の ManagedPolicyArns からも参照されない
    const others = Object.entries(resources(built.template)).filter(([id]) => id !== policyId);
    expect(JSON.stringify(others)).not.toContain(`"${policyId}"`);
  });

  it("準備の役割は bootstrap の lookup の役割だけを、反映の役割は deploy と file-publishing の役割だけを引き受ける", () => {
    const prep = rolePolicyFor(built.template, "acme-test-prepare");
    expect(prep).toContain("cdk-hnb659fds-lookup-role-123456789012-us-west-2");
    expect(prep).not.toContain("cdk-hnb659fds-deploy-role");
    expect(prep).not.toContain("file-publishing-role");
    expect(prep).toContain("ssm:GetParameter");
    const dep = rolePolicyFor(built.template, "acme-test-deploy");
    expect(dep).toContain("cdk-hnb659fds-deploy-role-123456789012-us-west-2");
    expect(dep).toContain("cdk-hnb659fds-file-publishing-role-123456789012-us-west-2");
    expect(dep).not.toContain("lookup-role");
    expect(dep).not.toContain("ssm:GetParameter");
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

  it("SSM から設定を書き出し、縦の切れ端だけを合成し、保存した結果の差分を残す", () => {
    expect(spec).toContain("/acme/test/settings");
    expect(spec).toContain("ND_STACKS=app");
    expect(spec).toContain("cdk diff --app cdk.out --method=template acme-test-app");
    expect(spec).toContain("approval/diff.txt");
  });

  it("出力の成果物は cdk.out と approval だけ", () => {
    const parsed = JSON.parse(spec) as { artifacts: { files: string[] } };
    expect(parsed.artifacts.files).toEqual(["cdk.out/**/*", "approval/**/*"]);
  });
});

describe("deployBuildSpec", () => {
  const spec = specText(deployBuildSpec("acme-test-app", "2.1148.1"));

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

describe("cdkCliVersion", () => {
  it("最上位の package.json の aws-cdk の版を返す", () => {
    const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(cdkCliVersion()).toBe(root.devDependencies["aws-cdk"]);
    expect(cdkCliVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
