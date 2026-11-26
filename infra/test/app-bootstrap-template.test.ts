import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildApp } from "../bin/app.ts";
import {
  type BootstrapInput,
  EXECUTION_ALLOW,
  appExecutionPolicy,
  appPermissionsBoundary,
  restrictBootstrapTemplate,
} from "../lib/app-bootstrap-template.ts";
import { ACCOUNT_ARN, BOUNDARY_ARN, QUALIFIER, cdkRole } from "./guard-support.ts";
import { matches, standardBootstrapTemplate, tempWebDist } from "./support.ts";

// 漏れの検査が ARN の直書きを当てるので、作り物のアカウントは定数から組み立てる
const FAKE_ACCOUNT = "123456789012";

// 値はすべて作り物。打つ版の CDK の標準のテンプレートに制約を当てた結果を照らす

const FIXTURE = new URL("./fixtures/settings.json", import.meta.url).pathname;
const STANDARD = standardBootstrapTemplate();

const DEPLOY_PROJECT_ROLE = `${ACCOUNT_ARN}:role/acme-test-deploy-us-west-2`;
const DIRECT_ROLE = `${ACCOUNT_ARN}:role/acme-operator`;
const APP_STACK = `arn:aws:cloudformation:us-west-2:${FAKE_ACCOUNT}:stack/acme-test-app/*`;
const PIPELINE_STACK = `arn:aws:cloudformation:us-west-2:${FAKE_ACCOUNT}:stack/acme-test-pipeline/*`;
const SETTINGS_PARAM = `arn:aws:ssm:us-west-2:${FAKE_ACCOUNT}:parameter/acme/test/settings`;
const RECORD_PARAM = `arn:aws:ssm:us-west-2:${FAKE_ACCOUNT}:parameter/acme/test/launch-declared`;

const INPUT: BootstrapInput = {
  partition: "aws",
  account: "123456789012",
  region: "us-west-2",
  settings: { prefix: "acme", environment: "test" },
  directRoleArns: [],
};
const LONGEST: BootstrapInput = {
  ...INPUT,
  region: "ap-southeast-2",
  settings: { prefix: "a".repeat(20), environment: "b".repeat(10) },
};
// ARN はパーティションとリージョンの名前が長いほど長くなる
const LONGEST_INPUTS = [
  LONGEST,
  { ...LONGEST, partition: "aws-cn", region: "cn-northwest-1" },
  { ...LONGEST, partition: "aws-us-gov", region: "us-gov-west-1" },
];

type Statement = {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
  Principal?: unknown;
};
type Doc = { Version?: string; Statement: Statement[] };
type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string };
type BootstrapTemplate = { Parameters: Record<string, { Default?: string }>; Resources: Record<string, Resource> };

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : v === undefined ? [] : [v as string]);

// 資源と操作の両方に当たる文。条件は呼び手が見る
function statements(doc: Doc, effect: "Allow" | "Deny", action: string, resource?: string): Statement[] {
  return doc.Statement.filter(
    (s) =>
      s.Effect === effect &&
      list(s.Action).some((a) => matches(a, action)) &&
      (resource === undefined || list(s.Resource).some((r) => matches(r, resource))),
  );
}

function appTemplate(): Record<string, { Type: string; Properties?: Record<string, unknown> }> {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  buildApp(app, {
    ND_SETTINGS: FIXTURE,
    ND_STACKS: "app",
    CDK_DEFAULT_ACCOUNT: "123456789012",
    CDK_DEFAULT_REGION: "us-west-2",
    ND_WEB_DIST: tempWebDist(),
  });
  return app.synth().getStackByName("acme-test-app").template.Resources as Record<string, { Type: string }>;
}

