import { createHash } from "node:crypto";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAssembly, checkTemplateRoles, checkTemplateStage, checkTemplateTransforms } from "../lib/assembly-check.ts";
import {
  BOUNDARY_ARN,
  BUCKET,
  GUARD,
  ACCOUNT_ARN,
  type Manifest,
  cdkRole,
  mutated,
  readJsonFile,
  realAssembly,
  stackProps,
} from "./guard-support.ts";

type Assets = {
  files: Record<string, { source: Record<string, unknown>; destinations: Record<string, Record<string, string>> }>;
  dockerImages?: Record<string, unknown>;
};
type CfnTemplate = { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> };

const firstAsset = (a: Assets) => Object.values(a.files).find((f) => String(f.source.path).startsWith("asset."))!;
const appTemplate = () => readJsonFile<CfnTemplate>(join(realAssembly(), "acme-test-app.template.json"));

describe("checkAssembly", () => {
  it("NodejsFunction を含む実際のアプリのスタックの合成を受け入れる（ほかのアセットは .zip）", () => {
    const checked = checkAssembly(realAssembly(), GUARD);
    expect(checked.templateFile).toBe("acme-test-app.template.json");
    const body = readFileSync(join(realAssembly(), checked.templateFile));
    expect(checked.templateKey).toBe(`${createHash("sha256").update(body).digest("hex")}.json`);
    expect(checked.requiredBootstrapVersion).toBeGreaterThanOrEqual(6);
  });

  const manifest = (mutate: (m: Manifest) => void) => () => mutated<Manifest>("manifest.json", mutate);
  const assets = (mutate: (a: Assets, dir: string) => void) => () => mutated<Assets>("acme-test-app.assets.json", mutate);

  it.each([
    ["executable を持つアセット", assets((a) => (firstAsset(a).source.executable = ["sh", "-c", "true"])), /executable/],
    [
      "コンテナのイメージのアセット",
      assets((a) => (a.dockerImages = { x: { source: {}, destinations: {} } })),
      /イメージ/,
    ],
    ["合成の結果の外を指すパス", assets((a) => (firstAsset(a).source.path = "../secret")), /外を指す/],
    ["絶対パス", assets((a) => (firstAsset(a).source.path = "/etc/passwd")), /外を指す/],
    [
      "リンクを含むアセット",
      assets((a, dir) => symlinkSync("/etc", join(dir, String(firstAsset(a).source.path), "link"))),
      /リンク/,
    ],
    [
      "別のバケットへの置き先",
      assets((a) => (Object.values(firstAsset(a).destinations)[0]!.bucketName = "cdk-hnb659fds-assets-123456789012-us-west-2")),
      /バケット/,
    ],
    ["ほかのアセットの .json のキー", assets((a) => (Object.values(firstAsset(a).destinations)[0]!.objectKey = "x.json")), /\.json/],
    [
      "別のスタック",
      manifest((m) => (m.artifacts["acme-test-pipeline"] = m.artifacts["acme-test-app"]!)),
      /スタックが 1 つでない/,
    ],
    [
      "名前の違うスタック",
      manifest((m) => (stackProps(m).stackName = "acme-test-pipeline")),
      /アプリのスタックでない/,
    ],
    ["許可していない種類の成果物", manifest((m) => (m.artifacts.other = { type: "cdk:cloud-assembly", properties: {} })), /種類/],
    [
      "スタックが依存しないマニフェスト",
      manifest((m) => (m.artifacts["acme-test-app"]!.dependencies = [])),
      /依存しない/,
    ],
    [
      "別の実行のロール",
      manifest((m) => (stackProps(m).cloudFormationExecutionRoleArn = cdkRole("cfn-exec", "hnb659fds"))),
      /実行のロール/,
    ],
    ["別の反映のロール", manifest((m) => (stackProps(m).assumeRoleArn = cdkRole("deploy", "hnb659fds"))), /反映のロール/],
    [
      "差し替えた URL",
      manifest((m) => (stackProps(m).stackTemplateAssetObjectUrl = `s3://${BUCKET}/${"0".repeat(64)}.json`)),
      /URL/,
    ],
    ["URL が無い", manifest((m) => delete stackProps(m).stackTemplateAssetObjectUrl), /URL/],
    [
      "キーと中身の不一致",
      () => mutated<CfnTemplate>("acme-test-app.template.json", (t) => (t.Resources.Extra = { Type: "AWS::SNS::Topic" })),
      /SHA-256/,
    ],
  ] as Array<[string, () => string, RegExp]>)("%sを拒む", (_name, make, message) => {
    expect(() => checkAssembly(make(), GUARD)).toThrow(message);
  });
});

