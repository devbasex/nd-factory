import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.ts";
import { leakedSecrets, SECRET_SAMPLES } from "./fixtures/secrets.ts";

const R = "[redacted]";

describe("redact", () => {
  it("authorization と token の下の値が伏せられ、ほかは残る", () => {
    expect(redact({ authorization: "Bearer x", token: "abc", user_id: "usr_1", count: 3 })).toEqual({
      authorization: R,
      token: R,
      user_id: "usr_1",
      count: 3,
    });
  });

  it("秘密の名前を含む鍵の名前は、大文字と小文字を分けずに伏せる", () => {
    expect(redact({ Authorization: "x", ACCESS_TOKEN: "y", clientSecret: "z", db_password: "w", aws_credentials: { a: 1 }, private_key: "k", sentry_dsn: "d" })).toEqual({
      Authorization: R,
      ACCESS_TOKEN: R,
      clientSecret: R,
      db_password: R,
      aws_credentials: R,
      private_key: R,
      sentry_dsn: R,
    });
  });

  it("入れ子の深い所と配列の中も伏せる", () => {
    const value = { a: { b: { c: [{ d: { token: "x" } }, "ok"] } }, list: [[{ secret: 1 }]] };
    expect(redact(value)).toEqual({ a: { b: { c: [{ d: { token: R } }, "ok"] } }, list: [[{ secret: R }]] });
  });

  it.each(Object.entries(SECRET_SAMPLES))("秘密の形 %s に当たる文字列を、鍵の名前に依らず伏せる", (_name, secret) => {
    const out = redact({ note: secret, items: [secret], nested: { text: `前置き ${secret} 後ろ` } });
    expect(out).toEqual({ note: R, items: [R], nested: { text: R } });
    expect(leakedSecrets(JSON.stringify(out))).toEqual([]);
  });

  it("文字列の中に埋まった委任の token も伏せる", () => {
    expect(redact(`送った値は ${SECRET_SAMPLES["delegation_token"]} だった`)).toBe(R);
  });

  it("秘密の形の鍵の名前も伏せる", () => {
    const secret = SECRET_SAMPLES["github_app_token"] ?? "";
    const out = redact({ [secret]: 1 });
    expect(Object.keys(out as object)).toEqual([R]);
    expect(leakedSecrets(JSON.stringify(out))).toEqual([]);
  });

  it("例外は名前と文だけを写し、文の秘密も伏せる", () => {
    const error = Object.assign(new Error(`失敗 ${SECRET_SAMPLES["jwt"]}`), { response: { headers: { authorization: "x" } } });
    expect(redact({ error })).toEqual({ error: { name: "Error", message: R } });
  });

  it("循環する値で止まらず、循環を [cycle] に替える", () => {
    const value: Record<string, unknown> = { id: "usr_1" };
    value["self"] = value;
    value["list"] = [value];
    expect(redact(value)).toEqual({ id: "usr_1", self: "[cycle]", list: ["[cycle]"] });
  });

  it("同じ値を 2 か所から指すだけなら循環としない", () => {
    const shared = { n: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } });
  });

  it("元の値を変えない", () => {
    const value = { token: "x", nested: { secret: "y", list: [SECRET_SAMPLES["machine_token"]] } };
    const before = structuredClone(value);
    const out = redact(value);
    expect(value).toEqual(before);
    expect(out).not.toBe(value);
  });

  it("原始の値と日時はそのまま写す", () => {
    const at = new Date("2026-11-21T00:00:00.000Z");
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact("ops@example.com")).toBe("ops@example.com");
    const copied = redact(at);
    expect(copied).toEqual(at);
    expect(copied).not.toBe(at);
  });
});
