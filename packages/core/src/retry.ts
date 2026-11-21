import { isHTTPError } from "ky";

// 失敗の分類。呼び手が結果の扱い（409・404・503 など）を決めるためにだけ使い、再試行の判断には使わない。
// 再試行は ky・AWS SDK・p-retry の設定が持つ（決定 13・17）

export type FailureClass = "retryable" | "conflict" | "not_found" | "rejected" | "unknown";

// retryable は失敗の性質（一時の失敗で、時を置けば通り得る）で、ライブラリが繰り返したかは表さない。
// 冪等でない要求の 408・500・502・503・504・時間切れは届いたか分からず繰り返さないが、相手が断ったのでもないため retryable にし、繰り返すかは呼び手が決める
// 408 は callHttp が繰り返す状態（RETRY_STATUS_CODES）と揃える。使い切った 408 は相手が断ったのでなく時間切れ
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// ky の時間切れとネットワークの誤り・AbortSignal.timeout の時間切れ・AWS SDK の呼びすぎと相手の障害（SDK が再試行を使い切った後に届く）。
// 呼びすぎは HTTP の状態が 400 のもの（DynamoDB の RequestLimitExceeded など）があり、状態では retryable にならないため名前で見る
const RETRYABLE_NAMES = new Set([
  "TimeoutError",
  "NetworkError",
  "ThrottlingException",
  "ThrottledException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "TooManyRequestsException",
  "InternalServerError",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "InternalServerErrorException",
  "RequestTimeout",
  "RequestTimeoutException",
  "TransactionInProgressException",
  "TransactionConflict",
]);
const CONFLICT_NAMES = new Set(["ConditionalCheckFailedException"]);
const NOT_FOUND_NAMES = new Set(["ResourceNotFoundException"]);
// 表が要求を断ったと言い切れる例外。要求の形の誤り・権限の無さ・資格の誤り・項目の集まりの大きさの上限で、再実行しても通らない
const REJECTED_NAMES = new Set([
  "ValidationException",
  "AccessDeniedException",
  "SerializationException",
  "ItemCollectionSizeLimitExceededException",
  "UnrecognizedClientException",
]);

// Node の fetch と AWS SDK が原因の鎖に置くネットワークの誤りの符号
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

// 原因の鎖の深さの上限（循環する cause で止まらないことを防ぐ）
const MAX_CAUSE_DEPTH = 5;

// 3xx は rejected。callHttp は転送に従わず（redirect: "manual"）、同じ要求を送り直しても同じ応答のため、location を見て決めるのは呼び手（304 も同じ）
function classOfStatus(status: number): FailureClass {
  if (status === 409) return "conflict";
  if (status === 404) return "not_found";
  if (RETRYABLE_STATUS.has(status)) return "retryable";
  // 3xx は callHttp が転送に従わずに返す応答（redirect: "manual"）。同じ要求を繰り返しても同じ応答のため rejected にし、
  // 転送先（location）へ送り直すか・304 を済みとみなすかは呼び手が状態と頭書きを読んで決める
  if (status === 501 || (status >= 300 && status < 500)) return "rejected";
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

// TransactWriteItems の取り消しの理由のうち一時の失敗。ほかのトランザクションとの衝突と、書き込みの呼びすぎ・容量の不足（SDK はトランザクションの取り消しを繰り返さない）。
// 取り消しは HTTP の状態が 400 のため、状態へ落とす前に理由で見る
const RETRYABLE_CANCELLATION_CODES = new Set(["TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded", "RequestLimitExceeded"]);

// TransactWriteItems の取り消しの理由のうち、条件の外れ（ConditionalCheckFailedException と同じ conflict）
const CONFLICT_CANCELLATION_CODES = new Set(["ConditionalCheckFailed"]);

// TransactWriteItems の取り消しの理由のうち、表が断ったと言い切れるもの（行の形の誤りと、項目の集まりの大きさの上限）
const REJECTED_CANCELLATION_CODES = new Set(["ValidationError", "ItemCollectionSizeLimitExceeded"]);

// TransactWriteItems の取り消しの理由のうち、codes のどれかを持つものがあるか
function hasCancellationCode(e: Record<string, unknown>, codes: ReadonlySet<string>): boolean {
  const reasons = e["CancellationReasons"];
  return (
    e["name"] === "TransactionCanceledException" &&
    Array.isArray(reasons) &&
    reasons.some((r) => isRecord(r) && typeof r["Code"] === "string" && codes.has(r["Code"]))
  );
}

// AWS SDK の例外が持つ応答の HTTP の状態（$metadata.httpStatusCode）
function sdkStatusOf(e: Record<string, unknown>): number | undefined {
  const metadata = e["$metadata"];
  if (!isRecord(metadata)) return undefined;
  const status = metadata["httpStatusCode"];
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function hasNetworkCode(e: unknown): boolean {
  let current: unknown = e;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isRecord(current); depth += 1) {
    const code = current["code"];
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    current = current["cause"];
  }
  return false;
}

export function classifyFailure(e: unknown): FailureClass {
  if (typeof e === "number") return classOfStatus(e);
  if (isHTTPError(e)) return classOfStatus(e.response.status);
  if (!isRecord(e)) return "unknown";
  const name = e["name"];
  if (typeof name === "string") {
    // 一時の失敗の取り消しの理由を、条件の外れ・断った理由より先に見る（時を置けば通り得る件があれば retryable）
    if (RETRYABLE_NAMES.has(name) || hasCancellationCode(e, RETRYABLE_CANCELLATION_CODES)) return "retryable";
    if (CONFLICT_NAMES.has(name) || hasCancellationCode(e, CONFLICT_CANCELLATION_CODES)) return "conflict";
    if (NOT_FOUND_NAMES.has(name)) return "not_found";
    if (REJECTED_NAMES.has(name) || hasCancellationCode(e, REJECTED_CANCELLATION_CODES)) return "rejected";
  }
  if (hasNetworkCode(e)) return "retryable";
  // 名前が集合に無い AWS SDK の例外は応答の状態で分ける（classOfStatus と同じ。429・500・502・503・504 は retryable、501 と 400 でない 3xx・4xx は rejected、ほかの 5xx は unknown）。
  // ただし 400 は DynamoDB が一時の失敗にも返す状態のため、名前で分からない 400 は unknown のままにする
  const sdkStatus = sdkStatusOf(e);
  if (sdkStatus !== undefined && sdkStatus !== 400) return classOfStatus(sdkStatus);
  // 応答の物（Response・OutboundResult）の状態
  const status = e["status"];
  if (typeof status === "number" && Number.isInteger(status)) return classOfStatus(status);
  return "unknown";
}