// 検査を分けても変わらないことを固定する: 既定値・版の選び方・断る順
describe("checkAssembly の今の振る舞い", () => {
  const STACK = "acme-test-app";
  const ASSETS = "acme-test-app.assets";
  const TEMPLATE = "acme-test-app.template.json";
  type Edit = (m: Manifest, a: Assets) => void;
  // マニフェストとアセットの定義の両方を書き換えた写し
  const both = (edit: Edit) =>
    mutated<Manifest>("manifest.json", (m, dir) => {
      const file = join(dir, `${ASSETS}.json`);
      const a = readJsonFile<Assets>(file);
      edit(m, a);
      writeFileSync(file, JSON.stringify(a));
    });
  const templateAsset = (a: Assets) => Object.values(a.files).find((f) => f.source.path === TEMPLATE)!;
  const versions = (stack: unknown, assetManifest: unknown) => (m: Manifest) => {
    m.artifacts[STACK]!.properties.requiresBootstrapStackVersion = stack;
    m.artifacts[ASSETS]!.properties.requiresBootstrapStackVersion = assetManifest;
  };

  it("stackName が無ければ成果物の ID をスタックの名前にする", () => {
    const dir = both((m) => delete stackProps(m).stackName);
    expect(checkAssembly(dir, GUARD).templateFile).toBe(TEMPLATE);
  });

  it.each([
    ["スタックの値が大きい", 9, 7, 9],
    ["マニフェストの値が大きい", 7, 11, 11],
    ["スタックの値が数でない", "20", 7, 7],
    ["マニフェストの値が無い", 8, undefined, 8],
  ])("bootstrap の版は大きいほうの数（%s）", (_name, stack, assetManifest, expected) => {
    const dir = both(versions(stack, assetManifest));
    expect(checkAssembly(dir, GUARD).requiredBootstrapVersion).toBe(expected);
  });

  it.each([
    ["どちらも無い", undefined, undefined],
    ["どちらも 0", 0, 0],
    ["どちらも数でない", "6", "6"],
  ])("bootstrap の版が%sなら拒む", (_name, stack, assetManifest) => {
    expect(() => checkAssembly(both(versions(stack, assetManifest)), GUARD)).toThrow("求める bootstrap の版が分からない");
  });

  it.each([
    ["スタックが無い", (m) => delete m.artifacts[STACK], "スタックが 1 つでない（0 個）"],
    ["実行のロールが無い", (m) => delete stackProps(m).cloudFormationExecutionRoleArn, "実行のロール"],
    ["反映のロールが文字列でない", (m) => (stackProps(m).assumeRoleArn = 1), "反映のロール"],
    ["アセットのマニフェストが無い", (m) => delete m.artifacts[ASSETS], "テンプレートの URL とアセットの置き先が違う"],
    ["テンプレートのファイル名が無い", (m) => delete stackProps(m).templateFile, "テンプレートのファイル名が無い"],
    ["アセットの定義の知らないキー", (_m, a) => Object.assign(a, { extra: 1 }), "知らないキーがある: extra"],
    ["置き先の無いアセット", (_m, a) => (templateAsset(a).destinations = {}), "に置き先が無い"],
    ["置き先のキーが無いアセット", (_m, a) => delete Object.values(templateAsset(a).destinations)[0]!.objectKey, "置き先のキーが無い"],
    [
      "テンプレートのアセットが 2 つ",
      (_m, a) => (a.files.copy = templateAsset(a)),
      "テンプレートの URL とアセットの置き先が違う",
    ],
    [
      "テンプレートのアセットに別の置き先がある",
      (_m, a) => {
        const d = templateAsset(a).destinations;
        d.other = { ...Object.values(d)[0]!, objectKey: "other.json" };
      },
      "テンプレートの URL とアセットの置き先が違う",
    ],
    // ここから下は、違反が重なるときにどちらで断るか
    [
      "名前とロールの違反が重なる",
      (m) => Object.assign(stackProps(m), { stackName: "x", cloudFormationExecutionRoleArn: "x" }),
      "アプリのスタックでない",
    ],
    [
      "2 つのロールの違反が重なる",
      (m) => Object.assign(stackProps(m), { cloudFormationExecutionRoleArn: "x", assumeRoleArn: "x" }),
      "実行のロール",
    ],
    [
      "ロールと依存の違反が重なる",
      (m) => {
        stackProps(m).assumeRoleArn = "x";
        m.artifacts[STACK]!.dependencies = [];
      },
      "反映のロール",
    ],
    [
      "依存とアセットの違反が重なる",
      (m, a) => {
        m.artifacts[STACK]!.dependencies = [];
        Object.assign(a, { extra: 1 });
      },
      "依存しない",
    ],
    [
      "アセットとテンプレートの違反が重なる",
      (m, a) => {
        delete stackProps(m).templateFile;
        Object.assign(a, { extra: 1 });
      },
      "知らないキー",
    ],
    [
      "テンプレートの URL と bootstrap の版の違反が重なる",
      (m) => {
        stackProps(m).stackTemplateAssetObjectUrl = "x";
        versions(0, 0)(m);
      },
      "テンプレートの URL がアプリ専用のバケット",
    ],
    [
      "ほかの .json のキーと bootstrap の版の違反が重なる",
      (m, a) => {
        Object.values(firstAsset(a).destinations)[0]!.objectKey = "x.json";
        versions(0, 0)(m);
      },
      "テンプレートのほかに .json",
    ],
  ] as Array<[string, Edit, string]>)("%s", (_name, edit, message) => {
    expect(() => checkAssembly(both(edit), GUARD)).toThrow(message);
  });
});

