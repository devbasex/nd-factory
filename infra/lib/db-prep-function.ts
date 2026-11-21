import { fileURLToPath } from "node:url";
import { DB_PREP_ENV, DB_PREP_TIMING } from "@nd-factory/contracts/db-prep";
import { ArnFormat, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { AppResourceNames } from "./naming.ts";
import type { ProgressDb } from "./progress-db.ts";

// DB の用意の関数: VPC の外の Lambda が RDS Data API の HTTPS の端点で進行表の DB に SQL を打つ。
// 役割は Data API の 4 つの操作と、管理の役割の秘密の器・プロジェクトの秘密の器の読みと版の移しだけを持つ。
// 呼ぶ主体（API の関数と見回りの関数）と終わりの記録の口が要る DynamoDB の権限は #6 が足す

// 起点のパス。コードは import せず、合成のときに NodejsFunction が束ねる（infra は apps/* を import しない）
export const DB_PREP_ENTRY = fileURLToPath(new URL("../../apps/api/src/entries/db-prep.ts", import.meta.url));

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOCK_FILE = fileURLToPath(new URL("../../package-lock.json", import.meta.url));

export type DbPrepFunctionProps = {
  db: ProgressDb;
  names: AppResourceNames;
  // プロジェクトの秘密の器の名前の頭（<prefix>/<environment>/progress-db/）
  secretPrefix: string;
};

export class DbPrepFunction extends Construct {
  // #6 が API の関数と見回りの関数に呼ぶ権限（lambda:InvokeFunction）を許す
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: DbPrepFunctionProps) {
    super(scope, id);
    const { db, names, secretPrefix } = props;
    const stack = Stack.of(this);

    // 関数のログは 30 日で消す。スタックを消せば群も消し、同じ名前で作り直せるようにする
    const logGroup = new LogGroup(this, "Logs", {
      logGroupName: names.dbPrepLogGroup,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // VPC に入れない。Data API の端点は VPC の外から打て、NAT もインタフェースのエンドポイントも要らない
    this.fn = new NodejsFunction(this, "Function", {
      functionName: names.dbPrepFunction,
      entry: DB_PREP_ENTRY,
      handler: "handler",
      projectRoot: REPO_ROOT,
      depsLockFilePath: LOCK_FILE,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(DB_PREP_TIMING.functionTimeoutSeconds),
      // やり直しは見回りだけが新しい用意の ID で行う。待ち行列に長く残った呼び出しは捨てる
      retryAttempts: 0,
      maxEventAge: Duration.seconds(DB_PREP_TIMING.maxEventAgeSeconds),
      logGroup,
      environment: {
        [DB_PREP_ENV.clusterArn]: db.cluster.clusterArn,
        [DB_PREP_ENV.adminSecretArn]: db.adminSecret.secretArn,
        [DB_PREP_ENV.secretPrefix]: secretPrefix,
      },
      // SDK も束ねる。実行環境に入っている SDK の版に頼らず、package-lock.json の版で動かす
      bundling: { forceDockerBundling: false, target: "node24", sourceMap: false, minify: true, externalModules: [] },
    });

    // Data API の 4 つの操作だけ。BatchExecuteStatement などは使わない
    this.fn.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "rds-data:ExecuteStatement",
          "rds-data:BeginTransaction",
          "rds-data:CommitTransaction",
          "rds-data:RollbackTransaction",
        ],
        resources: [db.cluster.clusterArn],
      }),
    );
    // 管理の役割の秘密の器は Data API へ渡すために読むだけ
    this.fn.addToRolePolicy(new PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [db.adminSecret.secretArn] }));
    // プロジェクトの秘密の器: 行に結んだ版を読み、SQL を終えた版へ AWSCURRENT を移して確かめる
    this.fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:UpdateSecretVersionStage"],
        resources: [
          stack.formatArn({
            service: "secretsmanager",
            resource: "secret",
            resourceName: `${secretPrefix}*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
  }

  // 終わりの記録の口（同じ Lambda の中で動く）が要る DynamoDB の権限だけを足す。表の ARN だけに許し、
  // 索引・Query・Scan・DeleteItem・ほかの表は許さない。呼ぶのは口をつなぐ #6
  grantCompletionAccess(tables: { projects: ITableV2; audit: ITableV2 }): void {
    // 強い整合の読み（isCurrent・readTarget）と、record の条件つきの書き込み（TransactWriteItems は項目ごとに照らされる）
    this.fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
        resources: [tables.projects.tableArn],
      }),
    );
    // 3 つの処理の記録の行
    this.fn.addToRolePolicy(new PolicyStatement({ actions: ["dynamodb:PutItem"], resources: [tables.audit.tableArn] }));
  }
}
