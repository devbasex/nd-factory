import type { Settings } from "@nd-factory/contracts/settings";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { AppStack } from "../lib/app-stack.ts";
import {
  BASE_SETTINGS,
  GOOGLE_CLIENT_ID,
  PIPELINE_SETTINGS,
  TEST_ENV,
  hourlyCostResources,
  nameViolations,
  resources,
  tempWebDist,
  untaggedResources,
  withClientId,
} from "./support.ts";

type Built = { stack: AppStack; template: Template };

function build(s: Settings): Built {
  const app = new App();
  const stack = new AppStack(app, "acme-test-app", { env: TEST_ENV, settings: s, webDistPath: tempWebDist() });
  return { stack, template: Template.fromStack(stack) };
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
    const secret = onlyResource(built.template, "AWS::SecretsManager::Secret");
    expect(secret.props.SecretString).toBeUndefined();
    expect(secret.props.GenerateSecretString).toBeDefined();
    expect(JSON.stringify(built.template.toJSON())).not.toContain('"SecretString"');
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
  });
});

describe("AppStack の秘密の器", () => {
  it("器の論理 ID・名前・生成の設定は、接頭辞と環境のほかの設定の値で変わらない", () => {
    const variants: Settings[] = [
      BASE_SETTINGS,
      withClientId(BASE_SETTINGS),
      PIPELINE_SETTINGS,
      { ...PIPELINE_SETTINGS, pipeline: { repository: "example-org/other-app", branch: "release" } },
    ];
    const seen = variants.map((s) => {
      const secret = onlyResource(build(s).template, "AWS::SecretsManager::Secret");
      return JSON.stringify({ id: secret.id, props: secret.props });
    });
    expect(new Set(seen).size).toBe(1);
  });
});
