import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { leakedSecrets, SECRET_SAMPLES } from "./fixtures/secrets.ts";

// 画面で束ねたときと同じく、pino をブラウザー版（package.json の browser の先）へ差し替えて、browser の設定を通す
// pino/browser.js は型の宣言を持たないため、require で読む
vi.mock("pino", () => {
  const browser: unknown = createRequire(import.meta.url)("pino/browser.js");
  return { default: browser, pino: browser };
});

const { createLogger } = await import("../src/log.ts");

const context = { request_id: "req-1", fn: "web", endpoint: "user" };

function capture() {
  const lines: string[] = [];
  return { lines, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>), sink: (line: string) => lines.push(line) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLogger（ブラウザー版の pino）", () => {
  it("sink へ 1 行の JSON に文脈と項目と文とレベルと時刻を付けて書く", () => {
    const out = capture();
    createLogger(context, out.sink).child({ operation: "users.put" }).info("作った", { n: 1 });
    expect(out.lines).toHaveLength(1);
    const [record] = out.records();
    expect(record).toMatchObject({ level: "info", msg: "作った", request_id: "req-1", fn: "web", endpoint: "user", operation: "users.put", n: 1 });
    expect(record?.["time"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("文・項目・文脈・child の秘密が formatters.log で伏せられる", () => {
    const out = capture();
    const secrets = Object.values(SECRET_SAMPLES);
    const log = createLogger({ ...context, request_id: secrets[0] ?? "" }, out.sink).child({ token: "child-token", note: secrets[1] });
    for (const secret of secrets) log.error(`失敗した ${secret}`, { authorization: `Bearer ${secret}`, nested: [{ value: secret }], password: "hunter2" });
    expect(out.lines).toHaveLength(secrets.length);
    const text = out.lines.join("\n");
    expect(leakedSecrets(text)).toEqual([]);
    expect(text).not.toContain("child-token");
    expect(text).not.toContain("hunter2");
    expect(out.records()[0]).toMatchObject({ request_id: "[redacted]", token: "[redacted]", password: "[redacted]", msg: "[redacted]" });
  });

  it("呼び手の項目と child の文脈は必須の項目を上書きできない", () => {
    const out = capture();
    const log = createLogger(context, out.sink);
    log.warn("上書きしない", { request_id: "other", level: "info" });
    log.child({ request_id: "child" }).error("子も");
    expect(out.records()).toMatchObject([
      { level: "warn", request_id: "req-1", "field.request_id": "other", "field.level": "info" },
      { level: "error", request_id: "req-1", "field.request_id": "child" },
    ]);
  });

  it("child と呼び出しの必須の名前は、避け先に番号を付けて両方を残す", () => {
    const out = capture();
    const log = createLogger(context, out.sink);
    log.child({ time: "child" }).info("子と呼び出し", { time: "call" });
    log.info("同じ行", { request_id: "r", "field.request_id": "fr" });
    const [first, second] = out.records();
    expect(first).toMatchObject({ "field.time": "child", "field.time#2": "call" });
    expect(first?.["time"]).not.toBe("call");
    expect(second).toMatchObject({ request_id: "req-1", "field.request_id": "fr", "field.request_id#2": "r" });
  });

  it("伏せる鍵の上書きは元の鍵で決め、残った鍵の重なりには番号を付ける", () => {
    const out = capture();
    const log = createLogger(context, out.sink);
    const same = SECRET_SAMPLES["github_personal_token"] ?? "";
    const other = SECRET_SAMPLES["github_app_token"] ?? "";
    log.child({ [same]: "child" }).info("同じ鍵", { [same]: "call" });
    log.child({ [same]: "first" }).child({ [other]: "second" }).info("別の鍵");
    expect(leakedSecrets(out.lines.join("\n"))).toEqual([]);
    const [first, second] = out.records();
    expect(first).toMatchObject({ "[redacted]": "call" });
    expect(first).not.toHaveProperty("[redacted]#2");
    expect(second).toMatchObject({ "[redacted]": "first", "[redacted]#2": "second" });
  });

  it("sink を省くと、レベルに合う console の口へ物でなく JSON の 1 行を渡す", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger(context);
    log.info("い", { token: "t" });
    log.warn("う");
    log.error("え");
    for (const spy of [info, warn, error]) {
      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0] ?? [];
      expect(args).toHaveLength(1);
      expect(typeof args[0]).toBe("string");
    }
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({ level: "info", msg: "い", request_id: "req-1", token: "[redacted]" });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ level: "warn" });
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ level: "error" });
  });

  it("書き先の例外で呼び手が落ちない", () => {
    const log = createLogger(context, () => {
      throw new Error("書けない");
    });
    expect(() => log.error("続く")).not.toThrow();
  });
});
