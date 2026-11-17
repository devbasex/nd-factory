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

export function stackName(s: Naming, key: StackKey): string {
  return resourceName(s, key);
}

export function applyTags(scope: IConstruct, s: Naming): void {
  const [prefixKey, envKey] = TAG_KEYS;
  Tags.of(scope).add(prefixKey, s.prefix);
  Tags.of(scope).add(envKey, s.environment);
}

// 縦の切れ端のスタックが名前を付ける資源。設置のコマンドもここから名前を出す
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
    denyApprovalPolicy: resourceName(s, "deny-approval"),
    settingsParameter: settingsParameterName(s),
  };
}

// 利用者プールのドメインの URL。画面の設定の値の authority と、Google に登録する戻り先の元になる
export function loginDomainUrl(s: Naming, region: string): string {
  return `https://${resourceName(s, "login")}.auth.${region}.amazoncognito.com`;
}

// Google のクライアントに登録する戻り先の URL
export function googleRedirectUri(s: Naming, region: string): string {
  return `${loginDomainUrl(s, region)}/oauth2/idpresponse`;
}
