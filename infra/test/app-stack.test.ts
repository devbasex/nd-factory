import type { Settings } from "@nd-factory/contracts/settings";
import { App, type CfnElement } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { AppStack } from "../lib/app-stack.ts";
import {
  BASE_SETTINGS,
  GOOGLE_CLIENT_ID,
  PIPELINE_SETTINGS,
  TEST_ENV,
  INFRA_SETTINGS,
  hourlyCostResources,
  nameViolations,
  resources,
  stackRuleViolations,
  tempWebDist,
  untaggedResources,
  withClientId,
} from "./support.ts";

type Built = { stack: AppStack; template: Template; missing: unknown[] };

function build(s: Settings): Built {
  const app = new App();
  const stack = new AppStack(app, "acme-test-app", { env: TEST_ENV, settings: s, webDistPath: tempWebDist() });
  const template = Template.fromStack(stack);
  // 合成が求めた context の値（lookup）。1 つでもあれば CLI が cdk.context.json を作る
  const missing = app.synth().manifest.missing ?? [];
  return { stack, template, missing };
}

function secretNamed(template: Template, name: string): { id: string; props: Record<string, unknown> } {
  const found = Object.entries(resources(template)).filter(
    ([, r]) => r.Type === "AWS::SecretsManager::Secret" && r.Properties?.Name === name,
  );
  expect(found, name).toHaveLength(1);
  const [id, r] = found[0]!;
  return { id, props: r.Properties ?? {} };
}

function onlyResource(template: Template, type: string): { id: string; props: Record<string, unknown> } {
  const found = Object.entries(resources(template)).filter(([, r]) => r.Type === type);
  expect(found, type).toHaveLength(1);
  const [id, r] = found[0]!;
  return { id, props: r.Properties ?? {} };
}

