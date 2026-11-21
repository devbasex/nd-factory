import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import { AuroraPostgresEngineVersion, ClusterInstance, Credentials, DatabaseCluster } from "aws-cdk-lib/aws-rds";
import { DatabaseClusterEngine, DatabaseSecret, ParameterGroup, SubnetGroup } from "aws-cdk-lib/aws-rds";
import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import type { AppResourceNames } from "./naming.ts";
import type { Network } from "./network.ts";

// 進行表の DB: Aurora Serverless v2 の PostgreSQL のクラスタ（書き手 1 台・読み手なし）と管理の役割の秘密の器。
// 接続 0 本で一時停止し、使わない間の計算の費用を 0 にする。DB の用意の関数は Data API で打ち、Aurora へ接続しない

// 自動の一時停止を持つ 16 系（16.3 以上）のうち、aws-cdk-lib が持つ最新の版に固定する
export const PROGRESS_DB_ENGINE_VERSION = AuroraPostgresEngineVersion.VER_16_13;
export const PROGRESS_DB_ADMIN_USER = "nd_admin";
// 接続 0 本でこの秒数が経つと一時停止する。スタックのテストの Aurora の許しもこの値で照らす
export const PROGRESS_DB_AUTO_PAUSE_SECONDS = 300;

export type ProgressDbProps = { network: Network; maxAcu: number; names: AppResourceNames };

export class ProgressDb extends Construct {
  readonly cluster: DatabaseCluster;
  // 管理の役割の秘密の器。値は CDK が作り、合成の出力には動的な参照だけが載る
  readonly adminSecret: ISecret;

  constructor(scope: Construct, id: string, props: ProgressDbProps) {
    super(scope, id);
    const engine = DatabaseClusterEngine.auroraPostgres({ version: PROGRESS_DB_ENGINE_VERSION });

    // クラスタはスタックを消しても残す。残したクラスタが使う間は RDS がパラメーターのグループとサブネットのグループの削除を拒み、
    // スタックの削除が DELETE_FAILED になるため、2 つのグループも残す（サブネット・SG・VPC は Network が残す）

    // Aurora PostgreSQL 16 は rds.force_ssl の既定が 0 で、TLS でない接続を受けてしまう
    const parameterGroup = new ParameterGroup(this, "Parameters", {
      engine,
      description: "nd-factory progress DB",
      parameters: { "rds.force_ssl": "1" },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // 残したクラスタの管理の役割を、スタックを消した後も同じ器から読めるようにする。
    // クラスタの識別子とこの器の名前は固定のため、残したまま同じ設定で作り直すと名前が衝突する。
    // 作り直す前に消す手順は docs/operations/setup.md の「アプリのスタックを消した後に作り直す」にある
    const secret = new DatabaseSecret(this, "AdminSecret", {
      username: PROGRESS_DB_ADMIN_USER,
      secretName: props.names.progressDbAdminSecret,
    });
    secret.applyRemovalPolicy(RemovalPolicy.RETAIN);

    this.cluster = new DatabaseCluster(this, "Cluster", {
      clusterIdentifier: props.names.progressDb,
      engine,
      parameterGroup,
      writer: ClusterInstance.serverlessV2("Writer"),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: props.maxAcu,
      serverlessV2AutoPauseDuration: Duration.seconds(PROGRESS_DB_AUTO_PAUSE_SECONDS),
      credentials: Credentials.fromSecret(secret, PROGRESS_DB_ADMIN_USER),
      vpc: props.network.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.network.dbSecurityGroup],
      storageEncrypted: true,
      enableDataApi: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // サブネットのグループはクラスタが自ら作る子（論理 ID は ProgressDb/Cluster/Subnets）のまま使う。
    // 別の構成子に作り替えると論理 ID が変わり、DBSubnetGroupName の変更でクラスタの置き換えを求め、
    // 固定の識別子を持つ既設のクラスタの更新が失敗する。削除方針は子へ直に当てる
    const subnets = this.cluster.node.findChild("Subnets");
    if (!(subnets instanceof SubnetGroup)) throw new Error("進行表の DB のサブネットのグループがクラスタの子に無い");
    subnets.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // クラスタへ結んだ器（接続先の値も持つ）を渡す
    const attached = this.cluster.secret;
    if (!attached) throw new Error("進行表の DB の管理の役割の秘密の器がクラスタへ結ばれていない");
    this.adminSecret = attached;
  }
}
