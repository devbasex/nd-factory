import { RETRY_POLICIES, type AwsRetryPolicy, type HttpRetryPolicy, type RetryPolicyName, type RetryPolicyOf } from "@nd-factory/contracts/data";
import { Readable } from "node:stream";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import ky, { HTTPError, isHTTPError, isNetworkError, isTimeoutError, type Options } from "ky";
import type { Clock } from "./clock.ts";
import type { Logger } from "./log.ts";
import { classifyFailure, type FailureClass } from "./retry.ts";

// 外への呼び出し。HTTP は ky、AWS は SDK の組み込みの再試行に、方針のデータの値を設定として渡すだけにし、待ちの計算を自前で持たない（決定 13・17）

// 送る方法（ky は小文字で比べる）
export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

type PolicyNameOfKind<K extends string> = { [N in RetryPolicyName]: RetryPolicyOf<N> extends { kind: K } ? N : never }[RetryPolicyName];

export type HttpPolicyName = PolicyNameOfKind<"http">;
export type AwsPolicyName = PolicyNameOfKind<"aws">;

// ログの相手の種類
export type OutboundPeer = "github" | "idp" | "push" | "slack" | "api";

export type OutboundRequest = {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  // 文字列はそのまま、ほかの値は JSON にして送る
  body?: unknown;
  // 冪等かは方法でなく呼び手が決める
  idempotent: boolean;
  peer: OutboundPeer;
};

export type OutboundResult = {
  // 応答の無い時間切れとネットワークの誤りは 0
  status: number;
  headers: Record<string, string>;
  body: unknown;
  class: "ok" | FailureClass;
};

export type OutboundDeps = {
  log: Logger;
  clock: Clock;
  // テストで差し替える。既定は組み込みの fetch
  fetch?: (input: Request, init?: RequestInit) => Promise<Response>;
};

export class InsecureUrlError extends Error {
  override name = "InsecureUrlError";
}

const RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504];
const RETRY_AFTER_STATUS_CODES = [429, 503];

// 結果へ写す応答の頭書き。ほか（set-cookie など）は運ばない
const RESULT_HEADERS = ["content-type", "etag", "link", "location", "retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"];

function httpPolicyOf(name: HttpPolicyName): HttpRetryPolicy {
  const policy = RETRY_POLICIES[name];
  if (policy.kind !== "http") throw new TypeError(`方針 ${name} は http の方針でない`);
  return policy;
}

function awsPolicyOf(name: AwsPolicyName): AwsRetryPolicy {
  const policy = RETRY_POLICIES[name];
  if (policy.kind !== "aws") throw new TypeError(`方針 ${name} は aws の方針でない`);
  return policy;
}

function isConnectionRefused(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === "ECONNREFUSED") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// 冪等でない要求は、届かなかったと分かる失敗（接続の拒否・429）だけを繰り返す
function retryWhenNotDelivered({ error }: { error: Error }): boolean {
  if (isHTTPError(error)) return error.response.status === 429;
  return isNetworkError(error) && isConnectionRefused(error);
}

// detail.md の callHttp の手順 (1)(2)。テストが方針のデータの写りを照らせるよう出す
export function kyOptionsOf(req: OutboundRequest, policy: HttpRetryPolicy): Options {
  return {
    method: req.method,
    retry: {
      limit: policy.limit,
      backoffLimit: policy.backoff_limit_ms,
      maxRetryAfter: policy.max_retry_after_ms,
      methods: HTTP_METHODS,
      statusCodes: RETRY_STATUS_CODES,
      afterStatusCodes: RETRY_AFTER_STATUS_CODES,
      retryOnTimeout: req.idempotent,
      ...(req.idempotent ? {} : { shouldRetry: retryWhenNotDelivered }),
    },
    timeout: policy.timeout_ms,
    totalTimeout: policy.total_timeout_ms,
    // 転送に自動で従わない。https: の相手が http: へ 307・308 を返すと、本文が平文の接続へ送り直され得る。3xx は Location を付けた結果で返す
    redirect: "manual",
    // throwHttpErrors は既定の真のまま（偽にすると ky は 2xx でない応答を成功と見て繰り返さない）
  };
}

