import { App, type CfnElement, CfnResource, RemovalPolicy } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { CfnNatGateway, CfnSecurityGroupIngress, Peer, Port } from "aws-cdk-lib/aws-ec2";
import { CfnService, CfnTaskSet } from "aws-cdk-lib/aws-ecs";
import { ManagedPolicy, Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnDBInstance } from "aws-cdk-lib/aws-rds";
import { describe, expect, it } from "vitest";
import type { Construct } from "constructs";
import { AppStack } from "../lib/app-stack.ts";
import { BASE_SETTINGS, TEST_ENV, type StackRule, hourlyCostResources, stackRuleViolations, tempWebDist } from "./support.ts";

// スタックの決まりの検査と Aurora の許し。今の AppStack に違反を 1 つだけ足した合成の出力で、その 1 件だけが当たることを照らす

// Lambda の束ねは app-stack.test.ts が確かめる。ここでは資源の形だけを見るため束ねを飛ばす
function newStack(): AppStack {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  return new AppStack(app, "acme-test-app", { env: TEST_ENV, settings: BASE_SETTINGS, webDistPath: tempWebDist() });
}

function idOf(stack: AppStack, el: CfnElement): string {
  return stack.getLogicalId(el);
}

function clusterOf(stack: AppStack): CfnResource {
  return stack.progressDb.cluster.node.defaultChild as CfnResource;
}

// 構成の下にある、その種類の L1 の資源（ただ 1 つ）
function cfnOf(scope: Construct, type: string): CfnResource {
  const found = scope.node.findAll().filter((c): c is CfnResource => CfnResource.isCfnResource(c) && c.cfnResourceType === type);
  expect(found).toHaveLength(1);
  return found[0]!;
}

// 違反を 1 つ足し、当たるべき論理 ID を返す
const BREAKS: Record<StackRule, (stack: AppStack) => string> = {
  nat: (stack) => idOf(stack, new CfnNatGateway(stack, "BadNat", { subnetId: "subnet-0example" })),
  task_ingress: (stack) => {
    stack.network.taskSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(22));
    return idOf(stack, stack.network.taskSecurityGroup.node.defaultChild as CfnElement);
  },
  lambda_in_vpc: (stack) =>
    idOf(
      stack,
      new CfnFunction(stack, "BadFunction", {
        code: { zipFile: "exports.handler = async () => {};" },
        role: "arn:aws:iam::123456789012:role/example",
        runtime: "nodejs24.x",
        handler: "index.handler",
        vpcConfig: { subnetIds: ["subnet-0example"], securityGroupIds: ["sg-0example"] },
      }),
    ),
  ecs_service: (stack) => idOf(stack, new CfnService(stack, "BadService", { cluster: stack.tasks.cluster.clusterName })),
  task_role_statement: (stack) => {
    stack.tasks.taskRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess"));
    return idOf(stack, stack.tasks.taskRole.node.defaultChild as CfnElement);
  },
  aurora_min: (stack) => {
    clusterOf(stack).addPropertyOverride("ServerlessV2ScalingConfiguration.MinCapacity", 0.5);
    return idOf(stack, clusterOf(stack));
  },
  deletable: (stack) => {
    clusterOf(stack).applyRemovalPolicy(RemovalPolicy.DESTROY);
    return idOf(stack, clusterOf(stack));
  },
  pitr: (stack) => {
    const table = new TableV2(stack, "BadTable", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    return idOf(stack, table.node.defaultChild as CfnElement);
  },
};

