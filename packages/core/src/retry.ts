import { isHTTPError } from "ky";

// 失敗の分類。呼び手が結果の扱い（409・404・503 など）を決めるためにだけ使い、再試行の判断には使わない。
// 再試行は ky・AWS SDK・p-retry の設定が持つ（決定 13・17）

export type FailureClass = "retryable" | "conflict" | "not_found" | "rejected" | "unknown";

// retryable は失敗の性質（一時の失敗で、時を置けば通り得る）で、ライブラリが繰り返したかは表さない。
// 冪等でない要求の 408・500・502・503・504・時間切れは届いたか分からず繰り返さないが、相手が断ったのでもないため retryable にし、繰り返すかは呼び手が決める
// 408 は callHttp が繰り返す状態（RETRY_STATUS_CODES）と揃える。使い切った 408 は相手が断ったのでなく時間切れ
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// ky の時間切れとネットワークの誤り・AbortSignal.timeout の時間切れ・AWS SDK の呼びすぎ。
// 呼びすぎは HTTP の状態が 400 のもの（DynamoDB の RequestLimitExceeded など）があり、状態では retryable にならないため名前で見る
const RETRYABLE_NAMES = new Set([
  "TimeoutError",
  "NetworkError",
  "ThrottlingException",
  "ThrottledException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "TooManyRequestsException",
  "TransactionConflict",
]);
const CONFLICT_NAMES = new Set(["ConditionalCheckFailedException"]);
const NOT_FOUND_NAMES = new Set(["ResourceNotFoundException"]);
const REJECTED_NAMES = new Set(["ValidationException", "AccessDeniedException"]);

// Node の fetch と AWS SDK が原因の鎖に置くネットワークの誤りの符号
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

// 原因の鎖の深さの上限（循環する cause で止まらないことを防ぐ）
const MAX_CAUSE_DEPTH = 5;

function classOfStatus(status: number): FailureClass {
  if (status === 409) return "conflict";
  if (status === 404) return "not_found";
  if (RETRYABLE_STATUS.has(status)) return "retryable";
  // 3xx は callHttp が転送に従わずに返す応答（redirect: "manual"）。同じ要求を繰り返しても同じ応答のため rejected にし、
  // 転送先（location）へ送り直すか・304 を済みとみなすかは呼び手が状態と頭書きを読んで決める
  if (status >= 300 && status < 400) return "rejected";
  if (status === 501 || (status >= 400 && status < 500)) return "rejected";
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

// TransactWriteItems の取り消しの理由のうち、code を持つものがあるか
function hasCancellationReason(e: Record<string, unknown>, code: string): boolean {
  const reasons = e["CancellationReasons"];
  return e["name"] === "TransactionCanceledException" && Array.isArray(reasons) && reasons.some((r) => isRecord(r) && r["Code"] === code);
}

// AWS SDK の例外が持つ応答の HTTP の状態（$metadata.httpStatusCode）
function awsStatusOf(e: Record<string, unknown>): number | undefined {
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
    // ほかのトランザクションとの衝突（SDK はこれを繰り返さない）は retryable、条件の外れは ConditionalCheckFailedException と同じ conflict
    if (RETRYABLE_NAMES.has(name) || hasCancellationReason(e, "TransactionConflict")) return "retryable";
    if (CONFLICT_NAMES.has(name) || hasCancellationReason(e, "ConditionalCheckFailed")) return "conflict";
    if (NOT_FOUND_NAMES.has(name)) return "not_found";
    if (REJECTED_NAMES.has(name)) return "rejected";
  }
  if (hasNetworkCode(e)) return "retryable";
  // 名前の集合に無い AWS SDK の例外は、応答の HTTP の状態で分ける（再試行を使い切った InternalServerError・ServiceUnavailable は 5xx で retryable）
  const awsStatus = awsStatusOf(e);
  if (awsStatus !== undefined) return classOfStatus(awsStatus);
  // 応答の物（Response・OutboundResult）の状態
  const status = e["status"];
  if (typeof status === "number" && Number.isInteger(status)) return classOfStatus(status);
  return "unknown";
}
