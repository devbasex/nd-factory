import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import { awsClientConfigOf, DeadlineHttpHandler, type AwsClientConfig } from "../src/outbound.ts";

// AWS SDK の要求の期限を、127.0.0.1 の実のソケットと実のタイマーで確かめる。AWS には繋がない

let server: Server | undefined;
let received = 0;

async function listen(onRequest: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  received = 0;
  server = createServer((req, res) => {
    received += 1;
    onRequest(req, res);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

function dynamoAt(port: number, config: AwsClientConfig, maxAttempts: number): DynamoDBClient {
  return new DynamoDBClient({
    region: "us-west-2",
    ...config,
    maxAttempts,
    endpoint: `http://127.0.0.1:${port}`,
    credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "test" },
  });
}

async function timed(client: DynamoDBClient): Promise<{ error: unknown; elapsed: number }> {
  const started = Date.now();
  const error = await client.send(new DescribeTableCommand({ TableName: "t" })).catch((e: unknown) => e);
  client.destroy();
  return { error, elapsed: Date.now() - started };
}

// 頭書きと本文の最初の一片だけを返し、本文を閉じない
function stallBody(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/x-amz-json-1.0", "content-length": "1000" });
  res.write('{"Table":');
}

describe("awsClient の要求の期限", () => {
  it("応答しない相手は、方針の期限で警告だけで待ち続けず TimeoutError で切る", async () => {
    const port = await listen(() => undefined);
    const config = awsClientConfigOf("dynamodb");
    const { error, elapsed } = await timed(dynamoAt(port, config, 1));
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(elapsed).toBeLessThan(config.requestHandler.requestTimeout + 1_500);
  }, 10_000);

  it("頭書きの後に本文が止まる相手も、期限で TimeoutError で切る", async () => {
    const port = await listen(stallBody);
    const { error, elapsed } = await timed(dynamoAt(port, { ...awsClientConfigOf("dynamodb"), requestHandler: new DeadlineHttpHandler(150) }, 1));
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(150 + 1_000);
  }, 10_000);

  it("本文が止まって切った要求は、SDK が一時の失敗として繰り返す", async () => {
    const port = await listen(stallBody);
    const { error } = await timed(dynamoAt(port, { ...awsClientConfigOf("dynamodb"), requestHandler: new DeadlineHttpHandler(150) }, 2));
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(received).toBe(2);
  }, 10_000);

  it("期限の内に本文を読み終えた要求は成功し、後で期限が来ても何も起きない", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
      res.end(JSON.stringify({ Table: { TableName: "t" } }));
    });
    const client = dynamoAt(port, { ...awsClientConfigOf("dynamodb"), requestHandler: new DeadlineHttpHandler(150) }, 1);
    const result = await client.send(new DescribeTableCommand({ TableName: "t" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    client.destroy();
    expect(result.Table?.TableName).toBe("t");
  }, 10_000);
});
