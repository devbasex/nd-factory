import ky, { HTTPError, NetworkError, TimeoutError } from "ky";
import { describe, expect, it } from "vitest";
import { classifyFailure, isRetryableCancellation } from "../src/retry.ts";

function awsError(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 400 }, ...extra });
}

// ky が投げる誤りを、差し替えた fetch から作る
async function kyFailure(fetch: (input: Request) => Promise<Response>): Promise<unknown> {
  try {
    await ky("https://api.example.com/v1/x", { fetch, retry: 0 });
  } catch (error) {
    return error;
  }
  throw new Error("ky が投げなかった");
}

// 304 は本文を持てない
const answer = (status: number) => () => Promise.resolve(new Response(status === 304 ? null : "{}", { status, headers: { "content-type": "application/json" } }));

describe("classifyFailure", () => {
  it.each([
    [408, "retryable"],
    [429, "retryable"],
    [500, "retryable"],
    [502, "retryable"],
    [503, "retryable"],
    [504, "retryable"],
    [301, "rejected"],
    [304, "rejected"],
    [307, "rejected"],
    [308, "rejected"],
    [409, "conflict"],
    [404, "not_found"],
    [400, "rejected"],
    [401, "rejected"],
    [403, "rejected"],
    [422, "rejected"],
    [501, "rejected"],
    [505, "unknown"],
    [200, "unknown"],
  ])("HTTP の状態 %i は %s", async (status, expected) => {
    expect(classifyFailure(status)).toBe(expected);
    expect(classifyFailure({ status })).toBe(expected);
    if (status >= 300) {
      const error = await kyFailure(answer(status));
      expect(error).toBeInstanceOf(HTTPError);
      expect(classifyFailure(error)).toBe(expected);
    }
  });

  it.each([
    ["ThrottlingException", "retryable"],
    ["ProvisionedThroughputExceededException", "retryable"],
    ["RequestLimitExceeded", "retryable"],
    ["InternalServerError", "retryable"],
    ["ServiceUnavailable", "retryable"],
    ["TransactionConflict", "retryable"],
    ["TransactionInProgressException", "retryable"],
    ["RequestTimeout", "retryable"],
    ["RequestTimeoutException", "retryable"],
    ["ServiceUnavailableException", "retryable"],
    ["InternalServerErrorException", "retryable"],
    ["ConditionalCheckFailedException", "conflict"],
    ["ResourceNotFoundException", "not_found"],
    ["ValidationException", "rejected"],
    ["AccessDeniedException", "rejected"],
    ["SerializationException", "rejected"],
    ["ItemCollectionSizeLimitExceededException", "rejected"],
    ["UnrecognizedClientException", "rejected"],
    ["SomethingUnexpected", "unknown"],
  ])("AWS SDK の例外 %s は %s", (name, expected) => {
    expect(classifyFailure(awsError(name))).toBe(expected);
  });

  it("トランザクションの取り消しは、理由に衝突があるときだけ retryable", () => {
    const conflict = awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }] });
    const condition = awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
    expect(classifyFailure(conflict)).toBe("retryable");
    expect(classifyFailure(condition)).toBe("unknown");
  });

  it.each(["ThrottlingError", "ProvisionedThroughputExceeded", "RequestLimitExceeded"])("トランザクションの取り消しの理由 %s は retryable", (code) => {
    expect(classifyFailure(awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "None" }, { Code: code }] }))).toBe("retryable");
  });

  it.each(["ValidationError", "ItemCollectionSizeLimitExceeded"])("トランザクションの取り消しの理由 %s は rejected", (code) => {
    expect(classifyFailure(awsError("TransactionCanceledException", { $metadata: { httpStatusCode: 400 }, CancellationReasons: [{ Code: "None" }, { Code: code }] }))).toBe("rejected");
  });

  it("isRetryableCancellation は取り消しの理由に一時の失敗があるときだけ真で、例外の名前だけでは真にしない", () => {
    for (const code of ["TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded", "RequestLimitExceeded"]) {
      expect(isRetryableCancellation(awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "None" }, { Code: code }] }))).toBe(true);
    }
    expect(isRetryableCancellation(awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "ConditionalCheckFailed" }] }))).toBe(false);
    expect(isRetryableCancellation(awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "ValidationError" }] }))).toBe(false);
    expect(isRetryableCancellation(awsError("ThrottlingException"))).toBe(false);
    expect(isRetryableCancellation(null)).toBe(false);
  });

  it("取り消しの理由に一時の失敗と断った理由が並ぶときは retryable", () => {
    expect(classifyFailure(awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "ValidationError" }, { Code: "TransactionConflict" }] }))).toBe("retryable");
  });

  it.each([
    [500, "retryable"],
    [503, "retryable"],
    [501, "rejected"],
    [505, "unknown"],
    [429, "retryable"],
    [403, "rejected"],
    [400, "unknown"],
  ])("名前の分からない AWS SDK の例外は $metadata の状態 %i で %s", (status, expected) => {
    expect(classifyFailure(Object.assign(new Error("x"), { name: "SomethingUnexpected", $metadata: { httpStatusCode: status } }))).toBe(expected);
  });

  it("ky の時間切れとネットワークの誤りは retryable", async () => {
    const request = new Request("https://api.example.com/v1/x");
    expect(classifyFailure(new TimeoutError(request))).toBe("retryable");
    expect(classifyFailure(new NetworkError(request, { cause: new TypeError("fetch failed") }))).toBe("retryable");
    const refused = await kyFailure(() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) })));
    expect(classifyFailure(refused)).toBe("retryable");
  });

  it("AbortSignal.timeout の時間切れと、原因の鎖のネットワークの符号は retryable", () => {
    expect(classifyFailure(new DOMException("timed out", "TimeoutError"))).toBe("retryable");
    expect(classifyFailure(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toBe("retryable");
    expect(classifyFailure(new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) }))).toBe("retryable");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["文字列", "boom"],
    ["名前の無い物", {}],
    ["ただの例外", new Error("boom")],
    ["形の違う状態", { status: "503" }],
  ])("形の分からない値（%s）は unknown", (_why, value) => {
    expect(classifyFailure(value)).toBe("unknown");
  });

  it("循環する原因の鎖で止まる", () => {
    const error: Error & { cause?: unknown } = new Error("loop");
    error.cause = error;
    expect(classifyFailure(error)).toBe("unknown");
  });
});
