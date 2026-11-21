import { App, type CfnElement, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { PropagatedTagSource } from "aws-cdk-lib/aws-ecs";
import { beforeAll, describe, expect, it } from "vitest";
import { CostWatch, type CostWatchProps } from "../lib/cost-watch.ts";
import { appResourceNames } from "../lib/naming.ts";
import { Network, subnetMask } from "../lib/network.ts";
import { ProgressDb } from "../lib/progress-db.ts";
import { RUNNER_TASK_SIZE, RUN_TASK_PROPAGATE_TAGS, TaskPlatform } from "../lib/tasks.ts";
import { BASE_SETTINGS, TEST_ENV, resources } from "./support.ts";

// インフラの 4 つの部品を、それだけを置いた小さなスタックで照らす。組み合わせは app-stack.test.ts が照らす

const NAMES = appResourceNames(BASE_SETTINGS);

// AZ の lookup を走らせない小さなスタック
class PartsStack extends Stack {
  override get availabilityZones(): string[] {
    return ["us-west-2a", "us-west-2b"];
  }
}

function partsStack(): Stack {
  return new PartsStack(new App(), "acme-test-parts", { env: TEST_ENV });
}

function ofType(template: Template, type: string): [string, Record<string, unknown>][] {
  return Object.entries(resources(template))
    .filter(([, r]) => r.Type === type)
    .map(([id, r]) => [id, r.Properties ?? {}]);
}

describe("subnetMask", () => {
  it("接頭辞の長さに 2 を足す", () => {
    expect(subnetMask("10.80.0.0/16")).toBe(18);
    expect(subnetMask("10.80.0.0/20")).toBe(22);
  });
});

describe("Network", () => {
  let template: Template;
  let network: Network;
  beforeAll(() => {
    const stack = partsStack();
    network = new Network(stack, "Network", { cidr: "10.80.0.0/16", names: NAMES });
    template = Template.fromStack(stack);
  });

  it("2 つの AZ に公開と出口の無いサブネットを 1 つずつ置き、NAT を置かない", () => {
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    const subnets = ofType(template, "AWS::EC2::Subnet").map(([, p]) => p);
    expect(subnets).toHaveLength(4);
    expect(subnets.map((p) => p.CidrBlock).sort()).toEqual(["10.80.0.0/18", "10.80.128.0/18", "10.80.192.0/18", "10.80.64.0/18"]);
    expect(subnets.every((p) => p.MapPublicIpOnLaunch === false)).toBe(true);
    expect([network.vpc.publicSubnets.length, network.vpc.isolatedSubnets.length]).toEqual([2, 2]);
    // エンドポイントは S3 の Gateway 型だけ
    const endpoints = ofType(template, "AWS::EC2::VPCEndpoint").map(([, p]) => p);
    expect(endpoints.map((p) => [p.VpcEndpointType, JSON.stringify(p.ServiceName).includes(".s3")])).toEqual([["Gateway", true]]);
  });

  it("タスクの SG は受け入れを持たず行きは 443 の任意と Aurora の SG への 5432 だけ、Aurora の SG はタスクの SG からの 5432 だけを受ける", () => {
    const sg = (name: string) => ofType(template, "AWS::EC2::SecurityGroup").find(([, p]) => p.GroupName === name)!;
    const [taskId, task] = sg("acme-test-task-sg");
    const [dbId, db] = sg("acme-test-db-sg");
    const att = (id: string) => ({ "Fn::GetAtt": [id, "GroupId"] });
    expect([task.SecurityGroupIngress, db.SecurityGroupIngress]).toEqual([undefined, undefined]);
    expect(task.SecurityGroupEgress).toEqual([expect.objectContaining({ CidrIp: "0.0.0.0/0", IpProtocol: "tcp", FromPort: 443, ToPort: 443 })]);
    const egress = ofType(template, "AWS::EC2::SecurityGroupEgress").map(([, p]) => p);
    expect(egress).toEqual([expect.objectContaining({ FromPort: 5432, ToPort: 5432, GroupId: att(taskId), DestinationSecurityGroupId: att(dbId) })]);
    const ingress = ofType(template, "AWS::EC2::SecurityGroupIngress").map(([, p]) => p);
    expect(ingress).toEqual([expect.objectContaining({ FromPort: 5432, ToPort: 5432, GroupId: att(dbId), SourceSecurityGroupId: att(taskId) })]);
  });
});

describe("ProgressDb", () => {
  function buildDb(maxAcu: number): Template {
    const stack = partsStack();
    const network = new Network(stack, "Network", { cidr: "10.80.0.0/16", names: NAMES });
    new ProgressDb(stack, "ProgressDb", { network, maxAcu, names: NAMES });
    return Template.fromStack(stack);
  }

  let template: Template;
  beforeAll(() => {
    template = buildDb(2);
  });

  it("Serverless v2 の書き手 1 台で、最小 0・最大 2・一時停止 300 秒・Data API が有効", () => {
    const [, cluster] = ofType(template, "AWS::RDS::DBCluster")[0]!;
    expect(cluster.ServerlessV2ScalingConfiguration).toEqual({ MinCapacity: 0, MaxCapacity: 2, SecondsUntilAutoPause: 300 });
    const fixed = { Engine: "aurora-postgresql", EngineVersion: "16.13", MasterUsername: "nd_admin" };
    expect(cluster).toMatchObject({ ...fixed, EnableHttpEndpoint: true, StorageEncrypted: true, DeletionProtection: true });
    expect(cluster.EnableCloudwatchLogsExports).toBeUndefined();
    expect(ofType(template, "AWS::RDS::DBInstance").map(([, p]) => p.DBInstanceClass)).toEqual(["db.serverless"]);
  });

  it("クラスタのパラメータの群は rds.force_ssl を 1 にし、文のログに引数の値を書かない", () => {
    const [groupId, group] = ofType(template, "AWS::RDS::DBClusterParameterGroup")[0]!;
    expect(group.Family).toBe("aurora-postgresql16");
    expect(group.Parameters).toEqual({ "rds.force_ssl": "1", log_parameter_max_length: "0", log_parameter_max_length_on_error: "0" });
    template.hasResourceProperties("AWS::RDS::DBCluster", { DBClusterParameterGroupName: { Ref: groupId } });
  });

  it("クラスタと管理の役割の秘密の器はスタックを消しても残る", () => {
    template.hasResource("AWS::RDS::DBCluster", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    template.hasResource("AWS::SecretsManager::Secret", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({ Name: "acme/test/progress-db-admin" }),
    });
  });

  it("サブネットのグループはクラスタの子の論理 ID のまま残り、変えると既設のクラスタが置き換えになる", () => {
    const groups = ofType(template, "AWS::RDS::DBSubnetGroup");
    expect(groups.map(([id]) => id)).toEqual([expect.stringMatching(/^ProgressDbClusterSubnets[0-9A-F]{8}$/)]);
    const [groupId] = groups[0]!;
    template.hasResource("AWS::RDS::DBSubnetGroup", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    template.hasResourceProperties("AWS::RDS::DBCluster", { DBSubnetGroupName: { Ref: groupId } });
  });

  it("最大 ACU は設定の上限の 16 まで受ける", () => {
    buildDb(16).hasResourceProperties("AWS::RDS::DBCluster", {
      ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 16, SecondsUntilAutoPause: 300 },
    });
  });
});

describe("TaskPlatform", () => {
  let template: Template;
  let tasks: TaskPlatform;
  beforeAll(() => {
    const stack = partsStack();
    const network = new Network(stack, "Network", { cidr: "10.80.0.0/16", names: NAMES });
    tasks = new TaskPlatform(stack, "Tasks", { network, names: NAMES });
    template = Template.fromStack(stack);
  });

  it("クラスタは Container Insights を持たず、サービスとタスクセットを作らない", () => {
    template.hasResourceProperties("AWS::ECS::Cluster", {
      ClusterName: "acme-test-runner",
      ClusterSettings: [{ Name: "containerInsights", Value: "disabled" }],
    });
    template.resourceCountIs("AWS::ECS::Service", 0);
    template.resourceCountIs("AWS::ECS::TaskSet", 0);
    template.resourceCountIs("AWS::EC2::VPC", 1); // クラスタが自分の VPC を作らない
  });

  it("実行の役割は自前のリポジトリからの取得とログの群への書き込みだけ", () => {
    const id = Stack.of(tasks).getLogicalId(tasks.executionRole.node.defaultChild as CfnElement);
    const role = resources(template)[id]!;
    expect(role.Properties?.ManagedPolicyArns).toBeUndefined();
    const policies = ofType(template, "AWS::IAM::Policy").filter(([, p]) => JSON.stringify(p.Roles).includes(id));
    expect(policies).toHaveLength(1);
    const statements = (policies[0]![1].PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement;
    expect(statements.map((st) => st.Action)).toEqual([
      "ecr:GetAuthorizationToken",
      ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
      ["logs:CreateLogStream", "logs:PutLogEvents"],
    ]);
    expect(JSON.stringify(statements[1]!.Resource)).toContain(":repository/acme-test-*");
    expect(JSON.stringify(statements[2]!.Resource)).toContain("Logs");
  });

  it("ログの群は 30 日で消し、#6 へ渡す値を公開する", () => {
    template.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "acme-test-runner", RetentionInDays: 30 });
    expect(tasks.publicSubnets).toHaveLength(2);
    expect(tasks.taskSecurityGroup).toBeDefined();
    expect(RUNNER_TASK_SIZE).toEqual({ cpu: 1024, memoryMiB: 2048 });
    expect(RUN_TASK_PROPAGATE_TAGS).toBe(PropagatedTagSource.TASK_DEFINITION);
  });
});

