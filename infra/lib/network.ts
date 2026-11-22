import { RemovalPolicy } from "aws-cdk-lib";
import { GatewayVpcEndpointAwsService, IpAddresses, Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import type { AppResourceNames } from "./naming.ts";

// ネットワーク: VPC・4 つのサブネット・S3 の Gateway のエンドポイント・タスクの SG・Aurora の SG。
// NAT と Interface 型のエンドポイントは時間で費用が掛かるため置かない。タスクは公開のサブネットで公開 IP を付けて外へ出る

const POSTGRES_PORT = 5432;

// 4 つのサブネット（2 つの AZ に公開と出口の無いものを 1 つずつ）を VPC の範囲で等しく切る接頭辞の長さ
export function subnetMask(cidr: string): number {
  const length = Number(cidr.split("/")[1]);
  if (!Number.isInteger(length)) throw new Error(`CIDR の接頭辞の長さが読めない: ${JSON.stringify(cidr)}`);
  return length + 2;
}

export type NetworkProps = { cidr: string; names: AppResourceNames };

export class Network extends Construct {
  readonly vpc: Vpc;
  // ランナーのタスクの SG。受け入れの規則を持たない
  readonly taskSecurityGroup: SecurityGroup;
  // 進行表の DB の SG。タスクの SG からの 5432 だけを受ける
  readonly dbSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);
    const mask = subnetMask(props.cidr);

    // AZ はスタックの availabilityZones（Fn::GetAZs の先頭の 2 つ）から受け、合成で lookup しない
    this.vpc = new Vpc(this, "Vpc", {
      vpcName: props.names.vpc,
      ipAddresses: IpAddresses.cidr(props.cidr),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        // 公開 IP は RunTask がタスクごとに付ける。サブネットの自動の割り当ては使わない
        { name: "public", subnetType: SubnetType.PUBLIC, cidrMask: mask, mapPublicIpOnLaunch: false },
        { name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: mask },
      ],
      gatewayEndpoints: { S3: { service: GatewayVpcEndpointAwsService.S3 } },
      // 既定の SG の規則を外し、だれも使わない SG に通り道を残さない
      restrictDefaultSecurityGroup: true,
    });

    // SG の説明は EC2 が ASCII の一部の文字だけを受けるため英語で書く
    this.taskSecurityGroup = new SecurityGroup(this, "TaskSecurityGroup", {
      vpc: this.vpc,
      securityGroupName: props.names.taskSecurityGroup,
      description: "Runner tasks: no ingress, egress 443 and the progress DB only",
      allowAllOutbound: false,
    });
    this.dbSecurityGroup = new SecurityGroup(this, "DbSecurityGroup", {
      vpc: this.vpc,
      securityGroupName: props.names.dbSecurityGroup,
      description: "Progress DB: ingress 5432 from runner tasks only",
      allowAllOutbound: false,
    });
    this.taskSecurityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(443), "HTTPS to ECR, logs, API and inference");
    this.taskSecurityGroup.addEgressRule(this.dbSecurityGroup, Port.tcp(POSTGRES_PORT), "Progress DB");
    this.dbSecurityGroup.addIngressRule(this.taskSecurityGroup, Port.tcp(POSTGRES_PORT), "Runner tasks");

    // 進行表の DB はスタックを消しても残す。DB の ENI が残る出口の無いサブネット・DB の SG・VPC は、
    // 消そうとすると EC2 が使用中として拒み、スタックの削除が DELETE_FAILED になるため、同じく残す
    this.vpc.applyRemovalPolicy(RemovalPolicy.RETAIN);
    for (const subnet of this.vpc.isolatedSubnets) subnet.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.dbSecurityGroup.applyRemovalPolicy(RemovalPolicy.RETAIN);
  }
}
