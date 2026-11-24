import { existsSync } from "node:fs";
import { DB_PREP_ENV, DB_PREP_TIMING } from "@nd-factory/contracts/db-prep";
import { App, type CfnElement, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import { DB_PREP_ENTRY, DbPrepFunction } from "../lib/db-prep-function.ts";
import { appResourceNames, secretName } from "../lib/naming.ts";
import { Network } from "../lib/network.ts";
import { PROGRESS_DB_ADMIN_USER, ProgressDb } from "../lib/progress-db.ts";
import { BASE_SETTINGS, TEST_ENV, resources } from "./support.ts";

// DB の用意の関数の資源を、それと進行表の DB だけを置いた小さなスタックで照らす。AppStack への組み込みは app-stack.test.ts が照らす

const NAMES = appResourceNames(BASE_SETTINGS);
const SECRET_PREFIX = `${secretName(BASE_SETTINGS, "progress-db")}/`;

class PartsStack extends Stack {
  override get availabilityZones(): string[] {
    return ["us-west-2a", "us-west-2b"];
  }
}

type Built = { stack: Stack; template: Template; prep: DbPrepFunction; db: ProgressDb; tables?: { projects: TableV2; audit: TableV2 } };

// 束ねは app-stack.test.ts が確かめる。ここでは資源の形だけを見るため束ねを飛ばす
function build(withTables: boolean): Built {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stack = new PartsStack(app, "acme-test-parts", { env: TEST_ENV });
  const network = new Network(stack, "Network", { cidr: "10.80.0.0/16", names: NAMES });
  const db = new ProgressDb(stack, "ProgressDb", { network, maxAcu: 2, names: NAMES });
  const prep = new DbPrepFunction(stack, "DbPrep", { db, names: NAMES, secretPrefix: SECRET_PREFIX });
  let tables: Built["tables"];
  if (withTables) {
    const table = (id: string) => new TableV2(stack, id, { partitionKey: { name: "pk", type: AttributeType.STRING } });
    tables = { projects: table("ProjectsTable"), audit: table("AuditTable") };
    prep.grantCompletionAccess(tables);
  }
  return { stack, template: Template.fromStack(stack), prep, db, tables };
}

function idOf(stack: Stack, el: unknown): string {
  return stack.getLogicalId(el as CfnElement);
}

type Statement = { Effect: string; Action: string | string[]; Resource: unknown };

// 関数の役割に付いたインラインの文。操作は並びを揃える
function roleStatements(b: Built): { actions: string[]; resource: string }[] {
  const roleId = idOf(b.stack, b.prep.fn.role!.node.defaultChild);
  const policies = Object.values(resources(b.template)).filter(
    (r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties?.Roles ?? []).includes(`"${roleId}"`),
  );
  return policies.flatMap((p) =>
    ((p.Properties?.PolicyDocument as { Statement: Statement[] }).Statement ?? []).map((st) => {
      expect(st.Effect).toBe("Allow");
      const actions = (Array.isArray(st.Action) ? st.Action : [st.Action]).slice().sort();
      // 資源は 1 つの文に 1 つだけ置く（広げたら落とす）
      expect(Array.isArray(st.Resource)).toBe(false);
      return { actions, resource: JSON.stringify(st.Resource) };
    }),
  );
}

const ref = (id: string) => JSON.stringify({ Ref: id });
const arnOf = (id: string) => JSON.stringify({ "Fn::GetAtt": [id, "Arn"] });

function expectedBaseStatements(b: Built): { actions: string[]; resource: string }[] {
  const clusterId = idOf(b.stack, b.db.cluster.node.defaultChild);
  const adminId = idOf(b.stack, b.db.adminSecret.node.defaultChild);
  const clusterArn = JSON.stringify(b.stack.resolve(b.db.cluster.clusterArn));
  // クラスタの ARN はクラスタの識別子の参照から組む
  expect(clusterArn).toContain(ref(clusterId));
  const projectSecrets = JSON.stringify({
    "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:secretsmanager:us-west-2:123456789012:secret:${SECRET_PREFIX}*`]],
  });
  return [
    {
      actions: ["rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:ExecuteStatement", "rds-data:RollbackTransaction"],
      resource: clusterArn,
    },
    { actions: ["secretsmanager:GetSecretValue"], resource: ref(adminId) },
    {
      actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:UpdateSecretVersionStage"],
      resource: projectSecrets,
    },
  ];
}

describe("DB_PREP_ENTRY", () => {
  it("起点は apps/api/src/entries/db-prep.ts を指し、そのファイルがある", () => {
    expect(DB_PREP_ENTRY.replaceAll("\\", "/").endsWith("/apps/api/src/entries/db-prep.ts")).toBe(true);
    expect(existsSync(DB_PREP_ENTRY)).toBe(true);
  });
});

describe("DbPrepFunction", () => {
  let built: Built;
  beforeAll(() => {
    built = build(false);
  });

  function fnProps(b: Built): Record<string, unknown> {
    return resources(b.template)[idOf(b.stack, b.prep.fn.node.defaultChild)]!.Properties ?? {};
  }

  it("関数は名前 <prefix>-<environment>-db-prep・Node 24・ARM64 で、VpcConfig を持たない", () => {
    const p = fnProps(built);
    expect(p.FunctionName).toBe("acme-test-db-prep");
    expect(p.Runtime).toBe("nodejs24.x");
    expect(p.Architectures).toEqual(["arm64"]);
    expect(p.VpcConfig).toBeUndefined();
  });

  it("時間切れは DB_PREP_TIMING.functionTimeoutSeconds（300）", () => {
    expect(DB_PREP_TIMING.functionTimeoutSeconds).toBe(300);
    expect(fnProps(built).Timeout).toBe(DB_PREP_TIMING.functionTimeoutSeconds);
  });

  it("非同期の呼び出しは自動の再試行 0 回・最大の年齢 DB_PREP_TIMING.maxEventAgeSeconds（60）", () => {
    expect(DB_PREP_TIMING.maxEventAgeSeconds).toBe(60);
    const configs = Object.values(resources(built.template)).filter((r) => r.Type === "AWS::Lambda::EventInvokeConfig");
    expect(configs).toHaveLength(1);
    expect(configs[0]!.Properties).toMatchObject({
      FunctionName: { Ref: idOf(built.stack, built.prep.fn.node.defaultChild) },
      MaximumRetryAttempts: 0,
      MaximumEventAgeInSeconds: DB_PREP_TIMING.maxEventAgeSeconds,
    });
  });

  it("ログは自前のログの群 <prefix>-<environment>-db-prep へ書く", () => {
    const groups = Object.entries(resources(built.template)).filter(([, r]) => r.Type === "AWS::Logs::LogGroup");
    expect(groups).toHaveLength(1);
    const [groupId, group] = groups[0]!;
    expect(group.Properties?.LogGroupName).toBe("acme-test-db-prep");
    expect(fnProps(built).LoggingConfig).toMatchObject({ LogGroup: { Ref: groupId } });
  });

  it("クラスタと管理の秘密の器の ARN は参照で、秘密の器の頭は値で、DB_PREP_ENV の名前の環境変数に渡す", () => {
    const clusterId = idOf(built.stack, built.db.cluster.node.defaultChild);
    const adminId = idOf(built.stack, built.db.adminSecret.node.defaultChild);
    const vars = (fnProps(built).Environment as { Variables: Record<string, unknown> }).Variables;
    expect(Object.keys(vars).sort()).toEqual([DB_PREP_ENV.adminSecretArn, DB_PREP_ENV.clusterArn, DB_PREP_ENV.secretPrefix].sort());
    expect(JSON.stringify(vars[DB_PREP_ENV.clusterArn])).toContain(ref(clusterId));
    expect(vars[DB_PREP_ENV.adminSecretArn]).toEqual({ Ref: adminId });
    expect(vars[DB_PREP_ENV.secretPrefix]).toBe("acme/test/progress-db/");
  });

  // 関数は管理の役割で役割のパスワードを書く。rds.restrict_password_commands の下でその文を打てるのは rds_password を持つ役割だけで、
  // クラスタの master の利用者は rds_superuser として既定で持つ。渡す器がその利用者の秘密であることを照らす
  it("関数へ渡す管理の秘密の器は、クラスタの master の利用者（PROGRESS_DB_ADMIN_USER）の秘密をクラスタへ結んだもの", () => {
    const r = resources(built.template);
    const clusterId = idOf(built.stack, built.db.cluster.node.defaultChild);
    const attachmentId = idOf(built.stack, built.db.adminSecret.node.defaultChild);
    const attachment = r[attachmentId]!;
    expect(attachment.Type).toBe("AWS::SecretsManager::SecretTargetAttachment");
    expect(attachment.Properties).toMatchObject({ TargetId: { Ref: clusterId }, TargetType: "AWS::RDS::DBCluster" });
    const secretRef = attachment.Properties?.SecretId as { Ref: string };
    const secret = r[secretRef.Ref]!;
    expect(secret.Type).toBe("AWS::SecretsManager::Secret");
    const template = (secret.Properties?.GenerateSecretString as { SecretStringTemplate: string }).SecretStringTemplate;
    expect(JSON.parse(template)).toEqual({ username: PROGRESS_DB_ADMIN_USER });
    // クラスタの master の利用者とパスワードは、同じ器から読む
    const cluster = r[clusterId]!.Properties ?? {};
    expect(cluster.MasterUsername).toBe(PROGRESS_DB_ADMIN_USER);
    expect(cluster.MasterUserPassword).toEqual({
      "Fn::Join": ["", ["{{resolve:secretsmanager:", { Ref: secretRef.Ref }, ":SecretString:password::}}"]],
    });
    const vars = (fnProps(built).Environment as { Variables: Record<string, unknown> }).Variables;
    expect(vars[DB_PREP_ENV.adminSecretArn]).toEqual({ Ref: attachmentId });
  });

  it("役割の文は Data API の 4 つの操作と 2 種類の秘密の器の権限だけで、DynamoDB の文を持たない", () => {
    expect(roleStatements(built)).toEqual(expectedBaseStatements(built));
    expect(JSON.stringify(roleStatements(built))).not.toContain("dynamodb:");
  });

  it("grantCompletionAccess はプロジェクトの表へ 3 つ、操作の記録の表へ PutItem だけを、表の ARN だけに足す", () => {
    const b = build(true);
    const projectsId = idOf(b.stack, b.tables!.projects.node.defaultChild);
    const auditId = idOf(b.stack, b.tables!.audit.node.defaultChild);
    expect(roleStatements(b)).toEqual([
      ...expectedBaseStatements(b),
      { actions: ["dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:UpdateItem"], resource: arnOf(projectsId) },
      { actions: ["dynamodb:PutItem"], resource: arnOf(auditId) },
    ]);
  });
});