describe("アセットのバケットと管理ポリシーの ARN", () => {
  // aws でないパーティションの作り物の入力で、直書きの "aws" が混ざらないことも照らす
  const input: BootstrapInput = { ...INPUT, partition: "aws-cn", region: "cn-north-1" };
  // 置き場の名前を直書きすると漏れの検査が当てるので、名前を先に組み立てる
  const bucketName = `cdk-${QUALIFIER}-assets-${FAKE_ACCOUNT}-cn-north-1`;
  const bucket = `arn:aws-cn:s3:::${bucketName}`;
  const policy = (name: string) => `arn:aws-cn:iam::${FAKE_ACCOUNT}:policy/${name}`;
  const docs = [
    ["実行の管理ポリシー", appExecutionPolicy(input) as Doc],
    ["権限の境界", appPermissionsBoundary(input) as Doc],
  ] as const;
  const named = (doc: Doc, part: string) =>
    [...new Set(doc.Statement.flatMap((s) => list(s.Resource)).filter((r) => r.includes(part)))].sort();

  it("アセットのバケットの ARN は、実行の管理ポリシーが中身、権限の境界がバケットと中身", () => {
    expect(named(docs[0][1], "-assets-")).toEqual([`${bucket}/*`]);
    expect(named(docs[1][1], "-assets-")).toEqual([bucket, `${bucket}/*`]);
  });

  it("実行の管理ポリシーが指す管理ポリシーの ARN は、権限の境界と実行の管理ポリシー", () => {
    expect(named(docs[0][1], ":policy/")).toEqual([policy("acme-test-app-boundary"), policy("acme-test-app-cfn-exec")]);
  });
});

// 資源とリクエストのタグを渡し、タグの条件まで当てて、許可されるかを返す
function allows(doc: Doc, action: string, resource: string, tags: Record<string, string>): boolean {
  const holds = (condition: Statement["Condition"] = {}) =>
    Object.entries(condition).every(([operator, entries]) =>
      Object.entries(entries).every(([key, expected]) => {
        if (operator === "Null") return String(tags[key] === undefined) === expected;
        if (operator === "StringEquals") return tags[key] === expected;
        if (operator === "StringNotEquals") return tags[key] !== expected;
        return false;
      }),
    );
  const applies = (effect: "Allow" | "Deny") => statements(doc, effect, action, resource).some((s) => holds(s.Condition));
  return applies("Allow") && !applies("Deny");
}

const tagsOf = (context: "ResourceTag" | "RequestTag", prefix: string, environment: string) => ({
  [`aws:${context}/app-prefix`]: prefix,
  [`aws:${context}/app-env`]: environment,
});
const DISTRIBUTION = `arn:aws:cloudfront::${FAKE_ACCOUNT}:distribution/EXAMPLE`;

