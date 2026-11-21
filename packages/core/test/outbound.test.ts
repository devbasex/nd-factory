import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { RETRY_POLICIES } from "@nd-factory/contracts/data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClock } from "../src/clock.ts";
import { createLogger } from "../src/log.ts";
import { awsClient, awsClientConfigOf, callHttp, InsecureUrlError, kyOptionsOf, type AwsClientConfig, type OutboundRequest } from "../src/outbound.ts";
import { leakedSecrets, SECRET_SAMPLES } from "./fixtures/secrets.ts";

// HTTP は fetch の差し替えと偽のタイマーで確かめる。AWS は呼ばない

type Call = { at: number; method: string; url: string; headers: Headers; body: string };

// 決まった応答を順に返す偽の fetch。呼ばれた時刻（偽の時計）と要求を控える
function fakeFetch(answers: (() => Response | Promise<Response>)[] | (() => Response | Promise<Response>)) {
  const calls: Call[] = [];
  const fetch = async (input: Request): Promise<Response> => {
    calls.push({ at: Date.now(), method: input.method, url: input.url, headers: input.headers, body: await input.clone().text() });
    const answer = Array.isArray(answers) ? answers[Math.min(calls.length, answers.length) - 1] : answers;
    if (answer === undefined) throw new Error("応答が無い");
    return answer();
  };
  return { calls, fetch };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// 要求の signal が切られるまで応答しない（時間切れの相手）
function hang(input: Request): Promise<Response> {
  return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason as Error)));
}

function refused(): Promise<Response> {
  return Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }));
}

function logs() {
  const lines: string[] = [];
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, records, log: createLogger({ request_id: "req-1", fn: "runner", endpoint: "runner" }, (line) => lines.push(line)) };
}

const get = (url = "https://api.example.com/v1/repos"): OutboundRequest => ({ method: "get", url, idempotent: true, peer: "github" });
const post = (body: unknown = { title: "x" }): OutboundRequest => ({ method: "post", url: "https://api.example.com/v1/issues", body, idempotent: false, peer: "github" });

// 偽のタイマーを最後まで進めて結果を待つ
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

function gaps(calls: Call[]): number[] {
  return calls.slice(1).map((call, i) => call.at - (calls[i]?.at ?? 0));
}

