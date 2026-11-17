import { z } from "zod";

// 経路 PUT /v1/users の入出力の形。入力は常に配列にし、要素ごとに答える

export const MAX_ITEMS = 10;
const MAX_ID_LENGTH = 128;

export const userRefSchema = z.strictObject({
  id: z.string().min(1).max(MAX_ID_LENGTH),
});

export const usersRequestSchema = z.array(userRefSchema).min(1).max(MAX_ITEMS);

export const userRowSchema = z.strictObject({
  id: z.string().min(1),
  created_at: z.iso.datetime(),
});

export const userAnswerSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), item: userRowSchema }),
  z.strictObject({ status: z.literal("not_found") }),
]);

export const usersResponseSchema = z.array(userAnswerSchema);

export type UserRef = z.infer<typeof userRefSchema>;
export type UserRow = z.infer<typeof userRowSchema>;
export type UserAnswer = z.infer<typeof userAnswerSchema>;

// 400 の理由のコード。parseUsersRequest はこの並びの順に確かめ、最初に当たったものを返す
export const USERS_REASONS = ["body_not_json", "body_not_array", "body_empty", "too_many_items", "item_invalid"] as const;
export type UsersReason = (typeof USERS_REASONS)[number];

// 表に届かないときの理由のコード（503）
export const STORE_UNAVAILABLE = "store_unavailable";

export type UsersErrorBody = { reason: UsersReason | typeof STORE_UNAVAILABLE };

export type ParseUsersResult = { ok: true; items: UserRef[] } | { ok: false; reason: UsersReason };

export function parseUsersRequest(body: string | undefined): ParseUsersResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    return { ok: false, reason: "body_not_json" };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: "body_not_array" };
  if (parsed.length === 0) return { ok: false, reason: "body_empty" };
  if (parsed.length > MAX_ITEMS) return { ok: false, reason: "too_many_items" };
  const result = usersRequestSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "item_invalid" };
  return { ok: true, items: result.data };
}
