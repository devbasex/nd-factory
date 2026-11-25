import { TABLE_PURPOSES, TABLES, type TablePurpose } from "@nd-factory/contracts/tables";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ServiceTable, TABLE_ENV_NAMES } from "../lib/service-table.ts";
import { BASE_SETTINGS, TEST_ENV, nameViolations, resources } from "./support.ts";

// 表の部品を 1 つだけ置いたスタックを合成する（アプリのスタックへは入れない。決定 8）
function build(purpose: TablePurpose): { table: ServiceTable; template: Template } {
  const app = new App();
  const stack = new Stack(app, "acme-test-tables", { env: TEST_ENV });
  const table = new ServiceTable(stack, "Table", { purpose, names: BASE_SETTINGS });
  return { table, template: Template.fromStack(stack) };
}

type TableResource = { Type: string; DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties: Record<string, unknown> };

function onlyTable(template: Template): TableResource {
  const found = Object.values(resources(template)).filter((r) => r.Type === "AWS::DynamoDB::GlobalTable");
  expect(found).toHaveLength(1);
  return found[0] as TableResource;
}

describe("ServiceTable", () => {
  it.each(TABLE_PURPOSES.map((p) => [p]))("%s の表は <prefix>-<environment>-<名前の末尾> の名前で、要求の数の課金・PITR・残す設定を持つ", (purpose) => {
    const { template } = build(purpose);
    expect(nameViolations(template, BASE_SETTINGS)).toEqual([]);
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TableName: `acme-test-${TABLES[purpose].suffix}`,
      BillingMode: "PAY_PER_REQUEST",
      Replicas: [Match.objectLike({ Region: "us-west-2", PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
    });
    const table = onlyTable(template);
    expect(table.DeletionPolicy).toBe("Retain");
    expect(table.UpdateReplacePolicy).toBe("Retain");
  });

  it.each(TABLE_PURPOSES.map((p) => [p]))("%s の表の鍵と TTL と索引は表の仕様と合う", (purpose) => {
    const spec = TABLES[purpose];
    const props = onlyTable(build(purpose).template).Properties;
    const keySchema = [{ AttributeName: "pk", KeyType: "HASH" }, ...(spec.sortKey === null ? [] : [{ AttributeName: spec.sortKey, KeyType: "RANGE" }])];
    expect(props["KeySchema"]).toEqual(keySchema);
    expect(props["TimeToLiveSpecification"]).toEqual(spec.ttlAttribute === null ? undefined : { AttributeName: spec.ttlAttribute, Enabled: true });
    const indexes = (props["GlobalSecondaryIndexes"] as unknown[] | undefined) ?? [];
    expect(indexes).toEqual(
      spec.indexes.map((index) => ({
        IndexName: index.name,
        KeySchema: [
          { AttributeName: index.partitionKey, KeyType: "HASH" },
          { AttributeName: index.sortKey, KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: [...index.projection] },
      })),
    );
    // 鍵の列はどれも文字列
    const keyColumns = new Set(["pk", ...(spec.sortKey === null ? [] : [spec.sortKey]), ...spec.indexes.flatMap((i) => [i.partitionKey, i.sortKey])]);
    expect(props["AttributeDefinitions"]).toEqual(expect.arrayContaining([...keyColumns].map((name) => ({ AttributeName: name, AttributeType: "S" }))));
    expect(props["AttributeDefinitions"]).toHaveLength(keyColumns.size);
  });

  it("3 つの索引の鍵と写す列が仕様のとおりに出る", () => {
    const indexOf = (purpose: TablePurpose) => (onlyTable(build(purpose).template).Properties["GlobalSecondaryIndexes"] as unknown[])[0];
    expect(indexOf("teams")).toEqual({
      IndexName: "user-seats",
      KeySchema: [
        { AttributeName: "user_id", KeyType: "HASH" },
        { AttributeName: "team_id", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["role"] },
    });
    expect(indexOf("projects")).toEqual({
      IndexName: "team-projects",
      KeySchema: [
        { AttributeName: "current_team_id", KeyType: "HASH" },
        { AttributeName: "project_id", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["name", "current_assign_id"] },
    });
    expect(indexOf("decisions")).toEqual({
      IndexName: "waiting",
      KeySchema: [
        { AttributeName: "project_id", KeyType: "HASH" },
        { AttributeName: "waiting_since", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["sprint_id", "lane_id", "gate", "category"] },
    });
  });

  it("並びの鍵の無い表（db-idempotency）は区切りの鍵だけを持ち、TTL を持つ", () => {
    const props = onlyTable(build("idempotency").template).Properties;
    expect(props["KeySchema"]).toEqual([{ AttributeName: "pk", KeyType: "HASH" }]);
    expect(props["AttributeDefinitions"]).toEqual([{ AttributeName: "pk", AttributeType: "S" }]);
    expect(props["TimeToLiveSpecification"]).toEqual({ AttributeName: "expire_at", Enabled: true });
    expect(props["GlobalSecondaryIndexes"]).toBeUndefined();
  });

  it("表の仕様を部品から引ける", () => {
    expect(build("users").table.spec).toBe(TABLES.users);
  });

  // API の起点（apps/api/src/entries/api-fn.ts の tableNamesOf）が表の名前を読む環境変数の名前と同じにする
  it("表の名前を渡す環境変数の名前は <用途の大文字>_TABLE で、10 の表で重ならない", () => {
    const names = TABLE_PURPOSES.map((purpose) => build(purpose).table.envName);
    expect(names).toEqual([
      "USERS_TABLE",
      "TEAMS_TABLE",
      "PROJECTS_TABLE",
      "SPRINTS_TABLE",
      "EVENTS_TABLE",
      "DECISIONS_TABLE",
      "NOTICES_TABLE",
      "USAGE_TABLE",
      "AUDIT_TABLE",
      "IDEMPOTENCY_TABLE",
    ]);
    expect(TABLE_ENV_NAMES).toEqual(Object.fromEntries(TABLE_PURPOSES.map((purpose, i) => [purpose, names[i]])));
  });
});