describe("AppStack（client_id なし）", () => {
  let built: Built;
  beforeAll(() => {
    built = build(BASE_SETTINGS);
  });

  it("名前を持つ資源はすべて <prefix>-<environment>- で始まり、スタックの名前も同じ頭を持つ", () => {
    expect(built.stack.stackName).toBe("acme-test-app");
    expect(nameViolations(built.template, BASE_SETTINGS)).toEqual([]);
    built.template.hasResourceProperties("AWS::DynamoDB::GlobalTable", { TableName: "acme-test-accounts" });
    built.template.hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: "acme-test-login" });
    built.template.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "acme/test/google-oauth" });
  });

  it("すべての資源にタグ app-prefix と app-env が付く", () => {
    expect(untaggedResources(built.stack, BASE_SETTINGS)).toEqual([]);
  });

  it("時間で費用が掛かる資源を作らない", () => {
    expect(hourlyCostResources(built.template)).toEqual([]);
  });

  it("利用者の表は要求の数の課金で、pk と sk の文字列の鍵を持つ", () => {
    built.template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ]),
    });
  });

  it("経路の Lambda は表の名前を USERS_TABLE で受ける", () => {
    built.template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "acme-test-users-api",
      Environment: { Variables: { USERS_TABLE: Match.anyValue() } },
    });
  });

  it("Node の Lambda はどれも nodejs24.x で動く（束ねる依存の engines の下限を満たす。p-retry 9 は node>=22）", () => {
    const runtimes = Object.values(resources(built.template))
      .filter((r) => r.Type === "AWS::Lambda::Function")
      .map((r) => String(r.Properties?.Runtime))
      .filter((rt) => rt.startsWith("nodejs"));
    expect(runtimes.length).toBeGreaterThan(0);
    expect(new Set(runtimes)).toEqual(new Set(["nodejs24.x"]));
  });

  it("Google の IdP を作らず、アプリのクライアントは利用者プールの直のログインだけ", () => {
    built.template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
    built.template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      SupportedIdentityProviders: ["COGNITO"],
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: Match.arrayEquals(["openid", "email", "profile"]),
      GenerateSecret: false,
    });
    built.template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    expect(built.stack.webConfig.login_ready).toBe(false);
  });

  it("戻り先とログアウト先は配信の頁の根", () => {
    const { props } = onlyResource(built.template, "AWS::Cognito::UserPoolClient");
    const callback = JSON.stringify(props.CallbackURLs);
    expect(callback).toContain("https://");
    expect(callback).toContain("DomainName");
    expect(callback).toMatch(/"\/"\]/);
    expect(props.LogoutURLs).toEqual(props.CallbackURLs);
  });

  it("画面の設定の値は利用者プールのドメインの URL・API の URL・クライアントの ID を持つ", () => {
    const cfg = built.stack.resolve(built.stack.webConfig) as Record<string, unknown>;
    expect(cfg.authority).toBe("https://acme-test-login.auth.us-west-2.amazoncognito.com");
    expect(JSON.stringify(cfg.api_url)).toContain("ApiEndpoint");
    expect(JSON.stringify(cfg.client_id)).toContain("Ref");
    const deploy = onlyResource(built.template, "Custom::CDKBucketDeployment");
    expect(deploy.props.SourceMarkers).toBeDefined();
    expect(deploy.props.DistributionPaths).toEqual(["/*"]);
  });

  it("経路は PUT /v1/users の 1 本で、JWT の認可が付く", () => {
    const route = onlyResource(built.template, "AWS::ApiGatewayV2::Route");
    expect(route.props.RouteKey).toBe("PUT /v1/users");
    expect(route.props.AuthorizationType).toBe("JWT");
    const auth = onlyResource(built.template, "AWS::ApiGatewayV2::Authorizer");
    expect(auth.props.AuthorizerType).toBe("JWT");
    expect(auth.props.Name).toBe("acme-test-jwt");
    const jwt = auth.props.JwtConfiguration as { Issuer: unknown; Audience: unknown[] };
    expect(JSON.stringify(jwt.Issuer)).toContain("https://cognito-idp.us-west-2.amazonaws.com/");
    expect(jwt.Audience).toHaveLength(1);
    expect(JSON.stringify(jwt.Audience)).toContain("Ref");
  });

  it("CORS は配信の頁の元だけ", () => {
    const api = onlyResource(built.template, "AWS::ApiGatewayV2::Api");
    const cors = api.props.CorsConfiguration as { AllowOrigins: unknown[]; AllowMethods: string[] };
    expect(cors.AllowOrigins).toHaveLength(1);
    expect(JSON.stringify(cors.AllowOrigins)).toContain("DomainName");
    expect(cors.AllowMethods).toEqual(["PUT"]);
  });

  it("画面の置き場は公開せず、配信は OAC で読む", () => {
    built.template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    built.template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({ Name: "acme-test-web", OriginAccessControlOriginType: "s3" }),
    });
    built.template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ DefaultRootObject: "index.html" }),
    });
  });

  it("合成の出力に秘密の値が無い（器は自動で作る値の設定だけを持つ）", () => {
    const secrets = Object.values(resources(built.template)).filter((r) => r.Type === "AWS::SecretsManager::Secret");
    expect(secrets.map((r) => r.Properties?.Name).sort()).toEqual(["acme/test/google-oauth", "acme/test/progress-db-admin"]);
    for (const secret of secrets) {
      expect(secret.Properties?.SecretString).toBeUndefined();
      expect(secret.Properties?.GenerateSecretString).toBeDefined();
    }
    expect(JSON.stringify(built.template.toJSON())).not.toContain('"SecretString"');
  });

  it("ネットワーク・進行表の DB・ECS のクラスタ・予算が app のスタックにある（受け入れ条件 4）", () => {
    built.template.resourceCountIs("AWS::EC2::VPC", 1);
    built.template.resourceCountIs("AWS::RDS::DBCluster", 1);
    built.template.resourceCountIs("AWS::ECS::Cluster", 1);
    built.template.resourceCountIs("AWS::Budgets::Budget", 1);
    built.template.resourceCountIs("AWS::SNS::Topic", 1);
    built.template.hasResourceProperties("AWS::EC2::VPC", { CidrBlock: "10.80.0.0/16" });
  });

  it("DB の用意の関数が app のスタックにあり、スタックの進行表の DB を指し、DynamoDB の権限を持たない（受け入れ条件 4）", () => {
    const { stack, template } = built;
    const fnId = stack.getLogicalId(stack.dbPrep.fn.node.defaultChild as CfnElement);
    const fn = resources(template)[fnId]!;
    expect(fn.Properties?.FunctionName).toBe("acme-test-db-prep");
    expect(fn.Properties?.VpcConfig).toBeUndefined();
    const clusterId = stack.getLogicalId(stack.progressDb.cluster.node.defaultChild as CfnElement);
    const vars = (fn.Properties?.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(JSON.stringify(vars.DB_PREP_CLUSTER_ARN)).toContain(JSON.stringify({ Ref: clusterId }));
    expect(vars.DB_PREP_SECRET_PREFIX).toBe("acme/test/progress-db/");
    // 終わりの記録の口の権限は #6 が grantCompletionAccess で足す。この課題の版は足さない
    const roleId = stack.getLogicalId(stack.dbPrep.fn.role!.node.defaultChild as CfnElement);
    const policies = Object.values(resources(template)).filter(
      (r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties?.Roles ?? []).includes(`"${roleId}"`),
    );
    expect(policies.length).toBeGreaterThan(0);
    expect(JSON.stringify(policies)).not.toContain("dynamodb:");
  });

  it("サブネットの AZ は Fn::GetAZs の先頭の 2 つで、合成は AZ の lookup を求めない（cdk.context.json を作らない）", () => {
    const subnets = Object.values(resources(built.template)).filter((r) => r.Type === "AWS::EC2::Subnet");
    const azs = subnets.map((r) => JSON.stringify(r.Properties?.AvailabilityZone)).sort();
    const select = (i: number) => JSON.stringify({ "Fn::Select": [i, { "Fn::GetAZs": "" }] });
    expect(azs).toEqual([select(0), select(0), select(1), select(1)]);
    expect(built.missing).toEqual([]);
  });

  it("スタックの決まりの 8 つをどれも破らない", () => {
    expect(stackRuleViolations(built.template)).toEqual([]);
  });

  it("タスクの役割にインラインとマネージドのどちらの許可の文も無い（I11）", () => {
    const roleId = built.stack.getLogicalId(built.stack.tasks.taskRole.node.defaultChild as CfnElement);
    const role = resources(built.template)[roleId]!;
    expect(role.Properties?.Policies).toBeUndefined();
    expect(role.Properties?.ManagedPolicyArns).toBeUndefined();
    const attached = Object.values(resources(built.template)).filter(
      (r) => (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") && JSON.stringify(r.Properties?.Roles ?? []).includes(roleId),
    );
    expect(attached).toEqual([]);
  });

  it("利用者の表は PITR を持ち、表と画面の置き場はスタックを消しても残る", () => {
    const table = onlyResource(built.template, "AWS::DynamoDB::GlobalTable");
    expect(table.props.Replicas).toEqual([
      expect.objectContaining({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }),
    ]);
    built.template.hasResource("AWS::DynamoDB::GlobalTable", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    built.template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });
});

describe("AppStack（client_id あり）", () => {
  let built: Built;
  beforeAll(() => {
    built = build(withClientId(BASE_SETTINGS));
  });

  it("Google の IdP を作り、secret は器への動的な参照で渡す", () => {
    const idp = onlyResource(built.template, "AWS::Cognito::UserPoolIdentityProvider");
    expect(idp.props.ProviderType).toBe("Google");
    const details = idp.props.ProviderDetails as Record<string, unknown>;
    expect(details.client_id).toBe(GOOGLE_CLIENT_ID);
    expect(details.authorize_scopes).toBe("openid email profile");
    expect(JSON.stringify(details.client_secret)).toContain("{{resolve:secretsmanager:");
    expect(JSON.stringify(built.template.toJSON())).not.toContain('"SecretString"');
  });

  it("アプリのクライアントは Google だけを受け、画面はログインの準備ができている", () => {
    built.template.hasResourceProperties("AWS::Cognito::UserPoolClient", { SupportedIdentityProviders: ["Google"] });
    // クライアントは IdP ができた後に作る。先に作ると Google を受けられない
    const idp = onlyResource(built.template, "AWS::Cognito::UserPoolIdentityProvider");
    const client = Object.values(built.template.toJSON().Resources as Record<string, { Type: string; DependsOn?: string[] }>).find(
      (r) => r.Type === "AWS::Cognito::UserPoolClient",
    );
    expect(client?.DependsOn).toContain(idp.id);
    expect(built.stack.webConfig.login_ready).toBe(true);
  });

  it("名前・タグ・費用の決まりは client_id があっても同じ", () => {
    expect(nameViolations(built.template, BASE_SETTINGS)).toEqual([]);
    expect(untaggedResources(built.stack, BASE_SETTINGS)).toEqual([]);
    expect(hourlyCostResources(built.template)).toEqual([]);
    expect(stackRuleViolations(built.template)).toEqual([]);
  });
});

describe("AppStack（インフラのキーあり）", () => {
  let built: Built;
  beforeAll(() => {
    built = build(INFRA_SETTINGS);
  });

  it("設定のファイルの値で VPC の範囲・最大 ACU・予算の額と範囲・宛先が変わる", () => {
    built.template.hasResourceProperties("AWS::EC2::VPC", { CidrBlock: "10.20.0.0/20" });
    built.template.hasResourceProperties("AWS::RDS::DBCluster", {
      ServerlessV2ScalingConfiguration: Match.objectLike({ MaxCapacity: 16 }),
    });
    const budget = onlyResource(built.template, "AWS::Budgets::Budget").props.Budget as Record<string, unknown>;
    expect(budget.BudgetLimit).toEqual({ Amount: 100, Unit: "USD" });
    expect(budget.FilterExpression).toBeUndefined();
    built.template.resourceCountIs("AWS::SNS::Subscription", 2);
    // 名前・タグ・費用・スタックの決まりは同じ
    expect(nameViolations(built.template, INFRA_SETTINGS)).toEqual([]);
    expect(untaggedResources(built.stack, INFRA_SETTINGS)).toEqual([]);
    expect(hourlyCostResources(built.template)).toEqual([]);
    expect(stackRuleViolations(built.template)).toEqual([]);
  });
});

describe("AppStack の秘密の器", () => {
  it("器の論理 ID・名前・生成の設定は、接頭辞と環境のほかの設定の値で変わらない", () => {
    const variants: Settings[] = [
      BASE_SETTINGS,
      withClientId(BASE_SETTINGS),
      PIPELINE_SETTINGS,
      { ...PIPELINE_SETTINGS, pipeline: { repository: "example-org/other-app", branch: "release" } },
      INFRA_SETTINGS,
    ];
    for (const name of ["acme/test/google-oauth", "acme/test/progress-db-admin"]) {
      const seen = variants.map((s) => {
        const secret = secretNamed(build(s).template, name);
        return JSON.stringify({ id: secret.id, props: secret.props });
      });
      expect(new Set(seen).size, name).toBe(1);
    }
  });
});