function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RESULT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

function parseBody(response: Response, text: string): unknown {
  if (text === "") return null;
  if (!(response.headers.get("content-type") ?? "").includes("json")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function bodyOptions(body: unknown): Options {
  if (body === undefined) return {};
  return typeof body === "string" ? { body } : { json: body };
}

export async function callHttp(req: OutboundRequest, policyName: HttpPolicyName, deps: OutboundDeps): Promise<OutboundResult> {
  if (new URL(req.url).protocol !== "https:") throw new InsecureUrlError(`https: でない宛先へは送らない（相手 ${req.peer}）`);
  const policy = httpPolicyOf(policyName);
  const started = deps.clock.epochMs();
  let retries = 0;
  // ログは相手の種類・方法・状態・時間・分類だけ。URL・頭書き・本文は出さない
  const summary = (status: number, cls: OutboundResult["class"]) => ({
    policy: policyName,
    peer: req.peer,
    method: req.method,
    status,
    duration_ms: deps.clock.epochMs() - started,
    class: cls,
    retries,
  });
  const options: Options = {
    ...kyOptionsOf(req, policy),
    ...(req.headers === undefined ? {} : { headers: req.headers }),
    ...bodyOptions(req.body),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    hooks: {
      beforeRetry: [
        ({ error, retryCount }) => {
          retries = retryCount;
          deps.log.warn("外への呼び出しを繰り返す", { policy: policyName, peer: req.peer, attempt: retryCount, class: classifyFailure(error), error: error.name });
        },
      ],
    },
  };
  let result: OutboundResult;
  try {
    const pending = ky(req.url, options);
    const response = await pending;
    // 本文は ky の読み口から読み、timeout と totalTimeout の残りを本文の読み取りにも掛ける（頭書きの後に本文が止まる相手で待ち続けない）
    const text = await pending.text();
    result = { status: response.status, headers: pickHeaders(response.headers), body: parseBody(response, text), class: "ok" };
  } catch (error) {
    result = failureResult(error);
  }
  if (result.class === "ok") deps.log.info("外への呼び出しが済んだ", summary(result.status, result.class));
  // 冪等でない要求の 408・5xx・時間切れは繰り返さずに retryable で返る。使い切ったと書かない
  else if (result.class === "retryable" && retries > 0) deps.log.error("外への呼び出しが再試行を使い切った", summary(result.status, result.class));
  else if (result.class === "retryable") deps.log.error("外への呼び出しが一時の失敗で、繰り返さずに返した", summary(result.status, result.class));
  else deps.log.warn("外への呼び出しを相手が断った", summary(result.status, result.class));
  return result;
}

// detail.md の callHttp の手順 (4)。使い切った 429・5xx と繰り返さない 4xx・時間切れ・ネットワークの誤りは例外にしない
function failureResult(error: unknown): OutboundResult {
  if (error instanceof HTTPError) {
    return { status: error.response.status, headers: pickHeaders(error.response.headers), body: error.data ?? null, class: classifyFailure(error) };
  }
  if (isTimeoutError(error) || isNetworkError(error)) return { status: 0, headers: {}, body: null, class: classifyFailure(error) };
  throw error;
}

type HandleArgs = Parameters<NodeHttpHandler["handle"]>;
type HandleResult = Awaited<ReturnType<NodeHttpHandler["handle"]>>;

function timeoutErrorOf(ms: number): Error {
  // 名前と符号は SDK が一時の失敗として繰り返すもの（TimeoutError・ETIMEDOUT）
  return Object.assign(new Error(`要求が期限 ${ms} ms を過ぎた`), { name: "TimeoutError", code: "ETIMEDOUT" });
}

// 要求 1 回の全体（接続から本文の終わりまで）に期限を掛ける HTTP の扱い手。
// Smithy の requestTimeout（throwOnRequestTimeout を真にしても）は応答の頭書きを受け取ると解かれ、頭書きの後に本文が止まる相手を待ち続ける。
// 本文を読み終えずに返す呼び出し（S3 の GetObject などの流れの本文）には使わない（期限で流れを切る）
export class DeadlineHttpHandler {
  readonly metadata: NodeHttpHandler["metadata"];
  readonly #inner: NodeHttpHandler;
  readonly #timeoutMs: number;

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
    // 頭書きまでは内の扱い手の期限でも切る（TimeoutError）。本文はこの包みが切る
    this.#inner = new NodeHttpHandler({ requestTimeout: timeoutMs, throwOnRequestTimeout: true });
    this.metadata = this.#inner.metadata;
  }

  get requestTimeout(): number {
    return this.#timeoutMs;
  }

  async handle(request: HandleArgs[0], options: HandleArgs[1] = {}): Promise<HandleResult> {
    const ms = options.requestTimeout ?? this.#timeoutMs;
    const timeoutError = timeoutErrorOf(ms);
    const controller = new AbortController();
    let expired = false;
    let body: Readable | undefined;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort(timeoutError);
      body?.destroy(timeoutError);
    }, ms);
    const given = options.abortSignal as AbortSignal | undefined;
    const abortSignal = given === undefined ? controller.signal : AbortSignal.any([given, controller.signal]);
    let result: HandleResult;
    try {
      result = await this.#inner.handle(request, { ...options, abortSignal });
    } catch (error) {
      clearTimeout(timer);
      // 期限で切った要求は AbortError でなく TimeoutError で返す（SDK は AbortError を繰り返さない）
      throw expired ? timeoutError : error;
    }
    const stream = result.response.body as unknown;
    if (stream instanceof Readable && !stream.destroyed) {
      body = stream;
      stream.once("close", () => clearTimeout(timer));
    } else {
      clearTimeout(timer);
    }
    return result;
  }

  updateHttpClientConfig(...args: Parameters<NodeHttpHandler["updateHttpClientConfig"]>): void {
    this.#inner.updateHttpClientConfig(...args);
  }

  httpHandlerConfigs(): ReturnType<NodeHttpHandler["httpHandlerConfigs"]> {
    return this.#inner.httpHandlerConfigs();
  }

  destroy(): void {
    this.#inner.destroy();
  }
}

