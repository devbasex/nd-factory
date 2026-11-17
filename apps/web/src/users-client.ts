import { type UserRow, usersResponseSchema } from "@nd-factory/contracts/users-api";

// 経路を [{"id":"self"}] で 1 回だけ呼び、応答を画面の結果へ写す。再試行は利用者の操作に任せる

export type SelfResult = { kind: "ok"; user: UserRow } | { kind: "unauthorized" } | { kind: "error"; reason: string };

const SELF_BODY = JSON.stringify([{ id: "self" }]);
const REASON_SHAPE = /^[a-z0-9_]{1,64}$/;

async function readReason(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "reason" in body && typeof body.reason === "string" && REASON_SHAPE.test(body.reason)) {
      return body.reason;
    }
  } catch {
    // 本文が無いか JSON でない。状態コードから理由を作る
  }
  return `http_${res.status}`;
}

export async function fetchSelf(apiUrl: string, token: string, fetchFn: typeof fetch): Promise<SelfResult> {
  let res: Response;
  try {
    res = await fetchFn(`${apiUrl.replace(/\/+$/, "")}/v1/users`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: SELF_BODY,
    });
  } catch {
    return { kind: "error", reason: "network_error" };
  }
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status !== 200) return { kind: "error", reason: await readReason(res) };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "error", reason: "unexpected_response" };
  }
  const parsed = usersResponseSchema.safeParse(body);
  const first = parsed.success ? parsed.data[0] : undefined;
  if (!first || first.status !== "ok") return { kind: "error", reason: "unexpected_response" };
  return { kind: "ok", user: first.item };
}
