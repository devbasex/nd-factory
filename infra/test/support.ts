import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@nd-factory/contracts/settings";
import { CfnResource, type Stack, TagManager } from "aws-cdk-lib";
import type { Template } from "aws-cdk-lib/assertions";

// スタックのテストが共有する作り物の値と、テンプレートを読む小さな道具

export const TEST_ENV = { account: "123456789012", region: "us-west-2" } as const;

export const BASE_SETTINGS: Settings = {
  prefix: "acme",
  environment: "test",
  login: { google: {} },
};

export const PIPELINE_SETTINGS: Settings = {
  ...BASE_SETTINGS,
  pipeline: { repository: "example-org/example-app", branch: "main", notify_emails: ["ops@example.com"] },
};

export const GOOGLE_CLIENT_ID = "example-client-id.apps.googleusercontent.com";

export function withClientId(s: Settings): Settings {
  return { ...s, login: { google: { client_id: GOOGLE_CLIENT_ID } } };
}

// 画面のビルドの出力の代わり。index.html が 1 つだけある一時のディレクトリ
export function tempWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "nd-web-dist-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>test</title>\n");
  return dir;
}

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown> }>;

export function resources(template: Template): Resources {
  return template.toJSON().Resources as Resources;
}

// 時間で費用が掛かる資源の種類。どれか 1 つでもあれば費用の前提が崩れる
export const HOURLY_COST_TYPES = [
  "AWS::EC2::NatGateway",
  "AWS::ECS::Service",
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "AWS::ElasticLoadBalancing::LoadBalancer",
  "AWS::RDS::DBCluster",
  "AWS::RDS::DBInstance",
] as const;

export function hourlyCostResources(template: Template): string[] {
  const found: string[] = [];
  for (const [id, r] of Object.entries(resources(template))) {
    if ((HOURLY_COST_TYPES as readonly string[]).includes(r.Type)) found.push(id);
    if (r.Type === "AWS::EC2::VPCEndpoint" && r.Properties?.VpcEndpointType === "Interface") found.push(id);
  }
  return found;
}

// 名前を持つ資源の種類と、その名前のプロパティ（入れ子は . で結ぶ）
const NAME_KEYS: Record<string, string> = {
  "AWS::Cognito::UserPool": "UserPoolName",
  "AWS::Cognito::UserPoolClient": "ClientName",
  "AWS::Cognito::UserPoolDomain": "Domain",
  "AWS::DynamoDB::GlobalTable": "TableName",
  "AWS::DynamoDB::Table": "TableName",
  "AWS::Lambda::Function": "FunctionName",
  "AWS::ApiGatewayV2::Api": "Name",
  "AWS::ApiGatewayV2::Authorizer": "Name",
  "AWS::CloudFront::OriginAccessControl": "OriginAccessControlConfig.Name",
  "AWS::S3::Bucket": "BucketName",
  "AWS::CodePipeline::Pipeline": "Name",
  "AWS::CodeBuild::Project": "Name",
  "AWS::SNS::Topic": "TopicName",
  "AWS::IAM::Role": "RoleName",
  "AWS::IAM::ManagedPolicy": "ManagedPolicyName",
  "AWS::CodeStarConnections::Connection": "ConnectionName",
  "AWS::Events::Rule": "Name",
  "AWS::Logs::LogGroup": "LogGroupName",
};

// 秘密の器とパラメーターは / で区切る形にする
const SLASH_NAME_KEYS: Record<string, string> = {
  "AWS::SecretsManager::Secret": "Name",
  "AWS::SSM::Parameter": "Name",
};

function dig(obj: Record<string, unknown> | undefined, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// 名前のプロパティを持つ資源のうち、決まった頭で始まらないものを返す。
// 名前を書かない資源は CloudFormation がスタックの名前から作るため、スタックの名前の頭を別に確かめる
export function nameViolations(template: Template, s: Settings): string[] {
  const dash = `${s.prefix}-${s.environment}-`;
  const slash = `${s.prefix}/${s.environment}/`;
  const bad: string[] = [];
  for (const [id, r] of Object.entries(resources(template))) {
    const dashKey = NAME_KEYS[r.Type];
    const slashKey = SLASH_NAME_KEYS[r.Type];
    const key = dashKey ?? slashKey;
    if (key === undefined) continue;
    const value = dig(r.Properties, key);
    if (value === undefined) continue;
    const ok = typeof value === "string" && (dashKey ? value.startsWith(dash) : value.replace(/^\//, "").startsWith(slash));
    if (!ok) bad.push(`${id} ${r.Type} ${JSON.stringify(value)}`);
  }
  return bad;
}

// タグを付けられる資源のうち、2 つのタグのどちらかが欠けたもの。合成の後に呼ぶ（タグは合成のときに付く）
export function untaggedResources(stack: Stack, s: Settings): string[] {
  const bad: string[] = [];
  for (const c of stack.node.findAll()) {
    if (!CfnResource.isCfnResource(c) || !TagManager.isTaggable(c)) continue;
    const tags = c.tags.tagValues();
    if (tags["app-prefix"] !== s.prefix || tags["app-env"] !== s.environment) bad.push(`${c.node.path} ${c.cfnResourceType}`);
  }
  return bad;
}
