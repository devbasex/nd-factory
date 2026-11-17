import { describe, expect, it } from "vitest";
import { MAX_ITEMS, parseUsersRequest } from "../src/users-api.ts";

function items(n: number): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `u${i}` })));
}

describe("parseUsersRequest", () => {
  it("1 要素の配列を値にする", () => {
    expect(parseUsersRequest('[{"id":"self"}]')).toEqual({ ok: true, items: [{ id: "self" }] });
  });

  it("上限は 10 個", () => {
    expect(MAX_ITEMS).toBe(10);
    expect(parseUsersRequest(items(10)).ok).toBe(true);
    expect(parseUsersRequest(items(11))).toEqual({ ok: false, reason: "too_many_items" });
  });

  it("空の配列は body_empty", () => {
    expect(parseUsersRequest("[]")).toEqual({ ok: false, reason: "body_empty" });
  });

  it.each([undefined, "", "{", "not json"])("JSON でない本文は body_not_json（%s）", (body) => {
    expect(parseUsersRequest(body)).toEqual({ ok: false, reason: "body_not_json" });
  });

  it.each(['{"id":"self"}', '"self"', "null", "1"])("配列でない本文は body_not_array（%s）", (body) => {
    expect(parseUsersRequest(body)).toEqual({ ok: false, reason: "body_not_array" });
  });

  it.each([
    "[1]",
    '[{"id":""}]',
    `[{"id":"${"x".repeat(129)}"}]`,
    '[{"id":1}]',
    '[{"id":"self","extra":true}]',
    '[{"name":"self"}]',
  ])("要素の形の誤りは item_invalid（%s）", (body) => {
    expect(parseUsersRequest(body)).toEqual({ ok: false, reason: "item_invalid" });
  });

  it("id の長さは 128 文字まで通る", () => {
    expect(parseUsersRequest(`[{"id":"${"x".repeat(128)}"}]`).ok).toBe(true);
  });

  it("要素の誤りより個数の誤りを先に返す", () => {
    const body = JSON.stringify(Array.from({ length: 11 }, () => 1));
    expect(parseUsersRequest(body)).toEqual({ ok: false, reason: "too_many_items" });
  });
});
