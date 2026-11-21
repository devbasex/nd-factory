import { RETRY_POLICIES, type AwsRetryPolicy, type HttpRetryPolicy, type RetryPolicyName, type RetryPolicyOf } from "@nd-factory/contracts/data";
import { Readable } from "node:stream";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import ky, { type AfterResponseHook, HTTPError, isForceRetryError, isHTTPError, isNetworkError, isTimeoutError, NetworkError, type Options, TimeoutError } from "ky";
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

// 本文の読み取りの期限切れの印
const BODY_TIMED_OUT = Symbol("body timed out");

// 試行ごとの期限。ky の timeout と同じく、試行の fetch を呼んだ時点から ms で切れる。
// 本文の読み取りは、頭書きを待った時間を引いた残りの中で行う（頭書きと本文の合計が timeout_ms を超えない）
type AttemptDeadline = { expired: Promise<typeof BODY_TIMED_OUT>; clear: () => void };

function startAttemptDeadline(ms: number): AttemptDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof BODY_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(BODY_TIMED_OUT), ms);
    // 全体の期限で ky が先に切った後もこの待ちは残るため、プロセスの終わりを引き止めない
    timer.unref?.();
  });
  return { expired, clear: () => clearTimeout(timer) };
}

// 本文を試行の期限の中で読み切る。期限を過ぎたら読み手を取り消して流れを止め、印を返す。読み取りの誤り（接続の切断など）はそのまま投げる
async function readBodyWithin(response: Response, expired: Promise<typeof BODY_TIMED_OUT>): Promise<string | typeof BODY_TIMED_OUT> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const read = (async () => {
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  })();
  const out = await Promise.race([read, expired]);
  if (out === BODY_TIMED_OUT) {
    read.catch(() => undefined);
    // 写し（clone）の取り消しは、元の流れも取り消されるまで決着しないため待たない。元の流れは ky が取り消す
    reader.cancel().catch(() => undefined);
  }
  return out;
}

