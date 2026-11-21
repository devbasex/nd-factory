import { z } from "zod";

// 理由のコードの共通の集まり。操作ごとのコードは操作の定義の reasons に足す（docs/design/api.md の「誤りの形」）

export type ReasonStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503;

// 理由が起きうる操作の条件。always はどの操作にも、ほかは操作の印が当たるときだけ入る
export type ReasonWhen = "always" | "write" | "idempotency" | "all_or_nothing" | "human_only_per_item";

export type ReasonDef = {
  readonly code: string;
  readonly status: ReasonStatus;
  readonly when: ReasonWhen;
};

// 理由のコードの形
export const REASON_CODE = /^[a-z][a-z0-9_]*$/;

// 要求全体の理由のコード。要素の結果でなく problem+json の本文で返す
export const REQUEST_REASONS = [
  { code: "body_not_json", status: 400, when: "always" },
  { code: "body_not_array", status: 400, when: "always" },
  { code: "body_empty", status: 400, when: "always" },
  { code: "too_many_items", status: 400, when: "always" },
  { code: "duplicate_item", status: 400, when: "always" },
  { code: "cursor_invalid", status: 400, when: "always" },
  { code: "unauthorized", status: 401, when: "always" },
  { code: "human_only", status: 403, when: "always" },
  { code: "scope_insufficient", status: 403, when: "always" },
  { code: "unavailable", status: 503, when: "always" },
  { code: "audit_unavailable", status: 503, when: "always" },
  { code: "too_many_requests", status: 429, when: "always" },
] as const satisfies readonly ReasonDef[];

// どの操作の要素にも出うる理由のコード。when が操作の印に当たるものだけを itemReasonsOf が合わせる
export const ITEM_REASONS = [
  { code: "item_invalid", status: 400, when: "always" },
  { code: "not_found", status: 404, when: "always" },
  { code: "role_insufficient", status: 403, when: "always" },
  { code: "human_only", status: 403, when: "human_only_per_item" },
  { code: "version_mismatch", status: 409, when: "write" },
  { code: "state_mismatch", status: 409, when: "write" },
  { code: "idempotency_key_reused", status: 422, when: "idempotency" },
  { code: "in_progress", status: 409, when: "idempotency" },
  { code: "not_applied", status: 409, when: "all_or_nothing" },
] as const satisfies readonly ReasonDef[];

// 要求全体の誤りの本文（RFC 9457 の形。title・detail を持たず、拡張の reason に理由のコードを置く）。
// 生成物（openapi.json の problem）と呼び出しの口の検証が同じこの形を読む
export const problemBody = z.strictObject({
  type: z.literal("about:blank"),
  status: z.int(),
  reason: z.enum(REQUEST_REASONS.map((r) => r.code) as [RequestReasonCode, ...RequestReasonCode[]]),
});

export type RequestReasonCode = (typeof REQUEST_REASONS)[number]["code"];

const REQUEST_REASON_STATUS = new Map<string, number>(REQUEST_REASONS.map((r) => [r.code, r.status]));

// 本文の理由が正本に登録した状態と合い、本文の status が HTTP の状態と同じとき、その本文を返す。合わなければ null
// （中継が返した 502 の本文などは API が返した正規の失敗とみなさない）
export function requestProblemOf(httpStatus: number, body: unknown): z.infer<typeof problemBody> | null {
  const parsed = problemBody.safeParse(body);
  if (!parsed.success) return null;
  const { status, reason } = parsed.data;
  return status === httpStatus && REQUEST_REASON_STATUS.get(reason) === status ? parsed.data : null;
}