describe("checkTemplateStage", () => {
  type Env = { Environment?: { Variables?: Record<string, string> } };
  const fn = (stage?: string) => ({
    Type: "AWS::Lambda::Function",
    Properties: { Environment: { Variables: stage === undefined ? {} : { ND_CONFIRMATION_STAGE: stage } } },
  });
  const template = (api?: string, authorizer?: string, extra: Record<string, unknown> = {}) => ({
    Resources: {
      ApiFn: fn(api),
      AuthFn: fn(authorizer),
      Alias: { Type: "AWS::Lambda::Alias", Properties: { FunctionName: { Ref: "ApiFn" } } },
      Integration: { Type: "AWS::ApiGatewayV2::Integration", Properties: { IntegrationUri: { Ref: "Alias" } } },
      Authorizer: {
        Type: "AWS::ApiGatewayV2::Authorizer",
        Properties: {
          AuthorizerType: "REQUEST",
          AuthorizerUri: { "Fn::Join": ["", ["arn:", { "Fn::GetAtt": ["AuthFn", "Arn"] }, "/invocations"]] },
        },
      },
      ...extra,
    },
  });

  it("全部の関数が ai なら、ai の期待を通る", () => {
    expect(checkTemplateStage(template("ai", "ai"), "ai")).toEqual([]);
  });

  it("human の期待は、未設定と human を通す", () => {
    expect(checkTemplateStage(template(undefined, "human"), "human")).toEqual([]);
    expect(checkTemplateStage(appTemplate(), "human")).toEqual([]);
  });

  it.each([
    ["ai の期待で全部が未設定", template(), "ai"],
    ["ai の期待で API の関数だけが未設定", template(undefined, "ai"), "ai"],
    ["ai の期待でオーソライザーの関数だけが未設定", template("ai"), "ai"],
    ["ai の期待で値が違う", template("ai", "human"), "ai"],
    ["human の期待に ai が 1 つある", template(undefined, "ai"), "human"],
    ["対象でない資源の違う値", template("ai", "ai", { Other: fn("human") }), "ai"],
    [
      "呼び出し先を結び付けられない統合",
      template(undefined, undefined, {
        External: { Type: "AWS::ApiGatewayV2::Integration", Properties: { IntegrationUri: "https://example.com" } },
      }),
      "human",
    ],
    ["統合が 1 つも無い", { Resources: { ApiFn: fn("ai") } }, "ai"],
  ] as Array<[string, unknown, "ai" | "human"]>)("%sは違反", (_name, t, expected) => {
    expect(checkTemplateStage(t, expected)).not.toEqual([]);
  });

  it("実際のアプリの合成に ai を期待すると、未設定の関数が違反になる", () => {
    const functions = Object.values(appTemplate().Resources).filter((r) => r.Type === "AWS::Lambda::Function");
    expect(functions.some((r) => (r.Properties as Env).Environment?.Variables?.ND_CONFIRMATION_STAGE)).toBe(false);
    expect(checkTemplateStage(appTemplate(), "ai")).not.toEqual([]);
  });
});

