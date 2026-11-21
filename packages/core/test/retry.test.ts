import ky, { HTTPError, NetworkError, TimeoutError } from "ky";
import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/retry.ts";

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

const answer = (status: number) => () => Promise.resolve(new Response("{}", { status, headers: { "content-type": "application/json" } }));

describe("classifyFailure", () => {
  it.each([
    [429, "retryable"],
    [500, "retryable"],
    [502, "retryable"],
    [503, "retryable"],
    [504, "retryable"],
    [409, "conflict"],
    [404, "not_found"],
    [400, "rejected"],
    [401, "rejected"],
    [403, "rejected"],
    [408, "rejected"],
    [422, "rejected"],
    [501, "rejected"],
    [505, "unknown"],
    [200, "unknown"],
  ])("HTTP の状態 %i は %s", async (status, expected) => {
    expect(classifyFailure(status)).toBe(expected);
    expect(classifyFailure({ status })).toBe(expected);
    if (status >= 400) {
      const error = await kyFailure(answer(status));
      expect(error).toBeInstanceOf(HTTPError);
      expect(classifyFailure(error)).toBe(expected);
    }
  });

  it.each([
    ["ThrottlingException", "retryable"],
    ["ProvisionedThroughputExceededException", "retryable"],
    ["TransactionConflict", "retryable"],
    ["ConditionalCheckFailedException", "conflict"],
    ["ResourceNotFoundException", "not_found"],
    ["ValidationException", "rejected"],
    ["AccessDeniedException", "rejected"],
    ["InternalServerError", "unknown"],
  ])("AWS SDK の例外 %s は %s", (name, expected) => {
    expect(classifyFailure(awsError(name))).toBe(expected);
  });

  it("トランザクションの取り消しは、理由に衝突があるときだけ retryable", () => {
    const conflict = awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }] });
    const condition = awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
    expect(classifyFailure(conflict)).toBe("retryable");
    expect(classifyFailure(condition)).toBe("unknown");
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