describe("callHttp", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 21) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("方針のデータが ky の retry・timeout・totalTimeout に写り、throwHttpErrors を偽にしない", () => {
    const policy = RETRY_POLICIES["http-github"];
    const idempotent = kyOptionsOf(get(), policy);
    expect(idempotent).toMatchObject({
      method: "get",
      timeout: 10_000,
      totalTimeout: 30_000,
      retry: {
        limit: 3,
        backoffLimit: 5_000,
        maxRetryAfter: 5_000,
        statusCodes: [408, 429, 500, 502, 503, 504],
        afterStatusCodes: [429, 503],
        retryOnTimeout: true,
      },
    });
    expect(idempotent.retry).toMatchObject({ methods: expect.arrayContaining(["get", "post", "put", "patch", "delete"]) });
    expect(idempotent.retry).not.toHaveProperty("shouldRetry");
    expect(idempotent.throwHttpErrors).not.toBe(false);
    const once = kyOptionsOf(post(), policy);
    expect(once.retry).toMatchObject({ retryOnTimeout: false, shouldRetry: expect.any(Function) });
  });

  it("200 の本文と分類 ok と頭書きの一部を返し、要求の方法・頭書き・本文を送る", async () => {
    const { calls, fetch } = fakeFetch([json(201, { number: 7 }, { etag: '"v1"', "set-cookie": "s=1" })]);
    const { log, records } = logs();
    const result = await settle(
      callHttp({ ...post({ title: "x" }), headers: { accept: "application/json" } }, "http-github", { log, clock: createClock(), fetch }),
    );
    expect(result).toEqual({ status: 201, headers: { "content-type": "application/json", etag: '"v1"' }, body: { number: 7 }, class: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.example.com/v1/issues", body: '{"title":"x"}' });
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
    expect(records()).toMatchObject([{ level: "info", policy: "http-github", peer: "github", method: "post", status: 201, class: "ok" }]);
  });

  it("文字列の本文はそのまま送り、JSON でない応答は文字で返す", async () => {
    const { calls, fetch } = fakeFetch([() => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })]);
    const result = await settle(callHttp({ ...post(), body: "raw" }, "http-notify", { log: logs().log, clock: createClock(), fetch }));
    expect(calls[0]?.body).toBe("raw");
    expect(result).toMatchObject({ status: 200, body: "ok", class: "ok" });
  });

  it("冪等な要求の 503 は Retry-After を方針の上限まで守って繰り返し、使い切ると例外でなく結果で返す", async () => {
    const { calls, fetch } = fakeFetch(json(503, { message: "busy" }, { "retry-after": "60" }));
    const { log, records } = logs();
    const result = await settle(callHttp(get(), "http-github", { log, clock: createClock(), fetch }));
    expect(calls).toHaveLength(4);
    expect(gaps(calls)).toEqual([5_000, 5_000, 5_000]);
    expect(result).toEqual({ status: 503, headers: { "content-type": "application/json", "retry-after": "60" }, body: { message: "busy" }, class: "retryable" });
    const levels = records().map((r) => r["level"]);
    expect(levels).toEqual(["warn", "warn", "warn", "error"]);
    expect(records()[0]).toMatchObject({ policy: "http-github", attempt: 1, class: "retryable" });
  });

  it("冪等な要求の 500 は方針の待ちの上限の中で繰り返す", async () => {
    const { calls, fetch } = fakeFetch([json(500, {}), json(500, {}), json(200, { ok: true })]);
    const result = await settle(callHttp(get(), "runner-to-api", { log: logs().log, clock: createClock(), fetch }));
    expect(calls).toHaveLength(3);
    for (const gap of gaps(calls)) expect(gap).toBeLessThanOrEqual(RETRY_POLICIES["runner-to-api"].backoff_limit_ms);
    expect(result).toMatchObject({ status: 200, body: { ok: true }, class: "ok" });
  });

  it("冪等でない POST の 503 は繰り返さない", async () => {
    const { calls, fetch } = fakeFetch(json(503, {}, { "retry-after": "1" }));
    const result = await settle(callHttp(post(), "http-github", { log: logs().log, clock: createClock(), fetch }));
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ status: 503, class: "retryable" });
  });

  it("冪等でない POST の 429 は Retry-After を守って繰り返す", async () => {
    const { calls, fetch } = fakeFetch(json(429, {}, { "retry-after": "1" }));
    const result = await settle(callHttp(post(), "http-github", { log: logs().log, clock: createClock(), fetch }));
    expect(calls).toHaveLength(4);
    expect(gaps(calls)).toEqual([1_000, 1_000, 1_000]);
    expect(result).toMatchObject({ status: 429, class: "retryable" });
  });

  it.each([
    [404, "not_found"],
    [409, "conflict"],
    [422, "rejected"],
  ])("4xx（%i）は繰り返さず、例外でなく %s の結果で返す", async (status, expected) => {
    const { calls, fetch } = fakeFetch(json(status, { message: "no" }));
    const { log, records } = logs();
    const result = await settle(callHttp(get(), "http-github", { log, clock: createClock(), fetch }));
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ status, headers: { "content-type": "application/json" }, body: { message: "no" }, class: expected });
    expect(records()).toMatchObject([{ level: "warn", status, class: expected }]);
  });

  it.each([
    ["冪等なら繰り返す", get(), true],
    ["冪等でなければ繰り返さない（届いたか分からない）", post(), false],
  ])("時間切れは、%s。どちらも状態 0 の retryable で返す", async (_why, req, retried) => {
    let count = 0;
    const fetch = (input: Request) => {
      count += 1;
      return hang(input);
    };
    const result = await settle(callHttp(req, "http-github", { log: logs().log, clock: createClock(), fetch }));
    expect(count > 1).toBe(retried);
    expect(result).toEqual({ status: 0, headers: {}, body: null, class: "retryable" });
  });

  it("冪等でない要求も、接続の拒否（届かなかった）は繰り返す", async () => {
    let count = 0;
    const fetch = () => {
      count += 1;
      return refused();
    };
    const result = await settle(callHttp(post(), "http-github", { log: logs().log, clock: createClock(), fetch }));
    expect(count).toBe(4);
    expect(result).toEqual({ status: 0, headers: {}, body: null, class: "retryable" });
  });

  it("冪等でない要求の、接続の拒否でないネットワークの誤りは繰り返さない", async () => {
    let count = 0;
    const fetch = () => {
      count += 1;
      return Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }));
    };
    const result = await settle(callHttp(post(), "http-github", { log: logs().log, clock: createClock(), fetch }));
    expect(count).toBe(1);
    expect(result).toMatchObject({ status: 0, class: "retryable" });
  });

  it("http: の URL は送る前に止まる", async () => {
    const { calls, fetch } = fakeFetch(json(200, {}));
    await expect(callHttp(get("http://api.example.com/v1/repos"), "http-github", { log: logs().log, clock: createClock(), fetch })).rejects.toBeInstanceOf(InsecureUrlError);
    expect(calls).toHaveLength(0);
  });

  it("ログに URL の問い合わせの部分・頭書き・本文・token を出さない", async () => {
    const token = SECRET_SAMPLES["github_app_token"] ?? "";
    const { fetch } = fakeFetch([json(500, { echoed: token }), json(200, { token })]);
    const { log, lines } = logs();
    await settle(
      callHttp(
        { ...get("https://api.example.com/v1/repos?code=qwerty"), headers: { authorization: `Bearer ${token}` }, body: undefined },
        "http-github",
        { log, clock: createClock(), fetch },
      ),
    );
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(text).not.toContain("qwerty");
    expect(text).not.toContain("api.example.com");
    expect(text).not.toContain("echoed");
    expect(leakedSecrets(text)).toEqual([]);
  });

  it("http でない方針の名前は型で弾く", () => {
    const deps = { log: logs().log, clock: createClock() };
    // @ts-expect-error dynamodb は aws の方針
    const call = () => callHttp(get(), "dynamodb", deps);
    expect(typeof call).toBe("function");
  });
});