// detail.md の callHttp の手順 (3)。2xx の本文を ky の再試行の中（afterResponse）で、その試行の期限（方針の timeout_ms から頭書きまでの時間を引いた残り。全体の期限は ky が掛ける）の中で読み切る。
// 本文の時間切れと読み取りの誤りは、冪等な要求なら ky.retry で残りの回数を使って繰り返し、冪等でない要求なら（2xx を受けたため届いている）繰り返さずに TimeoutError・NetworkError で返す
function readBodyInRetry(req: OutboundRequest, attemptDeadline: () => AttemptDeadline): AfterResponseHook {
  return async ({ request, response }) => {
    if (!response.ok) return undefined;
    let failure: Error;
    try {
      const text = await readBodyWithin(response, attemptDeadline().expired);
      if (text !== BODY_TIMED_OUT) {
        return new Response(text === "" ? null : text, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      failure = new TimeoutError(request);
    } catch (error) {
      failure = new NetworkError(request, { cause: error instanceof Error ? error : undefined });
    }
    if (req.idempotent) return ky.retry({ code: "BODY_READ", cause: failure });
    throw failure;
  };
}

// ky.retry で繰り返した失敗は ForceRetryError に包まれて届く。分類とログは包みの中の失敗で見る
function unwrapForced(error: unknown): unknown {
  return isForceRetryError(error) && error.cause !== undefined ? error.cause : error;
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
  // 試行ごとの期限は fetch を呼んだ時点で掛け直す。ky は試行ごとに fetch を呼ぶ
  let deadline: AttemptDeadline | undefined;
  const baseFetch = deps.fetch ?? ((input: Request, init?: RequestInit) => globalThis.fetch(input, init));
  const fetchWithDeadline = (input: Request, init?: RequestInit): Promise<Response> => {
    deadline?.clear();
    deadline = startAttemptDeadline(policy.timeout_ms);
    return baseFetch(input, init);
  };
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
    fetch: fetchWithDeadline,
    hooks: {
      // afterResponse は fetch の後にだけ呼ばれるため、期限は必ずある
      afterResponse: [readBodyInRetry(req, () => deadline ?? startAttemptDeadline(policy.timeout_ms))],
      beforeRetry: [
        ({ error, retryCount }) => {
          retries = retryCount;
          const cause = unwrapForced(error);
          const name = cause instanceof Error ? cause.name : error.name;
          deps.log.warn("外への呼び出しを繰り返す", { policy: policyName, peer: req.peer, attempt: retryCount, class: classifyFailure(cause), error: name });
        },
      ],
    },
  };
  let result: OutboundResult;
  // 最後の失敗を方針が繰り返す対象としていたか。冪等でない要求は 429 を繰り返した後の 503 のように、回数が残っていても対象の外で止まる
  let lastRetriable = false;
  try {
    const pending = ky(req.url, options);
    const response = await pending;
    // 2xx の本文は afterResponse で読み切った写しのため、ここでは待たない
    const text = await pending.text();
    result = { status: response.status, headers: pickHeaders(response.headers), body: parseBody(response, text), class: "ok" };
  } catch (thrown) {
    const error = unwrapForced(thrown);
    result = failureResult(error);
    lastRetriable = req.idempotent || (error instanceof Error && retryWhenNotDelivered({ error }));
  } finally {
    deadline?.clear();
  }
  if (result.class === "ok") deps.log.info("外への呼び出しが済んだ", summary(result.status, result.class));
  // 繰り返した回数が正でも、最後の失敗が繰り返す対象の外（冪等でない要求の 408・500・502・503・504・時間切れ）なら使い切ったと書かない
  else if (result.class === "retryable" && retries > 0 && lastRetriable) deps.log.error("外への呼び出しが再試行を使い切った", summary(result.status, result.class));
  else if (result.class === "retryable") deps.log.error("外への呼び出しが一時の失敗で、繰り返さずに返した", summary(result.status, result.class));
  // 3xx は転送に従わずに返した応答（分類は rejected）。相手が断ったのでないため別の文言にする
  else if (result.status >= 300 && result.status < 400) deps.log.warn("外への呼び出しが 3xx を返し、転送に従わずに返した", summary(result.status, result.class));
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

type GivenAbortSignal = NonNullable<NonNullable<HandleArgs[1]>["abortSignal"]>;

// 呼び手のシグナル（ネイティブの AbortSignal か、aborted と onabort だけを持つ従来の Smithy のシグナル）が切れたら controller を切る。
// AbortSignal.any は従来のシグナルを受け付けず TypeError を投げるため使わない。戻り値は繋ぎを解く関数
function linkAbort(given: GivenAbortSignal | undefined, controller: AbortController): () => void {
  if (given === undefined) return () => undefined;
  const abort = () => controller.abort("reason" in given ? given.reason : undefined);
  if (given.aborted) {
    abort();
    return () => undefined;
  }
  if ("addEventListener" in given && typeof given.addEventListener === "function") {
    const signal = given as AbortSignal;
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }
  // 従来のシグナルは onabort の 1 つだけを持つ。前の扱いを残して繋ぐ
  const previous = given.onabort;
  const chained = function (this: unknown, ...args: unknown[]): unknown {
    abort();
    return typeof previous === "function" ? (previous as (...a: unknown[]) => unknown).apply(this, args) : undefined;
  };
  given.onabort = chained;
  return () => {
    if (given.onabort === chained) given.onabort = previous;
  };
}

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlink: () => void = () => undefined;
    const release = () => {
      clearTimeout(timer);
      unlink();
    };
    let result: HandleResult;
    try {
      unlink = linkAbort(options.abortSignal, controller);
      timer = setTimeout(() => {
        expired = true;
        controller.abort(timeoutError);
        body?.destroy(timeoutError);
      }, ms);
      // 呼び手が本文を読まずに捨てると close が来ず期限まで残るため、プロセスの終わり（設置のコマンドなど）を引き止めない。
      // 読み途中の要求はソケットがイベントループを保つため、期限は変わらず効く
      timer.unref();
      result = await this.#inner.handle(request, { ...options, abortSignal: controller.signal });
    } catch (error) {
      release();
      // 期限で切った要求は AbortError でなく TimeoutError で返す（SDK は AbortError を繰り返さない）
      throw expired ? timeoutError : error;
    }
    const stream = result.response.body as unknown;
    if (stream instanceof Readable && !stream.destroyed) {
      body = stream;
      stream.once("close", release);
    } else {
      release();
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

// AWS SDK のクライアントの class（DynamoDBClient・ECSClient など）。awsClient は方針の設定だけを渡して作る
export type AwsClientClass<C> = new (config: AwsClientConfig) => C;

// 実行環境ごとの控え。aws-control は ECS・Secrets Manager・STS の 3 つのクライアントが共有するため、クライアントの class と方針の名前の組で引く。
// class はモジュールの読み込みで 1 つに決まるため、呼び手が呼び出しの場で書いても同じ鍵になる（呼び出しの場で書く関数を鍵にすると、呼ぶたびに作り直す）
const clients = new WeakMap<AwsClientClass<unknown>, Map<AwsPolicyName, unknown>>();

// 同じ class と方針の名前の 2 回目は同じクライアントを返す。地域・資格情報・端点は渡さず、SDK が実行環境（AWS_REGION・AWS_ENDPOINT_URL_* など）から読む
// 期限は本文の読み終わりまで掛かるため、流れの本文を返すクライアント（S3 の GetObject など）には使わない（outbound-socket.test.ts が期限で流れを切る挙動を固める）
export function awsClient<C>(Client: AwsClientClass<C>, policyName: AwsPolicyName): C {
  let byPolicy = clients.get(Client);
  if (byPolicy === undefined) {
    byPolicy = new Map();
    clients.set(Client, byPolicy);
  }
  if (byPolicy.has(policyName)) return byPolicy.get(policyName) as C;
  const client = new Client(awsClientConfigOf(policyName));
  byPolicy.set(policyName, client);
  return client;
}