describe("stackRuleViolations", () => {
  it("今の AppStack では 0 件", () => {
    expect(stackRuleViolations(Template.fromStack(newStack()))).toEqual([]);
  });

  it.each(Object.keys(BREAKS) as StackRule[])("%s の違反を 1 つ足すと、その 1 件だけを返す", (rule) => {
    const stack = newStack();
    const id = BREAKS[rule](stack);
    expect(stackRuleViolations(Template.fromStack(stack))).toEqual([{ rule, id }]);
  });

  // 残す資源が参照する資源も、消しと置き換えの両方で残す
  const DELETABLE_BREAKS: [string, (stack: AppStack) => CfnResource][] = [
    ["クラスタの置き換えの方針を Delete にする", (stack) => {
      clusterOf(stack).addOverride("UpdateReplacePolicy", "Delete");
      return clusterOf(stack);
    }],
    ["書き手を消す", (stack) => {
      const writer = cfnOf(stack.progressDb, "AWS::RDS::DBInstance");
      writer.applyRemovalPolicy(RemovalPolicy.DESTROY);
      return writer;
    }],
    ["管理の役割の秘密の器を消す", (stack) => {
      const secret = cfnOf(stack.progressDb, "AWS::SecretsManager::Secret");
      secret.applyRemovalPolicy(RemovalPolicy.DESTROY);
      return secret;
    }],
    ["パラメーターのグループを消す", (stack) => {
      const group = cfnOf(stack.progressDb, "AWS::RDS::DBClusterParameterGroup");
      group.applyRemovalPolicy(RemovalPolicy.DESTROY);
      return group;
    }],
    ["サブネットのグループを消す", (stack) => {
      const group = cfnOf(stack.progressDb, "AWS::RDS::DBSubnetGroup");
      group.applyRemovalPolicy(RemovalPolicy.DESTROY);
      return group;
    }],
    ["DB の SG を消す", (stack) => {
      const sg = stack.network.dbSecurityGroup.node.defaultChild as CfnResource;
      sg.applyRemovalPolicy(RemovalPolicy.DESTROY);
      return sg;
    }],
    ["出口の無いサブネットを消す", (stack) => {
      const subnet = stack.network.vpc.isolatedSubnets[0]!.node.defaultChild as CfnResource;
      subnet.applyRemovalPolicy(RemovalPolicy.DESTROY);
      return subnet;
    }],
    ["VPC を消す", (stack) => {
      const vpc = stack.network.vpc.node.defaultChild as CfnResource;
      vpc.applyRemovalPolicy(RemovalPolicy.DESTROY);
      return vpc;
    }],
  ];

  it.each(DELETABLE_BREAKS)("deletable: %s と、その 1 件だけを返す", (_, breakIt) => {
    const stack = newStack();
    const id = idOf(stack, breakIt(stack));
    expect(stackRuleViolations(Template.fromStack(stack))).toEqual([{ rule: "deletable", id }]);
  });

  it("タスクの SG を指す別の受け入れの資源も task_ingress に当たる", () => {
    const stack = newStack();
    const ingress = new CfnSecurityGroupIngress(stack, "BadIngress", {
      groupId: stack.network.taskSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 22,
      toPort: 22,
      cidrIp: "0.0.0.0/0",
    });
    expect(stackRuleViolations(Template.fromStack(stack))).toEqual([{ rule: "task_ingress", id: idOf(stack, ingress) }]);
  });

  it("タスクセットを 1 つ足しても ecs_service に当たる", () => {
    const stack = newStack();
    const taskSet = new CfnTaskSet(stack, "BadTaskSet", {
      cluster: "example-cluster",
      service: "example-service",
      taskDefinition: "arn:aws:ecs:ap-northeast-1:123456789012:task-definition/example:1",
    });
    expect(stackRuleViolations(Template.fromStack(stack))).toEqual([{ rule: "ecs_service", id: idOf(stack, taskSet) }]);
  });

  it("タスクの役割へ付く別の方針の資源も task_role_statement に当たる", () => {
    const stack = newStack();
    const policy = new Policy(stack, "BadPolicy", {
      statements: [new PolicyStatement({ actions: ["s3:GetObject"], resources: ["*"] })],
      roles: [stack.tasks.taskRole],
    });
    const id = idOf(stack, policy.node.defaultChild as CfnElement);
    expect(stackRuleViolations(Template.fromStack(stack))).toEqual([{ rule: "task_role_statement", id }]);
  });
});

describe("hourlyCostResources の Aurora の許し", () => {
  it("最小 0・一時停止 300 秒・Serverless v2 の書き手 1 台のクラスタを返さない", () => {
    expect(hourlyCostResources(Template.fromStack(newStack()))).toEqual([]);
  });

  it("最小を 0.5 にすると、クラスタと書き手を返す", () => {
    const stack = newStack();
    clusterOf(stack).addPropertyOverride("ServerlessV2ScalingConfiguration.MinCapacity", 0.5);
    expect(hourlyCostResources(Template.fromStack(stack))).toHaveLength(2);
  });

  it("一時停止を外すと、クラスタと書き手を返す", () => {
    const stack = newStack();
    clusterOf(stack).addPropertyDeletionOverride("ServerlessV2ScalingConfiguration.SecondsUntilAutoPause");
    expect(hourlyCostResources(Template.fromStack(stack))).toHaveLength(2);
  });

  it("読み手を 1 台足すと、クラスタと 2 台を返す", () => {
    const stack = newStack();
    const reader = new CfnDBInstance(stack, "Reader", {
      dbClusterIdentifier: stack.progressDb.cluster.clusterIdentifier,
      dbInstanceClass: "db.serverless",
      engine: "aurora-postgresql",
    });
    const found = hourlyCostResources(Template.fromStack(stack));
    expect(found).toHaveLength(3);
    expect(found).toContain(idOf(stack, clusterOf(stack)));
    expect(found).toContain(idOf(stack, reader));
  });
});