describe("appExecutionPolicy", () => {
  const doc = appExecutionPolicy(INPUT) as Doc;

  it("合成したアプリのスタックの資源の型が、すべて EXECUTION_ALLOW にある", () => {
    const types = [...new Set(Object.values(appTemplate()).map((r) => r.Type))];
    expect(types.filter((t) => !(t in EXECUTION_ALLOW))).toEqual([]);
  });

  it("*:* の許可が無く、Resource が * の許可は資源を指定できない操作だけ", () => {
    const allowed = doc.Statement.filter((s) => s.Effect === "Allow");
    for (const s of allowed) {
      for (const a of list(s.Action)) expect(a).toMatch(/^[a-z0-9-]+:/);
    }
    // サービスの操作をまとめて許すのは、名前でこの設置に限れる資源だけ
    const whole = allowed.flatMap((s) => list(s.Action)).filter((a) => a.endsWith(":*"));
    expect(whole.filter((a) => /^(iam|cloudformation|ssm|codepipeline|codebuild|sts|ec2|cognito-idp|cloudfront):/.test(a))).toEqual([]);
    const anywhere = allowed.filter((s) => list(s.Resource).includes("*")).flatMap((s) => list(s.Action));
    expect(anywhere.filter((a) => /^(iam|cloudformation|ssm|codepipeline|codebuild|sts|s3|lambda):/.test(a))).toEqual([]);
    expect(anywhere.filter((a) => a.endsWith(":*"))).toEqual([]);
  });

  it.each([
    ["パイプラインのスタックの更新", "cloudformation:UpdateStack", PIPELINE_STACK],
    ["パイプラインのスタックの変更セット", "cloudformation:CreateChangeSet", PIPELINE_STACK],
    ["反映のプロジェクトのロールの信頼", "iam:UpdateAssumeRolePolicy", DEPLOY_PROJECT_ROLE],
    ["反映のプロジェクトのロールの方針", "iam:PutRolePolicy", DEPLOY_PROJECT_ROLE],
    ["パイプラインのスタックのロール", "iam:AttachRolePolicy", `${ACCOUNT_ARN}:role/acme-test-pipeline-PipelineRole-EXAMPLE`],
    ["パイプラインの定義", "codepipeline:UpdatePipeline", `arn:aws:codepipeline:us-west-2:${FAKE_ACCOUNT}:acme-test-pipeline`],
    ["パイプラインの削除", "codepipeline:DeletePipeline", `arn:aws:codepipeline:us-west-2:${FAKE_ACCOUNT}:acme-test-pipeline`],
    ["反映のプロジェクト", "codebuild:UpdateProject", `arn:aws:codebuild:us-west-2:${FAKE_ACCOUNT}:project/acme-test-deploy`],
    ["設定のパラメーター", "ssm:PutParameter", SETTINGS_PARAM],
    ["宣言の記録の書き込み", "ssm:PutParameter", RECORD_PARAM],
    ["宣言の記録の削除", "ssm:DeleteParameter", RECORD_PARAM],
    ["境界の版", "iam:CreatePolicyVersion", BOUNDARY_ARN],
    ["実行の方針の版", "iam:CreatePolicyVersion", `${ACCOUNT_ARN}:policy/acme-test-app-cfn-exec`],
    ["境界の削除", "iam:DeletePolicy", BOUNDARY_ARN],
    ["境界を外す", "iam:DeleteRolePermissionsBoundary", `${ACCOUNT_ARN}:role/acme-test-app-UsersFunctionRole-EXAMPLE`],
  ])("%sを拒否する", (_name, action, resource) => {
    expect(statements(doc, "Deny", action, resource).filter((s) => s.Condition === undefined)).not.toEqual([]);
  });

  it.each([
    "iam:CreateRole",
    "iam:PutRolePolicy",
    "iam:AttachRolePolicy",
    "iam:DetachRolePolicy",
    "iam:DeleteRolePolicy",
    "iam:PutRolePermissionsBoundary",
  ])("%s は、境界を指定したアプリのスタックのロールだけに許す", (action) => {
    const allowed = statements(doc, "Allow", action);
    expect(allowed).toHaveLength(1);
    expect(allowed[0]!.Resource).toEqual([`${ACCOUNT_ARN}:role/acme-test-app-*`]);
    expect(allowed[0]!.Condition).toEqual({ ArnEquals: { "iam:PermissionsBoundary": BOUNDARY_ARN } });
  });

  it.each(["iam:UpdateAssumeRolePolicy", "iam:UpdateRole", "iam:DeleteRole"])("%s はアプリのスタックのロールだけ", (action) => {
    const allowed = statements(doc, "Allow", action);
    expect(allowed.flatMap((s) => list(s.Resource))).toEqual([`${ACCOUNT_ARN}:role/acme-test-app-*`]);
  });

  it("iam:PassRole はアプリのスタックのロールを、使うサービスへ渡すときだけ", () => {
    const allowed = statements(doc, "Allow", "iam:PassRole");
    expect(allowed).toHaveLength(1);
    expect(allowed[0]!.Resource).toEqual([`${ACCOUNT_ARN}:role/acme-test-app-*`]);
    expect(allowed[0]!.Condition).toEqual({
      StringEquals: { "iam:PassedToService": ["lambda.amazonaws.com", "ecs-tasks.amazonaws.com"] },
    });
  });

  it("利用者の表を作る権限: ListTables は全体に、サービスリンクロールの作成は DynamoDB のものに許す", () => {
    expect(statements(doc, "Allow", "dynamodb:ListTables", "*")).not.toEqual([]);
    const slr = `${ACCOUNT_ARN}:role/aws-service-role/replication.dynamodb.amazonaws.com/AWSServiceRoleForDynamoDBReplication`;
    expect(statements(doc, "Allow", "iam:CreateServiceLinkedRole", slr)).not.toEqual([]);
    expect(statements(doc, "Allow", "dynamodb:CreateTable", `arn:aws:dynamodb:us-west-2:${FAKE_ACCOUNT}:table/other`)).toEqual([]);
  });

  it.each([
    ["rds:DeleteDBSnapshot", "snapshot"],
    ["rds:DeleteDBClusterSnapshot", "cluster-snapshot"],
  ])("%s は、この設置の名前のスナップショットにも許さない", (action, kind) => {
    expect(statements(doc, "Allow", action, `arn:aws:rds:us-west-2:${FAKE_ACCOUNT}:${kind}:acme-test-backup`)).toEqual([]);
  });

  it.each([
    ["rds:DeleteDBCluster", "cluster"],
    ["rds:DeleteDBInstance", "db"],
    ["rds:DeleteDBClusterParameterGroup", "cluster-pg"],
    ["rds:DeleteDBSubnetGroup", "subgrp"],
  ])("%s は、この設置の名前の資源に許す", (action, kind) => {
    expect(statements(doc, "Allow", action, `arn:aws:rds:us-west-2:${FAKE_ACCOUNT}:${kind}:acme-test-example`)).not.toEqual([]);
  });

  it("パイプラインの失敗の知らせのトピックを変えられない", () => {
    expect(statements(doc, "Allow", "sns:DeleteTopic", `arn:aws:sns:us-west-2:${FAKE_ACCOUNT}:acme-test-notify`)).toEqual([]);
    expect(statements(doc, "Allow", "sns:DeleteTopic", `arn:aws:sns:us-west-2:${FAKE_ACCOUNT}:acme-test-ops`)).not.toEqual([]);
  });

  const allowedWithTags = (action: string, resource: string, tags: Record<string, string>) => allows(doc, action, resource, tags);
  const USER_POOL = `arn:aws:cognito-idp:us-west-2:${FAKE_ACCOUNT}:userpool/us-west-2_EXAMPLE`;
  const VPC = `arn:aws:ec2:us-west-2:${FAKE_ACCOUNT}:vpc/vpc-EXAMPLE`;
  const API = "arn:aws:apigateway:us-west-2::/apis/example";

  it.each([
    ["cognito-idp:DeleteUserPool", USER_POOL],
    ["cognito-idp:UpdateUserPoolClient", USER_POOL],
    ["cloudfront:UpdateDistribution", DISTRIBUTION],
    ["cloudfront:DeleteDistribution", DISTRIBUTION],
    ["ec2:DeleteVpc", VPC],
    ["ec2:CreateTags", VPC],
    ["apigateway:DELETE", API],
  ])("%s は、この設置のタグの資源に許し、別の設置のタグの資源を拒む", (action, resource) => {
    expect(allowedWithTags(action, resource, tagsOf("ResourceTag", "acme", "test"))).toBe(true);
    expect(allowedWithTags(action, resource, tagsOf("ResourceTag", "other", "test"))).toBe(false);
    expect(allowedWithTags(action, resource, tagsOf("ResourceTag", "acme", "prod"))).toBe(false);
  });

  it.each([
    ["cognito-idp:DeleteUserPool", USER_POOL],
    ["cloudfront:DeleteDistribution", DISTRIBUTION],
  ])("%s は、タグの無い資源に許さない", (action, resource) => {
    expect(allowedWithTags(action, resource, {})).toBe(false);
  });

  it("ディストリビューションの作成は、この設置のタグを付ける要求だけに許す", () => {
    expect(statements(doc, "Allow", "cloudfront:CreateDistribution", "*")).not.toEqual([]);
    // 資源の ARN を指定できないので、資源は * で渡る
    expect(allowedWithTags("cloudfront:CreateDistribution", "*", tagsOf("RequestTag", "acme", "test"))).toBe(true);
    expect(allowedWithTags("cloudfront:CreateDistribution", "*", tagsOf("RequestTag", "other", "test"))).toBe(false);
    expect(allowedWithTags("cloudfront:CreateDistribution", "*", {})).toBe(false);
  });

  it.each(["sns:Unsubscribe", "sns:GetSubscriptionAttributes", "sns:SetSubscriptionAttributes"])(
    "%s は、この設置の運用トピックだけ",
    (action) => {
      // 同じ文にほかのサービスの ARN が並ぶ。SNS の操作が当たるのは SNS の ARN だけ
      const resources = statements(doc, "Allow", action).flatMap((s) => list(s.Resource));
      expect(resources.filter((r) => r === "*" || r.split(":")[2] === "sns")).toEqual([
        `arn:aws:sns:us-west-2:${FAKE_ACCOUNT}:acme-test-ops`,
      ]);
    },
  );

  it.each(["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateGroup", "iam:CreatePolicy", "sts:AssumeRole"])("%s を許さない", (action) => {
    expect(statements(doc, "Allow", action)).toEqual([]);
  });

  it.each(LONGEST_INPUTS)("$region で prefix と environment が最長でも、管理ポリシーの上限の 6144 文字に収まる", (input) => {
    expect(JSON.stringify(appExecutionPolicy(input)).length).toBeLessThanOrEqual(6144);
  });
});