// AWS SDK のクライアントの構築子へ渡す設定。DynamoDBClient などの設定の型の一部と同じ形
export type AwsClientConfig = {
  retryMode: "standard";
  maxAttempts: number;
  requestHandler: DeadlineHttpHandler;
};

export function awsClientConfigOf(policyName: AwsPolicyName): AwsClientConfig {
  const policy = awsPolicyOf(policyName);
  return { retryMode: policy.retry_mode, maxAttempts: policy.max_attempts, requestHandler: new DeadlineHttpHandler(policy.request_timeout_ms) };
}

// 実行環境ごとの控え。aws-control は ECS・Secrets Manager・STS の 3 つのクライアントが共有するため、構築子と方針の名前の組で引く
const clients = new WeakMap<(config: AwsClientConfig) => unknown, Map<AwsPolicyName, unknown>>();

// 同じ構築子と方針の名前の 2 回目は同じクライアントを返す。構築子は呼ぶたびに作り直さず、モジュールの最上位に置いて渡す
export function awsClient<C>(make: (config: AwsClientConfig) => C, policyName: AwsPolicyName): C {
  let byPolicy = clients.get(make);
  if (byPolicy === undefined) {
    byPolicy = new Map();
    clients.set(make, byPolicy);
  }
  if (byPolicy.has(policyName)) return byPolicy.get(policyName) as C;
  const client = make(awsClientConfigOf(policyName));
  byPolicy.set(policyName, client);
  return client;
}
