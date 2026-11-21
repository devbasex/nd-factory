import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
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

type HandleArgs = Parameters<DeadlineHttpHandler["handle"]>;

function requestTo(port: number): HandleArgs[0] {
  return { protocol: "http:", hostname: "127.0.0.1", port, method: "GET", path: "/", query: {}, headers: {} } as unknown as HandleArgs[0];
}

function answerOk(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
}

async function readAll(body: Readable): Promise<string> {
  let text = "";
  for await (const chunk of body) text += String(chunk);
  return text;
}

// AWS SDK が型で受け付ける従来の Smithy のシグナル（aborted と onabort だけを持つ）
function legacySignal(): { aborted: boolean; onabort: ((this: unknown, ev: unknown) => unknown) | null; abort: () => void } {
  const signal = {
    aborted: false,
    onabort: null as ((this: unknown, ev: unknown) => unknown) | null,
    abort() {
      signal.aborted = true;
      signal.onabort?.call(signal, {});
    },
  };
  return signal;
}

describe("DeadlineHttpHandler の呼び手のシグナル", () => {
  it("従来の Smithy のシグナルを渡しても TypeError を投げずに送り、済んだら onabort を元へ戻す", async () => {
    const port = await listen(answerOk);
    const handler = new DeadlineHttpHandler(1_000);
    const signal = legacySignal();
    const { response } = await handler.handle(requestTo(port), { abortSignal: signal });
    expect(await readAll(response.body as Readable)).toBe("ok");
    expect(signal.onabort).toBeNull();
    handler.destroy();
  }, 10_000);

  it("従来のシグナルを切ると、期限を待たず TimeoutError でない誤りで止まる", async () => {
    const port = await listen(() => undefined);
    const handler = new DeadlineHttpHandler(5_000);
    const signal = legacySignal();
    const started = Date.now();
    const pending = handler.handle(requestTo(port), { abortSignal: signal });
    setTimeout(() => signal.abort(), 50);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1_000);
    handler.destroy();
  }, 10_000);

  it("ネイティブのシグナルを切っても止まり、前から切れたシグナルは送らずに止まる", async () => {
    const port = await listen(() => undefined);
    const handler = new DeadlineHttpHandler(5_000);
    const controller = new AbortController();
    const pending = handler.handle(requestTo(port), { abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await pending.catch((e: unknown) => e)).toMatchObject({ name: "AbortError" });
    const before = received;
    expect(await handler.handle(requestTo(port), { abortSignal: AbortSignal.abort() }).catch((e: unknown) => e)).toMatchObject({ name: "AbortError" });
    expect(received).toBe(before);
    handler.destroy();
  }, 10_000);
});
