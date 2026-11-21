import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@nd-factory/contracts/settings";
import { CfnResource, type Stack, TagManager } from "aws-cdk-lib";
import type { Template } from "aws-cdk-lib/assertions";
import { TASK_ROLE_DESCRIPTION } from "../lib/tasks.ts";

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

// インフラの 5 つのキーをすべて既定と違う値にした設定
export const INFRA_SETTINGS: Settings = {
  ...BASE_SETTINGS,
  network: { vpc_cidr: "10.20.0.0/20" },
  progress_db: { max_acu: 16 },
  budget: { monthly_usd: 100, scope: "account" },
  ops: { notify_emails: ["ops@example.com", "ops-2@example.com"] },
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

type Resource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  DependsOn?: string | string[];
};
type Resources = Record<string, Resource>;

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

// Aurora の許し: 最小 0 ACU・自動の一時停止 300 秒・Serverless v2 の書き手 1 台・読み手なしのクラスタだけは、
// 使わない間の計算の費用が 0 のため時間で費用が掛かる資源に数えない（設計の決定 4）
const AURORA_AUTO_PAUSE_SECONDS = 300;

// 参照（Ref か Fn::GetAtt）が指す論理 ID
function refTarget(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as { Ref?: unknown; "Fn::GetAtt"?: unknown };
  if (typeof v.Ref === "string") return v.Ref;
  if (Array.isArray(v["Fn::GetAtt"]) && typeof v["Fn::GetAtt"][0] === "string") return v["Fn::GetAtt"][0];
  return undefined;
}

function allowedAuroraClusters(all: Resources): Set<string> {
  const allowed = new Set<string>();
  for (const [id, r] of Object.entries(all)) {
    if (r.Type !== "AWS::RDS::DBCluster") continue;
    const scaling = r.Properties?.ServerlessV2ScalingConfiguration as Record<string, unknown> | undefined;
    if (scaling?.MinCapacity !== 0 || scaling.SecondsUntilAutoPause !== AURORA_AUTO_PAUSE_SECONDS) continue;
    const members = Object.values(all).filter(
      (m) => m.Type === "AWS::RDS::DBInstance" && refTarget(m.Properties?.DBClusterIdentifier) === id,
    );
    if (members.length === 1 && members[0]!.Properties?.DBInstanceClass === "db.serverless") allowed.add(id);
  }
  return allowed;
}

export function hourlyCostResources(template: Template): string[] {
  const all = resources(template);
  const aurora = allowedAuroraClusters(all);
  const found: string[] = [];
  for (const [id, r] of Object.entries(all)) {
    if (r.Type === "AWS::RDS::DBCluster" && aurora.has(id)) continue;
    if (r.Type === "AWS::RDS::DBInstance" && aurora.has(refTarget(r.Properties?.DBClusterIdentifier) ?? "")) continue;
    if ((HOURLY_COST_TYPES as readonly string[]).includes(r.Type)) found.push(id);
    if (r.Type === "AWS::EC2::VPCEndpoint" && r.Properties?.VpcEndpointType === "Interface") found.push(id);
  }
  return found;
}

// 全体の設計の「スタックのテストに足す行」の 8 つの決まり
export const STACK_RULES = [
  "nat",
  "task_ingress",
  "lambda_in_vpc",
  "ecs_service",
  "task_role_statement",
  "aurora_min",
  "deletable",
  "pitr",
] as const;
export type StackRule = (typeof STACK_RULES)[number];
export type StackRuleViolation = { rule: StackRule; id: string };

const TABLE_TYPES = ["AWS::DynamoDB::Table", "AWS::DynamoDB::GlobalTable"];
// スタックを消しても、置き換えが起きても残す資源の種類。決まりはこれらと、これらが参照する資源（DB のグループ・
// サブネット・SG・VPC・管理の役割の秘密の器など）のすべてに当てる。参照先を消そうとすると使用中として拒まれるか、
// 残した資源が読めなくなるため
const RETAINED_ROOT_TYPES = [...TABLE_TYPES, "AWS::S3::Bucket", "AWS::RDS::DBCluster", "AWS::RDS::DBInstance"];

// 値の中の参照（Ref か Fn::GetAtt）が指す論理 ID をすべて集める
function refsIn(value: unknown, out: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  const target = refTarget(value);
  if (target) out.add(target);
  for (const v of Array.isArray(value) ? value : Object.values(value)) refsIn(v, out);
}

