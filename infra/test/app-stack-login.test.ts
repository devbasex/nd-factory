import type { Settings } from "@nd-factory/contracts/settings";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { AppStack } from "../lib/app-stack.ts";
import { BASE_SETTINGS, GOOGLE_CLIENT_ID, TEST_ENV, tempWebDist, withClientId } from "./support.ts";

// Google と Cognito のログインの資源の今の形を固定する。
// 構築の置き場を変えても、論理 ID・プロパティ・資源の間の参照が変わらないことを確かめる
// （論理 ID が変わると、反映で利用者プールや秘密の器が作り直され、利用者や人が入れた値を失う）

type CfnResource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string[];
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
};
type Built = { stack: AppStack; resources: Record<string, CfnResource> };

function build(s: Settings): Built {
  const stack = new AppStack(new App(), "acme-test-app", { env: TEST_ENV, settings: s, webDistPath: tempWebDist() });
  return { stack, resources: Template.fromStack(stack).toJSON().Resources as Record<string, CfnResource> };
}

const LOGIN_TYPES = [
  "AWS::Cognito::UserPool",
  "AWS::Cognito::UserPoolDomain",
  "AWS::Cognito::UserPoolClient",
  "AWS::Cognito::UserPoolIdentityProvider",
  "AWS::SecretsManager::Secret",
];

function loginIds(b: Built): Record<string, string> {
  return Object.fromEntries(
    Object.entries(b.resources)
      .filter(([, r]) => LOGIN_TYPES.includes(r.Type))
      .map(([id, r]) => [id, r.Type]),
  );
}

const SECRET = {
  Type: "AWS::SecretsManager::Secret",
  Properties: {
    Description: "Google の OAuth クライアントの secret。人が本物の値を入れる",
    GenerateSecretString: { ExcludePunctuation: true, PasswordLength: 32 },
    Name: "acme/test/google-oauth",
    Tags: [
      { Key: "app-env", Value: "test" },
      { Key: "app-prefix", Value: "acme" },
    ],
  },
  UpdateReplacePolicy: "Delete",
  DeletionPolicy: "Delete",
};

const DOMAIN = {
  Type: "AWS::Cognito::UserPoolDomain",
  Properties: { Domain: "acme-test-login", UserPoolId: { Ref: "UserPool6BA7E5F2" } },
};

const WEB_ROOT = { "Fn::Join": ["", ["https://", { "Fn::GetAtt": ["WebDistribution59C46482", "DomainName"] }, "/"]] };

function clientProps(provider: string): Record<string, unknown> {
  return {
    AllowedOAuthFlows: ["code"],
    AllowedOAuthFlowsUserPoolClient: true,
    AllowedOAuthScopes: ["openid", "email", "profile"],
    CallbackURLs: [WEB_ROOT],
    ClientName: "acme-test-web",
    GenerateSecret: false,
    LogoutURLs: [WEB_ROOT],
    PreventUserExistenceErrors: "ENABLED",
    SupportedIdentityProviders: [provider],
    UserPoolId: { Ref: "UserPool6BA7E5F2" },
  };
}

function expectUserPool(b: Built): void {
  const pool = b.resources.UserPool6BA7E5F2;
  expect(pool?.Type).toBe("AWS::Cognito::UserPool");
  expect(pool?.DeletionPolicy).toBe("Retain");
  expect(pool?.UpdateReplacePolicy).toBe("Retain");
  expect(pool?.Properties).toMatchObject({
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    AutoVerifiedAttributes: ["email"],
    UserPoolName: "acme-test-users",
    UserPoolTags: { "app-env": "test", "app-prefix": "acme" },
    UsernameAttributes: ["email"],
  });
}

function expectApiRefs(b: Built): void {
  // JWT の認可は利用者プールを発行元に、アプリのクライアントを受け手に持つ
  const auth = Object.values(b.resources).find((r) => r.Type === "AWS::ApiGatewayV2::Authorizer");
  expect(auth?.Properties?.JwtConfiguration).toEqual({
    Audience: [{ Ref: "UserPoolWebClient4C9370B0" }],
    Issuer: { "Fn::Join": ["", ["https://cognito-idp.us-west-2.amazonaws.com/", { Ref: "UserPool6BA7E5F2" }]] },
  });
}