describe("CostWatch", () => {
  function buildWatch(over: Partial<CostWatchProps> = {}): Template {
    const stack = partsStack();
    const base = { budgetUsd: 30, budgetScope: "tags", emails: ["ops@example.com"], tags: { prefix: "acme", env: "test" } } as const;
    new CostWatch(stack, "CostWatch", { ...base, names: NAMES, ...over });
    return Template.fromStack(stack);
  }

  function budgetOf(template: Template): { budget: Record<string, unknown>; notices: unknown[]; dependsOn: unknown } {
    const r = Object.values(resources(template)).find((x) => x.Type === "AWS::Budgets::Budget")!;
    return { budget: r.Properties?.Budget as Record<string, unknown>, notices: r.Properties?.NotificationsWithSubscribers as unknown[], dependsOn: r.DependsOn };
  }

  let template: Template;
  beforeAll(() => {
    template = buildWatch();
  });

  it("月の費用の予算を USD で置き、2 つのタグの両方で絞る", () => {
    const { budget } = budgetOf(template);
    expect(budget).toMatchObject({ BudgetName: "acme-test-budget", BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: 30, Unit: "USD" } });
    expect(budget.FilterExpression).toEqual({
      And: [
        { Tags: { Key: "user:app-prefix", Values: ["acme"], MatchOptions: ["EQUALS"] } },
        { Tags: { Key: "user:app-env", Values: ["test"], MatchOptions: ["EQUALS"] } },
      ],
    });
    expect(budget.CostFilters).toBeUndefined();
  });

  it("実績 80%・100% と見込み 100% の 3 つの知らせをトピックへ送る", () => {
    const { notices } = budgetOf(template);
    const [topicId] = ofType(template, "AWS::SNS::Topic")[0]!;
    const expected: [string, number][] = [["ACTUAL", 80], ["ACTUAL", 100], ["FORECASTED", 100]];
    expect(notices).toEqual(
      expected.map(([type, threshold]) => ({
        Notification: { NotificationType: type, ComparisonOperator: "GREATER_THAN", Threshold: threshold, ThresholdType: "PERCENTAGE" },
        Subscribers: [{ SubscriptionType: "SNS", Address: { Ref: topicId } }],
      })),
    );
  });

  it("予算はトピックの方針の後に作り、方針は予算のサービスにこのアカウントの予算からの発行だけを許す", () => {
    const { dependsOn } = budgetOf(template);
    const [policyId, policy] = ofType(template, "AWS::SNS::TopicPolicy")[0]!;
    expect(dependsOn).toContain(policyId);
    const statements = (policy.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement;
    const budgetArns = { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":budgets::123456789012:*"]] };
    expect(statements).toEqual([
      expect.objectContaining({
        Effect: "Allow",
        Principal: { Service: "budgets.amazonaws.com" },
        Action: "SNS:Publish",
        Condition: { StringEquals: { "aws:SourceAccount": "123456789012" }, ArnLike: { "aws:SourceArn": budgetArns } },
      }),
    ]);
  });

  it("トピックは KMS で暗号化せず、宛先ごとにメールの購読を作る", () => {
    const [, topic] = ofType(template, "AWS::SNS::Topic")[0]!;
    expect(topic.TopicName).toBe("acme-test-ops");
    expect(topic.KmsMasterKeyId).toBeUndefined();
    template.resourceCountIs("AWS::SNS::Subscription", 1);
    template.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "ops@example.com" });
  });

  it("宛先 0 件では購読を作らない", () => {
    buildWatch({ emails: [] }).resourceCountIs("AWS::SNS::Subscription", 0);
  });

  it("account ではタグで絞らない", () => {
    const { budget } = budgetOf(buildWatch({ budgetScope: "account" }));
    expect(budget.CostFilters).toBeUndefined();
    expect(budget.FilterExpression).toBeUndefined();
  });
});
