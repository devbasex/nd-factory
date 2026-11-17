import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { type DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { UserRow } from "@nd-factory/contracts/users-api";

// 行の形の版。行の列を変えるときに上げ、読む側が古い行を見分けられるようにする
export const SCHEMA_VERSION = 1;

export type StoreOperation = "put" | "get";

// 表に届かなかったことを、失敗した操作と例外の名前だけを持って上へ伝える（行の中身は持たない）
export class StoreError extends Error {
  override name = "StoreError";
  readonly operation: StoreOperation;
  readonly causeName: string;

  constructor(operation: StoreOperation, cause: unknown) {
    const causeName = cause instanceof Error ? cause.name : "Unknown";
    super(`利用者の表の ${operation} が失敗した: ${causeName}`, { cause });
    this.operation = operation;
    this.causeName = causeName;
  }
}

function isConditionFailure(e: unknown): boolean {
  return e instanceof ConditionalCheckFailedException || (e instanceof Error && e.name === "ConditionalCheckFailedException");
}

// 利用者の行を無いときだけ作り、今の行を返す。同じ利用者の要求が重なっても created_at は最初の 1 回のまま
export async function ensureUser(client: DynamoDBDocumentClient, table: string, sub: string, now: Date): Promise<UserRow> {
  if (sub.length === 0) throw new Error("利用者の ID が空");
  const key = { pk: `USER#${sub}`, sk: "PROFILE" };
  const createdAt = now.toISOString();
  try {
    await client.send(
      new PutCommand({
        TableName: table,
        Item: { ...key, schema_version: SCHEMA_VERSION, created_at: createdAt },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return { id: sub, created_at: createdAt };
  } catch (e) {
    if (!isConditionFailure(e)) throw new StoreError("put", e);
  }

  // 行はもうある。書いた直後の行を確実に読むため、強い整合の読みにする
  let item: Record<string, unknown> | undefined;
  try {
    const out = await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
    item = out.Item;
  } catch (e) {
    throw new StoreError("get", e);
  }
  if (!item || typeof item.created_at !== "string") {
    throw new StoreError("get", new Error("行が無いか形が違う"));
  }
  return { id: sub, created_at: item.created_at };
}