describe("appPermissionsBoundary", () => {
  const doc = appPermissionsBoundary(INPUT) as Doc;

  it("合成したアプリのロールの操作が、すべて境界の許可に含まれる", () => {
    const resources = Object.values(appTemplate());
    const documents = resources.flatMap((r) => {
      if (r.Type === "AWS::IAM::Policy") return [r.Properties?.PolicyDocument as Doc];
      if (r.Type !== "AWS::IAM::Role") return [];
      return ((r.Properties?.Policies ?? []) as Array<{ PolicyDocument: Doc }>).map((p) => p.PolicyDocument);
    });
    // AWSLambdaBasicExecutionRole の操作は合成の結果に現れない
    const actions = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"].concat(
      documents.flatMap((d) => d.Statement.flatMap((s) => list(s.Action))),
    );
    expect(actions.length).toBeGreaterThan(20);
    expect(actions.filter((a) => statements(doc, "Allow", a).length === 0)).toEqual([]);
  });

  it.each([
    "iam:CreateRole",
    "iam:PutRolePolicy",
    "iam:PassRole",
    "sts:AssumeRole",
    "cloudformation:UpdateStack",
    "codepipeline:UpdatePipeline",
    "codebuild:StartBuild",
  ])("%s を許さない", (action) => {
    expect(statements(doc, "Allow", action)).toEqual([]);
  });

  it.each(["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters"])("2 つのパラメーターへの %s を明示して拒否する", (action) => {
    for (const parameter of [SETTINGS_PARAM, RECORD_PARAM]) {
      expect(statements(doc, "Deny", action, parameter)).not.toEqual([]);
    }
    expect(statements(doc, "Allow", action)).toEqual([]);
  });

  it.each(["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"])(
    "%s は、この設置のタグのディストリビューションだけに許す",
    (action) => {
      expect(allows(doc, action, DISTRIBUTION, tagsOf("ResourceTag", "acme", "test"))).toBe(true);
      expect(allows(doc, action, DISTRIBUTION, tagsOf("ResourceTag", "other", "test"))).toBe(false);
      expect(allows(doc, action, DISTRIBUTION, tagsOf("ResourceTag", "acme", "prod"))).toBe(false);
      expect(allows(doc, action, DISTRIBUTION, {})).toBe(false);
    },
  );

  it.each(LONGEST_INPUTS)("$region で prefix と environment が最長でも 6144 文字に収まる", (input) => {
    expect(JSON.stringify(appPermissionsBoundary(input)).length).toBeLessThanOrEqual(6144);
  });
});

