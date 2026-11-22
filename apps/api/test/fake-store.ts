import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { type DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createDb, TABLE_PURPOSES, type Db, type TableNames } from "@nd-factory/core/db";

// DynamoDB の文書のクライアントの代わり。トランザクションの Put（無いときだけ作る条件）と Get だけを持ち、呼ばれた命令を残す。
// 横断の部品の createDb をこの偽のクライアントの上に組み、Db のポートを通した命令の形を確かめる
export class FakeStore {
  rows = new Map<string, Record<string, unknown>>();
  calls: Array<TransactWriteCommand | GetCommand> = [];
  failWith: Error | null = null;
  // 条件の確かめと書き込みの間に、別の要求が先に行を作った場面を作る
  raceRow: Record<string, unknown> | null = null;

  asClient(): DynamoDBDocumentClient {
    return { send: (cmd: TransactWriteCommand | GetCommand) => this.send(cmd) } as unknown as DynamoDBDocumentClient;
  }

  // 利用者の表を table の名前で引く Db。ほかの用途の表は同じ名前にそろえる（このテストは利用者の表しか使わない）
  asDb(table: string): Db {
    const names = Object.fromEntries(TABLE_PURPOSES.map((purpose) => [purpose, table])) as TableNames;
    return createDb(this.asClient(), names);
  }

  private key(k: Record<string, unknown>): string {
    return `${String(k.pk)}|${String(k.sk)}`;
  }

  async send(cmd: TransactWriteCommand | GetCommand): Promise<unknown> {
    this.calls.push(cmd);
    if (this.failWith) throw this.failWith;
    if (cmd instanceof TransactWriteCommand) {
      const items = cmd.input.TransactItems ?? [];
      const codes = items.map((entry) => {
        const put = entry.Put;
        if (put === undefined) throw new Error("想定しない件");
        const k = this.key(put.Item as Record<string, unknown>);
        if (this.raceRow) {
          this.rows.set(k, this.raceRow);
          this.raceRow = null;
        }
        const notExists = put.ConditionExpression === "attribute_not_exists(#n0)" && put.ExpressionAttributeNames?.["#n0"] === "pk";
        return notExists && this.rows.has(k) ? "ConditionalCheckFailed" : "None";
      });
      if (codes.includes("ConditionalCheckFailed")) {
        throw new TransactionCanceledException({ message: "Transaction cancelled", $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });
      }
      for (const entry of items) {
        const item = entry.Put?.Item as Record<string, unknown>;
        this.rows.set(this.key(item), item);
      }
      return {};
    }
    if (cmd instanceof GetCommand) {
      return { Item: this.rows.get(this.key(cmd.input.Key as Record<string, unknown>)) };
    }
    throw new Error("想定しない命令");
  }
}
