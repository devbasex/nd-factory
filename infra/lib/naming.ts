import { createHash } from "node:crypto";
import type { Settings } from "@nd-factory/contracts/settings";
import { Tags } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

// 資源の名前・秘密の器の名前・タグの作り方。名前とタグを設定の接頭辞と環境から作り、
// ほかのサービスや旧い側の資源と費用を分けて読めるようにする

type Naming = Pick<Settings, "prefix" | "environment">;

export type StackKey = "app" | "pipeline";

// スタックの並びの正本。確認の値もこの順に並べる
export const STACK_KEYS: readonly StackKey[] = ["app", "pipeline"];

// 費用を分けて読むタグのキー。値は接頭辞と環境の名前
export const TAG_KEYS = ["app-prefix", "app-env"] as const;

const USE_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function checkUse(use: string): void {
  if (!USE_SHAPE.test(use)) throw new Error(`資源の用途は小文字の英数字とハイフンにする: ${JSON.stringify(use)}`);
}

export function resourceName(s: Naming, use: string): string {
  checkUse(use);
  return `${s.prefix}-${s.environment}-${use}`;
}

export function secretName(s: Naming, use: string): string {
  checkUse(use);
  return `${s.prefix}/${s.environment}/${use}`;
}

// 運用する環境の設定のファイルの正本を置く SSM のパラメーター
export function settingsParameterName(s: Naming): string {
  return `/${secretName(s, "settings")}`;
}

// 商用利用の開始を宣言した記録を置く SSM のパラメーター。反映の直前の検査が有無を読む
export function launchDeclaredParameterName(s: Naming): string {
  return `/${secretName(s, "launch-declared")}`;
}

export function stackName(s: Naming, key: StackKey): string {
  return resourceName(s, key);
}

export function applyTags(scope: IConstruct, s: Naming): void {
  const [prefixKey, envKey] = TAG_KEYS;
  Tags.of(scope).add(prefixKey, s.prefix);
  Tags.of(scope).add(envKey, s.environment);
}

// アプリのスタックが名前を付ける資源。設置のコマンドもここから名前を出す
export type AppResourceNames = ReturnType<typeof appResourceNames>;

export function appResourceNames(s: Naming) {
  return {
    userPool: resourceName(s, "users"),
    loginDomain: resourceName(s, "login"),
    webClient: resourceName(s, "web"),
    webOriginAccess: resourceName(s, "web"),
    distributionComment: resourceName(s, "web"),
    usersTable: resourceName(s, "accounts"),
    usersFunction: resourceName(s, "users-api"),
    api: resourceName(s, "api"),
    jwtAuthorizer: resourceName(s, "jwt"),
    googleSecret: secretName(s, "google-oauth"),
    vpc: resourceName(s, "vpc"),
    taskSecurityGroup: resourceName(s, "task-sg"),
    dbSecurityGroup: resourceName(s, "db-sg"),
    runnerCluster: resourceName(s, "runner"),
    runnerLogGroup: resourceName(s, "runner"),
    // #6 が作るランナーのイメージのリポジトリの名前の形。タスクの実行の役割はこの形のリポジトリだけを引ける
    imageRepositories: `${s.prefix}-${s.environment}-*`,
    progressDb: resourceName(s, "progress-db"),
    progressDbAdminSecret: secretName(s, "progress-db-admin"),
    dbPrepFunction: resourceName(s, "db-prep"),
    dbPrepLogGroup: resourceName(s, "db-prep"),
    opsTopic: resourceName(s, "ops"),
    budget: resourceName(s, "budget"),
  };
}

// 反映のパイプラインのスタックが名前を付ける資源
export function pipelineResourceNames(s: Naming) {
  return {
    connection: resourceName(s, "github"),
    pipeline: resourceName(s, "pipeline"),
    prepareProject: resourceName(s, "prepare"),
    deployProject: resourceName(s, "deploy"),
    notifyTopic: resourceName(s, "notify"),
    failedRule: resourceName(s, "pipeline-failed"),
    settingsParameter: settingsParameterName(s),
  };
}

// 反映のパイプラインがアプリのスタックを反映する bootstrap の qualifier。設置ごとに分け、
// 同じアカウントとリージョンの別の設置のスタックを書き換えられないようにする。CDK の上限の 10 文字に収める
export function appQualifier(s: Naming): string {
  return `nd${createHash("sha256").update(`${s.prefix}/${s.environment}`).digest("hex").slice(0, 8)}`;
}

// アプリ専用の bootstrap のスタックと、そのテンプレートが作る管理ポリシーの名前
export function appBootstrapNames(s: Naming) {
  return {
    stack: resourceName(s, "bootstrap"),
    executionPolicy: resourceName(s, "app-cfn-exec"),
    boundaryPolicy: resourceName(s, "app-boundary"),
  };
}

// アプリ専用の管理ポリシーと、アセットのバケットの ARN
export function appBootstrapArns(t: { partition: string; account: string; region: string }, s: Naming) {
  const names = appBootstrapNames(s);
  const policy = (name: string) => `arn:${t.partition}:iam::${t.account}:policy/${name}`;
  return {
    assetsBucket: `arn:${t.partition}:s3:::cdk-${appQualifier(s)}-assets-${t.account}-${t.region}`,
    executionPolicy: policy(names.executionPolicy),
    boundaryPolicy: policy(names.boundaryPolicy),
  };
}

// 反映のプロジェクトのロールの固定の名前。bootstrap の信頼ポリシーが、パイプラインより先に名前を書けるようにする
export function deployRoleName(s: Naming, region: string): string {
  return `${resourceName(s, "deploy")}-${region}`;
}

// CDK の bootstrap のロールの ARN
export function cdkRoleArn(
  t: { partition: string; account: string; region: string },
  qualifier: string,
  kind: string,
): string {
  return `arn:${t.partition}:iam::${t.account}:role/cdk-${qualifier}-${kind}-role-${t.account}-${t.region}`;
}

// 利用者プールのドメインの URL。画面の設定の値の authority と、Google に登録する戻り先の元になる
export function loginDomainUrl(s: Naming, region: string): string {
  return `https://${resourceName(s, "login")}.auth.${region}.amazoncognito.com`;
}

// Google のクライアントに登録する戻り先の URL
export function googleRedirectUri(s: Naming, region: string): string {
  return `${loginDomainUrl(s, region)}/oauth2/idpresponse`;
}