describe("restrictBootstrapTemplate", () => {
  const restrict = (input: BootstrapInput = INPUT, yaml = STANDARD) =>
    JSON.parse(restrictBootstrapTemplate(yaml, input)) as BootstrapTemplate;
  const template = restrict({ ...INPUT, directRoleArns: [DIRECT_ROLE] });
  const r = (id: string) => template.Resources[id]!;
  const trust = (t: BootstrapTemplate, id: string) => (t.Resources[id]!.Properties.AssumeRolePolicyDocument as Doc).Statement;
  const deploy = (r("DeploymentActionRole").Properties.Policies as Array<{ PolicyDocument: Doc }>)[0]!.PolicyDocument;

  const principalArns = (s: Statement): unknown => {
    const condition = s.Condition as Record<string, unknown>;
    const branch = (condition["Fn::If"] as unknown[] | undefined)?.slice(1) ?? [condition];
    return branch.map((c) => (c as { ArnEquals?: Record<string, unknown> }).ArnEquals?.["aws:PrincipalArn"]);
  };

  it("CLI が標準のテンプレートで上書きしないよう、BootstrapVariant を変える", () => {
    expect(template.Parameters.BootstrapVariant!.Default).toBe("nd-factory app");
  });

  it.each(["DeploymentActionRole", "FilePublishingRole", "ImagePublishingRole"])(
    "%s は、反映のプロジェクトのロールと渡したロールの引き受けとセッションタグだけを許す",
    (id) => {
      const statements_ = trust(template, id);
      expect(statements_.map((s) => s.Action)).toEqual(["sts:AssumeRole", "sts:TagSession"]);
      for (const s of statements_) {
        for (const arns of principalArns(s) as unknown[]) expect(arns).toEqual([DEPLOY_PROJECT_ROLE, DIRECT_ROLE]);
      }
      expect(JSON.stringify(statements_)).toContain("sts:ExternalId");
    },
  );

  it("渡すロールが無ければ、反映のプロジェクトのロールだけ", () => {
    for (const s of trust(restrict(), "DeploymentActionRole")) {
      for (const arns of principalArns(s) as unknown[]) expect(arns).toEqual([DEPLOY_PROJECT_ROLE]);
    }
  });

  it("反映のロールの CloudFormation の書き込みは 9 つで、対象はアプリのスタックだけ", () => {
    const writes = deploy.Statement.filter((s) => list(s.Action).some((a) => a.startsWith("cloudformation:")));
    expect(writes.flatMap((s) => list(s.Action)).sort()).toEqual(
      [
        "CreateChangeSet",
        "DeleteChangeSet",
        "ExecuteChangeSet",
        "CreateStack",
        "UpdateStack",
        "RollbackStack",
        "ContinueUpdateRollback",
        "DeleteStack",
        "UpdateTerminationProtection",
      ]
        .map((a) => `cloudformation:${a}`)
        .sort(),
    );
    for (const s of writes) expect(list(s.Resource)).toEqual([APP_STACK]);
    expect(JSON.stringify(deploy)).not.toMatch(/SetStackPolicy|StackRefactor/);
  });

  it("作成・更新・変更セットの作成にだけ、アプリ専用の実行のロールの条件を付ける", () => {
    const conditioned = deploy.Statement.filter((s) => s.Condition?.StringEquals?.["cloudformation:RoleArn"] !== undefined);
    expect(conditioned.flatMap((s) => list(s.Action)).sort()).toEqual([
      "cloudformation:CreateChangeSet",
      "cloudformation:CreateStack",
      "cloudformation:UpdateStack",
    ]);
    for (const s of conditioned) expect(s.Condition!.StringEquals!["cloudformation:RoleArn"]).toBe(cdkRole("cfn-exec"));
  });

  it("iam:PassRole で渡せるのはアプリ専用の実行のロールだけ", () => {
    const pass = deploy.Statement.filter((s) => list(s.Action).includes("iam:PassRole"));
    expect(pass).toHaveLength(1);
    expect(pass[0]!.Resource).toEqual({ "Fn::Sub": "${CloudFormationExecutionRole.Arn}" });
  });

  it("実行の方針と境界を足し、実行のロールは方針の後に作る", () => {
    expect(r("NdExecutionPolicy")).toMatchObject({
      Type: "AWS::IAM::ManagedPolicy",
      Properties: { ManagedPolicyName: "acme-test-app-cfn-exec", PolicyDocument: appExecutionPolicy(INPUT) },
    });
    expect(r("NdAppBoundary")).toMatchObject({
      Type: "AWS::IAM::ManagedPolicy",
      Properties: { ManagedPolicyName: "acme-test-app-boundary", PolicyDocument: appPermissionsBoundary(INPUT) },
    });
    expect(r("CloudFormationExecutionRole").DependsOn).toBe("NdExecutionPolicy");
  });

  it("lookup のロールは ReadOnlyAccess を持たず、アプリのスタックと bootstrap の版だけを読む", () => {
    const properties = r("LookupRole").Properties;
    expect(properties.ManagedPolicyArns).toBeUndefined();
    const document = (properties.Policies as Array<{ PolicyDocument: Doc }>)[0]!.PolicyDocument;
    const allowed = document.Statement.filter((s) => s.Effect === "Allow");
    expect(allowed.flatMap((s) => list(s.Action)).sort()).toEqual([
      "cloudformation:DescribeStacks",
      "cloudformation:GetTemplate",
      "ssm:GetParameter",
    ]);
    expect(allowed.flatMap((s) => list(s.Resource))).toEqual([
      APP_STACK,
      `arn:aws:ssm:us-west-2:${FAKE_ACCOUNT}:parameter/cdk-bootstrap/${QUALIFIER}/version`,
    ]);
  });

  it("アセットのバケットは、ファイルの公開のロール以外の書き込みと削除を拒否する", () => {
    const statements_ = (r("StagingBucketPolicy").Properties.PolicyDocument as Doc).Statement;
    expect(statements_.map((s) => s.Sid)).toContain("AllowSSLRequestsOnly");
    const deny = statements_.find((s) => s.Sid === "NdDenyWritesExceptFilePublishing")!;
    expect(deny).toMatchObject({
      Effect: "Deny",
      Principal: "*",
      Action: ["s3:PutObject*", "s3:DeleteObject*"],
      Condition: { ArnNotEquals: { "aws:PrincipalArn": cdkRole("file-publishing") } },
    });
  });

  it("CloudFormation の TemplateBody の上限の 51,200 バイトに収まる", () => {
    const size = Buffer.byteLength(restrictBootstrapTemplate(STANDARD, { ...LONGEST, directRoleArns: [DIRECT_ROLE] }));
    expect(size).toBeLessThanOrEqual(51_200);
  });

  it.each([
    ["反映のロールに知らない文がある", (t: BootstrapTemplate) => {
      (t.Resources.DeploymentActionRole!.Properties.Policies as Array<{ PolicyDocument: Doc }>)[0]!.PolicyDocument.Statement.push({
        Sid: "NewPermissions",
        Effect: "Allow",
        Action: "cloudformation:SetStackPolicy",
        Resource: "*",
      });
    }],
    ["知っている文に操作が足された", (t: BootstrapTemplate) => {
      const doc = (t.Resources.DeploymentActionRole!.Properties.Policies as Array<{ PolicyDocument: Doc }>)[0]!.PolicyDocument;
      (doc.Statement[0]!.Action as string[]).push("cloudformation:SetStackPolicy");
    }],
    ["反映のロールに方針がもう 1 つある", (t: BootstrapTemplate) => {
      (t.Resources.DeploymentActionRole!.Properties.Policies as unknown[]).push({ PolicyName: "more" });
    }],
    ["信頼ポリシーに知らない主体がある", (t: BootstrapTemplate) => {
      trust(t, "FilePublishingRole").push({ Effect: "Allow", Action: "sts:AssumeRole", Principal: "*" });
    }],
    ["資源が無い", (t: BootstrapTemplate) => {
      delete t.Resources.StagingBucketPolicy;
    }],
  ])("%sテンプレートは例外にする", (_name, mutate) => {
    const standard = parse(STANDARD) as BootstrapTemplate;
    mutate(standard);
    expect(() => restrictBootstrapTemplate(JSON.stringify(standard), INPUT)).toThrow(/テンプレート/);
  });

  it("結果が 51,200 バイトを超えれば例外にする", () => {
    const standard = parse(STANDARD) as BootstrapTemplate & { Description: string };
    standard.Description = "x".repeat(51_200);
    expect(() => restrictBootstrapTemplate(JSON.stringify(standard), INPUT)).toThrow(/51200/);
  });
});