describe("awsClient", () => {
  const makeDynamo = (config: AwsClientConfig) => new DynamoDBClient({ region: "us-west-2", ...config });

  async function requestTimeoutOf(client: DynamoDBClient): Promise<number | undefined> {
    const handler = client.config.requestHandler as unknown as { configProvider?: Promise<{ requestTimeout?: number }> };
    return (await handler.configProvider)?.requestTimeout;
  }

  it("方針の retryMode・回数・要求の時間切れを持つクライアントを作る", async () => {
    const client = awsClient(makeDynamo, "dynamodb");
    expect(client.config.retryMode).toBe("standard");
    expect(await client.config.maxAttempts()).toBe(3);
    expect(await requestTimeoutOf(client)).toBe(2_000);
  });

  it("構築子へ渡す設定は方針のデータの値", () => {
    expect(awsClientConfigOf("dynamodb")).toEqual({ retryMode: "standard", maxAttempts: 3, requestHandler: { requestTimeout: 2_000 } });
    expect(awsClientConfigOf("aws-control")).toEqual({ retryMode: "standard", maxAttempts: 3, requestHandler: { requestTimeout: 5_000 } });
  });

  it("同じ構築子と方針の 2 回目は同じインスタンスで、構築子を 1 回だけ呼ぶ", () => {
    const make = vi.fn((config: AwsClientConfig) => ({ config }));
    const first = awsClient(make, "aws-control");
    expect(awsClient(make, "aws-control")).toBe(first);
    expect(make).toHaveBeenCalledTimes(1);
    expect(awsClient(make, "dynamodb")).not.toBe(first);
  });

  it("同じ方針でも構築子が違えば別のクライアント（aws-control を共有する ECS・STS など）", () => {
    const makeA = (config: AwsClientConfig) => ({ kind: "a", config });
    const makeB = (config: AwsClientConfig) => ({ kind: "b", config });
    expect(awsClient(makeA, "aws-control").kind).toBe("a");
    expect(awsClient(makeB, "aws-control").kind).toBe("b");
  });

  it("aws でない方針の名前は型で弾く", () => {
    // @ts-expect-error http-github は http の方針
    const call = () => awsClient(makeDynamo, "http-github");
    expect(typeof call).toBe("function");
  });
});
