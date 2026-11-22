import { TABLE_PURPOSES, TABLES, type TablePurpose, type TableSpec } from "@nd-factory/contracts/tables";
import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, Billing, ProjectionType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { resourceName } from "./naming.ts";

// サービスの表の部品。形の正本の表の仕様（tables.ts）から DynamoDB の表と索引を作る（決定 8）。
// 名前・PITR・残す設定を部品の 1 か所に置き、表を足す子の間で食い違わせない。スタックへ入れるのは表を最初に書く子

export type ServiceTableProps = {
  readonly purpose: TablePurpose;
  // 表の名前を <prefix>-<environment>-<名前の末尾> で作る
  readonly names: { readonly prefix: string; readonly environment: string };
};

// 表の名前を関数へ渡す環境変数の名前。API の起点（apps/api/src/entries/api-fn.ts の tableNamesOf）が読む <用途の大文字>_TABLE と同じ
export const TABLE_ENV_NAMES: Readonly<Record<TablePurpose, string>> = Object.fromEntries(
  TABLE_PURPOSES.map((purpose) => [purpose, `${purpose.toUpperCase()}_TABLE`]),
) as Record<TablePurpose, string>;

// 鍵の列はどれも文字列（ID・鍵の文字列・RFC 3339 の日時）
const string = (name: string) => ({ name, type: AttributeType.STRING });

export class ServiceTable extends Construct {
  readonly table: TableV2;
  readonly spec: TableSpec;
  // 表を読み書きする関数へ表の名前を渡す環境変数の名前
  readonly envName: string;

  constructor(scope: Construct, id: string, props: ServiceTableProps) {
    super(scope, id);
    const spec = TABLES[props.purpose];
    this.spec = spec;
    this.envName = TABLE_ENV_NAMES[props.purpose];
    this.table = new TableV2(this, "Table", {
      tableName: resourceName(props.names, spec.suffix),
      partitionKey: string(spec.partitionKey),
      ...(spec.sortKey === null ? {} : { sortKey: string(spec.sortKey) }),
      // 要求の数の課金にし、時間で費用を掛けない
      billing: Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // スタックを消しても、資源の置き換えでも表を消さない
      removalPolicy: RemovalPolicy.RETAIN,
      ...(spec.ttlAttribute === null ? {} : { timeToLiveAttribute: spec.ttlAttribute }),
      // 索引の鍵は元の行の列そのもので、列の無い行は載らない（疎の索引）。写す列は鍵のほかに読む列だけ
      ...(spec.indexes.length === 0
        ? {}
        : {
            globalSecondaryIndexes: spec.indexes.map((index) => ({
              indexName: index.name,
              partitionKey: string(index.partitionKey),
              sortKey: string(index.sortKey),
              projectionType: ProjectionType.INCLUDE,
              nonKeyAttributes: [...index.projection],
            })),
          }),
    });
  }
}