describe("AppStack のログインの資源（client_id なし）", () => {
  let b: Built;
  beforeAll(() => {
    b = build(BASE_SETTINGS);
  });

  it("ログインの資源は利用者プール・ドメイン・クライアント・秘密の器の 4 つで、論理 ID が決まっている", () => {
    expect(loginIds(b)).toEqual({
      GoogleOAuthSecret963EF6DE: "AWS::SecretsManager::Secret",
      UserPool6BA7E5F2: "AWS::Cognito::UserPool",
      UserPoolLoginDomain7848D1BF: "AWS::Cognito::UserPoolDomain",
      UserPoolWebClient4C9370B0: "AWS::Cognito::UserPoolClient",
    });
  });

  it("秘密の器・利用者プール・ドメインのプロパティと消すときの扱い", () => {
    expect(b.resources.GoogleOAuthSecret963EF6DE).toEqual(SECRET);
    expectUserPool(b);
    expect(b.resources.UserPoolLoginDomain7848D1BF).toEqual(DOMAIN);
  });

  it("アプリのクライアントは利用者プールの直のログインを受け、何にも依らない", () => {
    expect(b.resources.UserPoolWebClient4C9370B0).toEqual({
      Type: "AWS::Cognito::UserPoolClient",
      Properties: clientProps("COGNITO"),
    });
  });

  it("API の認可と画面の設定の値は利用者プールとクライアントを指す", () => {
    expectApiRefs(b);
    expect(b.stack.resolve(b.stack.webConfig)).toEqual({
      api_url: { "Fn::GetAtt": ["ApiF70053CD", "ApiEndpoint"] },
      authority: "https://acme-test-login.auth.us-west-2.amazoncognito.com",
      client_id: { Ref: "UserPoolWebClient4C9370B0" },
      login_ready: false,
    });
  });
});

describe("AppStack のログインの資源（client_id あり）", () => {
  let b: Built;
  beforeAll(() => {
    b = build(withClientId(BASE_SETTINGS));
  });

  it("ログインの資源に Google の IdP が加わり、ほかの論理 ID は client_id なしと同じ", () => {
    expect(loginIds(b)).toEqual({
      GoogleIdp206FECA7: "AWS::Cognito::UserPoolIdentityProvider",
      GoogleOAuthSecret963EF6DE: "AWS::SecretsManager::Secret",
      UserPool6BA7E5F2: "AWS::Cognito::UserPool",
      UserPoolLoginDomain7848D1BF: "AWS::Cognito::UserPoolDomain",
      UserPoolWebClient4C9370B0: "AWS::Cognito::UserPoolClient",
    });
  });

  it("秘密の器・利用者プール・ドメインは client_id なしと同じ", () => {
    expect(b.resources.GoogleOAuthSecret963EF6DE).toEqual(SECRET);
    expectUserPool(b);
    expect(b.resources.UserPoolLoginDomain7848D1BF).toEqual(DOMAIN);
  });

  it("Google の IdP は client_id と秘密の器への動的な参照を持ち、email を写す", () => {
    expect(b.resources.GoogleIdp206FECA7).toEqual({
      Type: "AWS::Cognito::UserPoolIdentityProvider",
      Properties: {
        AttributeMapping: { email: "email" },
        ProviderDetails: {
          client_id: GOOGLE_CLIENT_ID,
          client_secret: {
            "Fn::Join": ["", ["{{resolve:secretsmanager:", { Ref: "GoogleOAuthSecret963EF6DE" }, ":SecretString:::}}"]],
          },
          authorize_scopes: "openid email profile",
        },
        ProviderName: "Google",
        ProviderType: "Google",
        UserPoolId: { Ref: "UserPool6BA7E5F2" },
      },
    });
  });

  it("アプリのクライアントは Google だけを受け、IdP の後に作る", () => {
    expect(b.resources.UserPoolWebClient4C9370B0).toEqual({
      Type: "AWS::Cognito::UserPoolClient",
      Properties: clientProps("Google"),
      DependsOn: ["GoogleIdp206FECA7"],
    });
  });

  it("API の認可と画面の設定の値は利用者プールとクライアントを指し、ログインの準備ができている", () => {
    expectApiRefs(b);
    expect(b.stack.resolve(b.stack.webConfig)).toEqual({
      api_url: { "Fn::GetAtt": ["ApiF70053CD", "ApiEndpoint"] },
      authority: "https://acme-test-login.auth.us-west-2.amazoncognito.com",
      client_id: { Ref: "UserPoolWebClient4C9370B0" },
      login_ready: true,
    });
  });
});
