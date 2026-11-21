import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { AuditAppendOnlyError, checkAuditAppendOnly, expressionsOf, type Condition, type TransactItem, type Update } from "./conditional-write.ts";
import { awsClient, type AwsClientConfig } from "./outbound.ts";

// Db のポートと、DynamoDB の文書のクライアントで満たす実装。条件式は conditional-write の expressionsOf だけが書き出す

// 表の用途（docs/design/data.md の「表と鍵」の 10 の表）。実際の名前は起点が環境変数から TableNames で渡す
export const TABLE_PURPOSES = ["users", "teams", "projects", "sprints", "events", "decisions", "notices", "usage", "audit", "idempotency"] as const;

export type TableName = (typeof TABLE_PURPOSES)[number];

export type TableNames = Readonly<Record<TableName, string>>;

// 行の鍵。区切りの鍵だけの表（冪等の鍵）は sk が null
export type RowKey = { readonly pk: string; readonly sk: string | null };

// 書く行。どの行も区切りの鍵と形の版を持つ（docs/design/data.md の「共通の列」）
export type Row = { readonly pk: string; readonly sk?: string; readonly schema_version: number; readonly [column: string]: unknown };

// 読んだ行
export type StoredRow = Readonly<Record<string, unknown>>;

export type SortCondition =
  | { readonly op: "=" | "<" | "<=" | ">" | ">="; readonly value: string | number }
  | { readonly op: "begins_with"; readonly value: string }
  | { readonly op: "between"; readonly low: string | number; readonly high: string | number };

// 鍵の条件。表の本体は pk・sk、索引はその索引の鍵の列を名前で渡す
export type KeyCondition = {
  readonly partition: { readonly column: string; readonly value: string | number };
  readonly sort?: { readonly column: string } & SortCondition;
};

export type QueryOptions = {
  readonly limit?: number;
  readonly startKey?: StoredRow | null;
  readonly descending?: boolean;
};

export type Page = { readonly items: StoredRow[]; readonly lastKey: StoredRow | null };

export type ScanOptions = { readonly limit: number; readonly startKey: RowKey | null; readonly consistent: boolean };

export type Db = {
  get(table: TableName, key: RowKey, consistent: boolean): Promise<StoredRow | null>;
  query(table: TableName, keyCond: KeyCondition, opts: QueryOptions & { readonly consistent: boolean }): Promise<Page>;
  // 索引は結果整合で、候補を出すだけに使う（決定 14）。強い整合の読みを持たない
  queryIndex(table: TableName, index: string, keyCond: KeyCondition, opts: QueryOptions): Promise<Page>;
  // 表の移しだけが使う（API の要求の処理は使わない）
  scan(table: TableName, opts: ScanOptions): Promise<{ readonly items: StoredRow[]; readonly lastKey: RowKey | null }>;
  // 1 つのトランザクションで書く。条件の外れと衝突は SDK の TransactionCanceledException のまま投げる（訳しは writeAtomically）。
  // 記録の表への追記でない件（更新・削除・照らし・条件の無い上書き）があれば送らずに AuditAppendOnlyError を投げる
  transactWrite(items: readonly TransactItem[]): Promise<void>;
  // 1 行の条件つきの更新。条件が外れたら false
  update(table: TableName, key: RowKey, update: Update, condition: Condition): Promise<boolean>;
};

function keyOf(key: RowKey): Record<string, string> {
  return key.sk === null ? { pk: key.pk } : { pk: key.pk, sk: key.sk };
}

function rowKeyOf(raw: Record<string, unknown> | undefined): RowKey | null {
  if (raw === undefined) return null;
  const pk = raw["pk"];
  const sk = raw["sk"];
  if (typeof pk !== "string") return null;
  return { pk, sk: typeof sk === "string" ? sk : null };
}

function keyConditionOf(keyCond: KeyCondition): { KeyConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> } {
  const names: Record<string, string> = { "#kp": keyCond.partition.column };
  const values: Record<string, unknown> = { ":kp": keyCond.partition.value };
  let expression = "#kp = :kp";
  const sort = keyCond.sort;
  if (sort !== undefined) {
    names["#ks"] = sort.column;
    if (sort.op === "begins_with") {
      values[":ks"] = sort.value;
      expression += " AND begins_with(#ks, :ks)";
    } else if (sort.op === "between") {
      values[":kl"] = sort.low;
      values[":kh"] = sort.high;
      expression += " AND #ks BETWEEN :kl AND :kh";
    } else {
      values[":ks"] = sort.value;
      expression += ` AND #ks ${sort.op} :ks`;
    }
  }
  return { KeyConditionExpression: expression, ExpressionAttributeNames: names, ExpressionAttributeValues: values };
}

type TransactWriteItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

// 条件が外れた件は行を返させない（行の値をログや例外に運ばない）
function transactItemOf(item: TransactItem, names: TableNames): TransactWriteItem {
  const TableName = names[item.table];
  const Key = keyOf(item.key);
  switch (item.op) {
    case "put": {
      if (item.item === undefined) throw new TypeError("put の書き込みに行が無い");
      return { Put: { TableName, Item: { ...item.item }, ...expressionsOf(item.condition) } };
    }
    case "update": {
      if (item.update === undefined) throw new TypeError("update の書き込みに更新が無い");
      return { Update: { TableName, Key, ...(expressionsOf(item.condition, item.update) as ReturnType<typeof expressionsOf> & { UpdateExpression: string }) } };
    }
    case "delete":
      return { Delete: { TableName, Key, ...expressionsOf(item.condition) } };
    case "check":
      return { ConditionCheck: { TableName, Key, ...expressionsOf(item.condition) } };
  }
}

export function createDb(client: DynamoDBDocumentClient, names: TableNames): Db {
  return {
    async get(table, key, consistent) {
      const out = await client.send(new GetCommand({ TableName: names[table], Key: keyOf(key), ConsistentRead: consistent }));
      return out.Item ?? null;
    },
    async query(table, keyCond, opts) {
      const out = await client.send(
        new QueryCommand({
          TableName: names[table],
          ...keyConditionOf(keyCond),
          ConsistentRead: opts.consistent,
          ...(opts.limit === undefined ? {} : { Limit: opts.limit }),
          ...(opts.startKey == null ? {} : { ExclusiveStartKey: { ...opts.startKey } }),
          ...(opts.descending === true ? { ScanIndexForward: false } : {}),
        }),
      );
      return { items: out.Items ?? [], lastKey: out.LastEvaluatedKey ?? null };
    },
    async queryIndex(table, index, keyCond, opts) {
      const out = await client.send(
        new QueryCommand({
          TableName: names[table],
          IndexName: index,
          ...keyConditionOf(keyCond),
          ...(opts.limit === undefined ? {} : { Limit: opts.limit }),
          ...(opts.startKey == null ? {} : { ExclusiveStartKey: { ...opts.startKey } }),
          ...(opts.descending === true ? { ScanIndexForward: false } : {}),
        }),
      );
      return { items: out.Items ?? [], lastKey: out.LastEvaluatedKey ?? null };
    },
    async scan(table, opts) {
      const out = await client.send(
        new ScanCommand({
          TableName: names[table],
          Limit: opts.limit,
          ConsistentRead: opts.consistent,
          ...(opts.startKey === null ? {} : { ExclusiveStartKey: keyOf(opts.startKey) }),
        }),
      );
      return { items: out.Items ?? [], lastKey: rowKeyOf(out.LastEvaluatedKey) };
    },
    async transactWrite(items) {
      // writeAtomically を通らずに呼ばれても、記録の表の書き換え・消し・上書きを送らない（I9）
      checkAuditAppendOnly(items);
      await client.send(new TransactWriteCommand({ TransactItems: items.map((item) => transactItemOf(item, names)) }));
    },
    async update(table, key, update, condition) {
      // 記録の表は追記だけ（I9）
      if (table === "audit") throw new AuditAppendOnlyError("記録の表の行を書き換えない（追記だけ）");
      const expressions = expressionsOf(condition, update) as ReturnType<typeof expressionsOf> & { UpdateExpression: string };
      try {
        await client.send(new UpdateCommand({ TableName: names[table], Key: keyOf(key), ...expressions }));
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
  };
}

// 文書のクライアントの構築子。モジュールの最上位に置き、awsClient が実行環境ごとに 1 つだけ作る（方針 dynamodb）
const makeDocumentClient = (config: AwsClientConfig): DynamoDBDocumentClient =>
  DynamoDBDocumentClient.from(new DynamoDBClient(config), { marshallOptions: { removeUndefinedValues: true } });

export function dynamoDocumentClient(): DynamoDBDocumentClient {
  return awsClient(makeDocumentClient, "dynamodb");
}