describe("checkTemplateRoles", () => {
  const role = (over: Record<string, unknown> = {}) => ({
    Type: "AWS::IAM::Role",
    Properties: {
      PermissionsBoundary: BOUNDARY_ARN,
      AssumeRolePolicyDocument: {
        Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "lambda.amazonaws.com" } }],
      },
      ...over,
    },
  });
  const trust = (Principal: unknown) => ({ AssumeRolePolicyDocument: { Statement: [{ Effect: "Allow", Principal }] } });
  const check = (r: unknown) => checkTemplateRoles({ Resources: { R: r } }, BOUNDARY_ARN);

  it("境界を持ちサービスだけを信頼するロールと、実際のアプリの合成は違反が無い", () => {
    expect(check(role())).toEqual([]);
    expect(checkTemplateRoles(appTemplate(), BOUNDARY_ARN)).toEqual([]);
    expect(checkTemplateRoles({ Resources: {} }, BOUNDARY_ARN)).toEqual([]);
  });

  it.each([
    ["境界が無い", role({ PermissionsBoundary: undefined })],
    ["違う境界", role({ PermissionsBoundary: `${ACCOUNT_ARN}:policy/other` })],
    ["AWS の主体を信頼する", role(trust({ AWS: `${ACCOUNT_ARN}:root` }))],
    ["サービスと AWS の主体を信頼する", role(trust({ Service: "lambda.amazonaws.com", AWS: "*" }))],
    ["誰でも信頼する", role(trust("*"))],
    ["ユーザー", { Type: "AWS::IAM::User" }],
    ["グループ", { Type: "AWS::IAM::Group" }],
    ["アクセスキー", { Type: "AWS::IAM::AccessKey" }],
  ])("%sは違反", (_name, r) => {
    expect(check(r)).toHaveLength(1);
  });
});

describe("checkTemplateTransforms", () => {
  it("実際のアプリの合成は違反が無い", () => {
    expect(checkTemplateTransforms(appTemplate())).toEqual([]);
  });

  it.each([
    ["Transform", { Transform: "AWS::LanguageExtensions", Resources: {} }],
    ["Fn::Transform", { Resources: { R: { Properties: { "Fn::Transform": { Name: "AWS::Include" } } } } }],
  ])("%s があれば違反", (_name, template) => {
    expect(checkTemplateTransforms(template)).toHaveLength(1);
  });
});
