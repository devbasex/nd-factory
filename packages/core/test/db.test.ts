import { GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { cond, deleteIfVersion, putIfAbsent, replaceIfVersion } from "../src/conditional-write.ts";
import { createDb, dynamoDocumentClient, TABLE_PURPOSES, type TableNames } from "../src/db.ts";

// 偽の文書のクライアントへ渡る命令の形を照らす。DynamoDB は呼ばない

const NAMES = Object.fromEntries(TABLE_PURPOSES.map((purpose) => [purpose, `acme-dev-db-${purpose}`])) as unknown as TableNames;

function fakeClient(answer: (command: unknown) => unknown = () => ({})) {
  const sent: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      const out = answer(command);
      if (out instanceof Error) throw out;
      return out;
    },
  } as unknown as DynamoDBDocumentClient;
  return { sent, client };
}

function inputOf<T>(command: unknown, type: new (...args: never[]) => T): Record<string, unknown> {
  expect(command).toBeInstanceOf(type);
  return (command as { input: Record<string, unknown> }).input;
}

describe("createDb", () => {
  it("get は表の名前・鍵・強い整合を渡し、無い行を null で返す", async () => {
    const { sent, client } = fakeClient(() => ({}));
    const db = createDb(client, NAMES);
    expect(await db.get("idempotency", { pk: "usr_x#op#k", sk: null }, true)).toBeNull();
    expect(inputOf(sent[0], GetCommand)).toEqual({ TableName: "acme-dev-db-idempotency", Key: { pk: "usr_x#op#k" }, ConsistentRead: true });
  });

  it("query は鍵の条件と強い整合と上限を渡す", async () => {
    const { sent, client } = fakeClient(() => ({ Items: [{ pk: "TEAM#t", sk: "SEAT#u" }] }));
    const db = createDb(client, NAMES);
    const page = await db.query("teams", { partition: { column: "pk", value: "TEAM#t" }, sort: { column: "sk", op: "begins_with", value: "SEAT#" } }, { consistent: true, limit: 50 });
    expect(page).toEqual({ items: [{ pk: "TEAM#t", sk: "SEAT#u" }], lastKey: null });
    expect(inputOf(sent[0], QueryCommand)).toEqual({
      TableName: "acme-dev-db-teams",
      KeyConditionExpression: "#kp = :kp AND begins_with(#ks, :ks)",
      ExpressionAttributeNames: { "#kp": "pk", "#ks": "sk" },
      ExpressionAttributeValues: { ":kp": "TEAM#t", ":ks": "SEAT#" },
      ConsistentRead: true,
      Limit: 50,
    });
  });

  it("queryIndex は索引の名前と索引の鍵の列を渡し、強い整合の読みを持たない", async () => {
    const { sent, client } = fakeClient(() => ({ Items: [] }));
    const db = createDb(client, NAMES);
    await db.queryIndex("teams", "user-seats", { partition: { column: "user_id", value: "usr_x" } }, {});
    const input = inputOf(sent[0], QueryCommand);
    expect(input).toMatchObject({ TableName: "acme-dev-db-teams", IndexName: "user-seats", KeyConditionExpression: "#kp = :kp", ExpressionAttributeNames: { "#kp": "user_id" } });
    expect(input).not.toHaveProperty("ConsistentRead");
  });

  it("scan は Limit・ExclusiveStartKey・ConsistentRead を渡し、続きの鍵を RowKey で返す", async () => {
    const { sent, client } = fakeClient(() => ({ Items: [], LastEvaluatedKey: { pk: "USER#u", sk: "USER" } }));
    const db = createDb(client, NAMES);
    const page = await db.scan("users", { limit: 100, startKey: { pk: "USER#a", sk: "USER" }, consistent: true });
    expect(page.lastKey).toEqual({ pk: "USER#u", sk: "USER" });
    expect(inputOf(sent[0], ScanCommand)).toEqual({ TableName: "acme-dev-db-users", Limit: 100, ConsistentRead: true, ExclusiveStartKey: { pk: "USER#a", sk: "USER" } });
  });

  it("scan の startKey が null なら ExclusiveStartKey を渡さず、終わりは null", async () => {
    const { sent, client } = fakeClient(() => ({ Items: [] }));
    const db = createDb(client, NAMES);
    expect((await db.scan("idempotency", { limit: 10, startKey: null, consistent: false })).lastKey).toBeNull();
    expect(inputOf(sent[0], ScanCommand)).not.toHaveProperty("ExclusiveStartKey");
  });

  it("transactWrite は件ごとに表の名前と条件式を持った TransactWriteCommand を送る", async () => {
    const { sent, client } = fakeClient();
    const db = createDb(client, NAMES);
    const put = putIfAbsent({ table: "events", item: { pk: "PROJECT#p#LANE#l", sk: "SEQ#1", schema_version: 1, kind: "x" }, onConflict: "return_existing" });
    const incarnation = "3f2b6c1e-8a4d-4f7b-9c2e-1d5a7b9e0f13";
    await db.transactWrite([
      put,
      replaceIfVersion({
        table: "sprints",
        item: { pk: "PROJECT#p", sk: "SPRINT#s", schema_version: 1, state: "stopped" },
        version: 2,
        incarnation,
        expect: { version: { kind: "value", value: 2 }, incarnation: { kind: "value", value: incarnation } },
        onConflict: "version_mismatch",
      }),
      deleteIfVersion({ table: "users", key: { pk: "USER#u", sk: "LOGIN#google#s" }, expect: { version: { kind: "value", value: 1 }, incarnation: { kind: "absent" } }, onConflict: "version_mismatch" }),
    ]);
    expect(inputOf(sent[0], TransactWriteCommand)).toEqual({
      TransactItems: [
        {
          Put: {
            TableName: "acme-dev-db-events",
            Item: { pk: "PROJECT#p#LANE#l", sk: "SEQ#1", schema_version: 1, kind: "x", incarnation: put.item?.["incarnation"] },
            ConditionExpression: "attribute_not_exists(#n0)",
            ExpressionAttributeNames: { "#n0": "pk" },
          },
        },
        {
          Put: {
            TableName: "acme-dev-db-sprints",
            Item: { pk: "PROJECT#p", sk: "SPRINT#s", schema_version: 1, state: "stopped", version: 3, incarnation },
            ConditionExpression: "(attribute_exists(#n0) AND #n1 = :v0 AND #n2 = :v1)",
            ExpressionAttributeNames: { "#n0": "pk", "#n1": "version", "#n2": "incarnation" },
            ExpressionAttributeValues: { ":v0": 2, ":v1": incarnation },
          },
        },
        {
          Delete: {
            TableName: "acme-dev-db-users",
            Key: { pk: "USER#u", sk: "LOGIN#google#s" },
            ConditionExpression: "(attribute_exists(#n0) AND #n1 = :v0 AND attribute_not_exists(#n2))",
            ExpressionAttributeNames: { "#n0": "pk", "#n1": "version", "#n2": "incarnation" },
            ExpressionAttributeValues: { ":v0": 1 },
          },
        },
      ],
    });
  });

  it("update は条件の外れで false を返し、ほかの失敗は投げる", async () => {
    const failed = Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });
    const { sent, client } = fakeClient(() => failed);
    const db = createDb(client, NAMES);
    const key = { pk: "USER#u", sk: "DELEGATION#d" };
    expect(await db.update("users", key, [{ kind: "set", path: "last_used_at", value: "2026-11-21T00:00:00.000Z" }], cond.lt("last_used_at", "2026-11-20T23:00:00.000Z"))).toBe(false);
    expect(inputOf(sent[0], UpdateCommand)).toMatchObject({ TableName: "acme-dev-db-users", Key: key, UpdateExpression: "SET #n0 = :v1", ConditionExpression: "#n0 < :v0" });

    const down = createDb(fakeClient(() => Object.assign(new Error("down"), { name: "InternalServerError" })).client, NAMES);
    await expect(down.update("users", key, [{ kind: "set", path: "x", value: 1 }], cond.exists("pk"))).rejects.toThrow("down");
  });
});

describe("dynamoDocumentClient", () => {
  it("実行環境ごとに 1 つのクライアントを返す", () => {
    expect(dynamoDocumentClient()).toBe(dynamoDocumentClient());
  });
});
