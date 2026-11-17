import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { type DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

// DynamoDB の文書のクライアントの代わり。Put の条件と Get だけを持ち、呼ばれた命令を残す
export class FakeStore {
  rows = new Map<string, Record<string, unknown>>();
  calls: Array<PutCommand | GetCommand> = [];
  failWith: Error | null = null;
  // 条件の確かめと書き込みの間に、別の要求が先に行を作った場面を作る
  raceRow: Record<string, unknown> | null = null;

  asClient(): DynamoDBDocumentClient {
    return { send: (cmd: PutCommand | GetCommand) => this.send(cmd) } as unknown as DynamoDBDocumentClient;
  }

  private key(k: Record<string, unknown>): string {
    return `${String(k.pk)}|${String(k.sk)}`;
  }

  async send(cmd: PutCommand | GetCommand): Promise<unknown> {
    this.calls.push(cmd);
    if (this.failWith) throw this.failWith;
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as Record<string, unknown>;
      const k = this.key(item);
      if (this.raceRow) {
        this.rows.set(k, this.raceRow);
        this.raceRow = null;
      }
      if (cmd.input.ConditionExpression === "attribute_not_exists(pk)" && this.rows.has(k)) {
        throw new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
      }
      this.rows.set(k, item);
      return {};
    }
    if (cmd instanceof GetCommand) {
      return { Item: this.rows.get(this.key(cmd.input.Key as Record<string, unknown>)) };
    }
    throw new Error("想定しない命令");
  }
}
