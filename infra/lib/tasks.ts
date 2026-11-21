import { RemovalPolicy, Stack } from "aws-cdk-lib";
import type { ISubnet, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import { Cluster, ContainerInsights } from "aws-cdk-lib/aws-ecs";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { AppResourceNames } from "./naming.ts";
import type { Network } from "./network.ts";

// ECS のクラスタと、ランナーのタスクの定義（#6）が使う役割・ログの群。
// ECS のサービスとタスクセットは作らず、タスクは RunTask だけで起こす

// ランナーの既定の大きさ（1 vCPU・2 GB）。#6 がタスクの定義で使う
export const RUNNER_TASK_SIZE = { cpu: 1024, memoryMiB: 2048 } as const;

// #6 が RunTask の propagateTags に必ず渡す値。RunTask は既定でタスクの定義のタグを写さず、
// 渡さなければ Fargate の費用がタグ app-prefix・app-env を持たず、タグで絞る予算に数えられない
export const RUN_TASK_PROPAGATE_TAGS = "TASK_DEFINITION";

// タスクの役割の印。スタックの決まりの検査は、この説明を持つ役割に許可の文が無いことを照らす
export const TASK_ROLE_DESCRIPTION = "nd-factory runner task role. It holds no permissions (I11).";

export type TaskPlatformProps = { network: Network; names: AppResourceNames };

export class TaskPlatform extends Construct {
  readonly cluster: Cluster;
  // ECR からの取得とログの書き込みだけを持つ
  readonly executionRole: Role;
  // AWS の権限を持たない。要るものはすべて API から引き換えで受ける（I11）
  readonly taskRole: Role;
  readonly logGroup: LogGroup;
  readonly publicSubnets: ISubnet[];
  readonly taskSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: TaskPlatformProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { names } = props;

    // 時間で費用が掛かる Container Insights は付けない
    this.cluster = new Cluster(this, "Cluster", {
      clusterName: names.runnerCluster,
      // 渡さなければクラスタが NAT つきの VPC を自分で作る
      vpc: props.network.vpc,
      containerInsightsV2: ContainerInsights.DISABLED,
    });

    // タスクのログは 30 日で消す。スタックを消せば群も消し、同じ名前で作り直せるようにする
    this.logGroup = new LogGroup(this, "Logs", {
      logGroupName: names.runnerLogGroup,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 2 つの役割は、このアカウントの ECS のタスクだけが引き受けられる
    const ecsTasks = () =>
      new ServicePrincipal("ecs-tasks.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": stack.account },
          ArnLike: { "aws:SourceArn": stack.formatArn({ service: "ecs", resource: "*" }) },
        },
      });

    this.executionRole = new Role(this, "ExecutionRole", {
      assumedBy: ecsTasks(),
      description: "nd-factory runner task execution role: pull own images and write logs",
    });
    this.executionRole.addToPolicy(new PolicyStatement({ actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
    this.executionRole.addToPolicy(
      new PolicyStatement({
        actions: ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
        resources: [stack.formatArn({ service: "ecr", resource: "repository", resourceName: names.imageRepositories })],
      }),
    );
    this.logGroup.grantWrite(this.executionRole);

    this.taskRole = new Role(this, "TaskRole", { assumedBy: ecsTasks(), description: TASK_ROLE_DESCRIPTION });

    this.publicSubnets = props.network.vpc.publicSubnets;
    this.taskSecurityGroup = props.network.taskSecurityGroup;
  }
}