// 残す資源と、それらが参照で辿れる資源
function retainedIds(all: Resources): Set<string> {
  const ids = new Set<string>();
  const queue = Object.keys(all).filter((id) => RETAINED_ROOT_TYPES.includes(all[id]!.Type));
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (ids.has(id) || !all[id]) continue;
    ids.add(id);
    const refs = new Set<string>();
    refsIn(all[id]!.Properties, refs);
    queue.push(...refs);
  }
  return ids;
}

function nonEmpty(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined;
}

// 表の PITR が有効か。GlobalTable はレプリカごとに持つため、すべてのレプリカで有効なときだけ有効とする
function pitrEnabled(r: Resource): boolean {
  const on = (spec: unknown) => (spec as { PointInTimeRecoveryEnabled?: unknown } | undefined)?.PointInTimeRecoveryEnabled === true;
  if (r.Type === "AWS::DynamoDB::Table") return on(r.Properties?.PointInTimeRecoverySpecification);
  const replicas = (r.Properties?.Replicas ?? []) as { PointInTimeRecoverySpecification?: unknown }[];
  return replicas.length > 0 && replicas.every((rep) => on(rep.PointInTimeRecoverySpecification));
}

// タスクの役割: TaskPlatform が印の説明で作る役割と、タスクの定義の TaskRoleArn が指す役割
function taskRoleIds(all: Resources): Set<string> {
  const ids = new Set<string>();
  for (const [id, r] of Object.entries(all)) {
    if (r.Type === "AWS::IAM::Role" && r.Properties?.Description === TASK_ROLE_DESCRIPTION) ids.add(id);
    if (r.Type === "AWS::ECS::TaskDefinition") {
      const target = refTarget(r.Properties?.TaskRoleArn);
      if (target) ids.add(target);
    }
  }
  return ids;
}

function taskSecurityGroupIds(all: Resources): Set<string> {
  const ids = new Set<string>();
  for (const [id, r] of Object.entries(all)) {
    const name = r.Properties?.GroupName;
    if (r.Type === "AWS::EC2::SecurityGroup" && typeof name === "string" && name.endsWith("-task-sg")) ids.add(id);
  }
  return ids;
}

// 合成の出力を 8 つの決まりに照らし、破れた資源を返す
export function stackRuleViolations(template: Template): StackRuleViolation[] {
  const all = resources(template);
  const taskRoles = taskRoleIds(all);
  const taskSgs = taskSecurityGroupIds(all);
  const retained = retainedIds(all);
  const out: StackRuleViolation[] = [];
  for (const [id, r] of Object.entries(all)) {
    const p = r.Properties ?? {};
    if (r.Type === "AWS::EC2::NatGateway") out.push({ rule: "nat", id });
    if (taskSgs.has(id) && nonEmpty(p.SecurityGroupIngress)) out.push({ rule: "task_ingress", id });
    if (r.Type === "AWS::EC2::SecurityGroupIngress" && taskSgs.has(refTarget(p.GroupId) ?? "")) {
      out.push({ rule: "task_ingress", id });
    }
    if (r.Type === "AWS::Lambda::Function" && p.VpcConfig !== undefined) out.push({ rule: "lambda_in_vpc", id });
    if (r.Type === "AWS::ECS::Service" || r.Type === "AWS::ECS::TaskSet") out.push({ rule: "ecs_service", id });
    if (taskRoles.has(id) && (nonEmpty(p.Policies) || nonEmpty(p.ManagedPolicyArns))) {
      out.push({ rule: "task_role_statement", id });
    }
    if (
      (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") &&
      ((p.Roles ?? []) as unknown[]).some((role) => taskRoles.has(refTarget(role) ?? ""))
    ) {
      out.push({ rule: "task_role_statement", id });
    }
    if (r.Type === "AWS::RDS::DBCluster") {
      const scaling = p.ServerlessV2ScalingConfiguration as { MinCapacity?: unknown } | undefined;
      if (scaling?.MinCapacity !== 0) out.push({ rule: "aurora_min", id });
    }
    if (retained.has(id) && (r.DeletionPolicy !== "Retain" || r.UpdateReplacePolicy !== "Retain")) {
      out.push({ rule: "deletable", id });
    }
    if (TABLE_TYPES.includes(r.Type) && !pitrEnabled(r)) out.push({ rule: "pitr", id });
  }
  return out;
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
  "AWS::EC2::SecurityGroup": "GroupName",
  "AWS::ECS::Cluster": "ClusterName",
  "AWS::RDS::DBCluster": "DBClusterIdentifier",
  "AWS::Budgets::Budget": "Budget.BudgetName",
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
