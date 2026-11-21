import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.ts";
import { leakedSecrets, SECRET_SAMPLES } from "./fixtures/secrets.ts";

function capture() {
  const lines: string[] = [];
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, records, sink: (line: string) => lines.push(line) };
}

const context = { request_id: "req-1", fn: "api", endpoint: "user" };

describe("createLogger", () => {
  it("1 行の JSON に文脈と項目と文とレベルと時刻が付く", () => {
    const out = capture();
    createLogger(context, out.sink).info("利用者を作った", { user_id: "usr_1", count: 2 });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).not.toContain("\n");
    const [record] = out.records();
    expect(record).toMatchObject({ level: "info", msg: "利用者を作った", request_id: "req-1", fn: "api", endpoint: "user", user_id: "usr_1", count: 2 });
    expect(record?.["time"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(record).not.toHaveProperty("pid");
    expect(record).not.toHaveProperty("hostname");
  });

  it("warn と error のレベルを名前で出す", () => {
    const out = capture();
    const log = createLogger(context, out.sink);
    log.warn("繰り返す");
    log.error("使い切った");
    expect(out.records().map((r) => r["level"])).toEqual(["warn", "error"]);
  });

  it("項目が空でも、数だけでも出す", () => {
    const out = capture();
    const log = createLogger(context, out.sink);
    log.info("空", {});
    log.info("数だけ", { n: 0 });
    expect(out.records()).toMatchObject([{ msg: "空" }, { msg: "数だけ", n: 0 }]);
  });

  it("child の項目が後の行に付く", () => {
    const out = capture();
    createLogger(context, out.sink).child({ operation: "users.put" }).info("済んだ");
    expect(out.records()[0]).toMatchObject({ request_id: "req-1", operation: "users.put", msg: "済んだ" });
  });

  it("秘密の形の値と秘密の鍵の名前の下の値が、文・項目・文脈・child のどこからも行に残らない", () => {
    const out = capture();
    const secrets = Object.values(SECRET_SAMPLES);
    const log = createLogger({ ...context, request_id: secrets[0] ?? "" }, out.sink).child({ token: "child-token", note: secrets[1] });
    for (const secret of secrets) {
      log.error(`失敗した ${secret}`, { authorization: `Bearer ${secret}`, nested: { deep: [{ value: secret }] }, password: "hunter2" });
    }
    expect(out.lines).toHaveLength(secrets.length);
    const text = out.lines.join("\n");
    expect(leakedSecrets(text)).toEqual([]);
    expect(text).not.toContain("child-token");
    expect(text).not.toContain("hunter2");
    expect(out.records()[0]).toMatchObject({ request_id: "[redacted]", token: "[redacted]", password: "[redacted]", msg: "[redacted]" });
  });

  it("JSON にできない値は [unserializable] に替えて出す", () => {
    const out = capture();
    createLogger(context, out.sink).info("変な値", { big: 10n, callback: () => 1, sym: Symbol("s") });
    expect(out.records()[0]).toMatchObject({ big: "[unserializable]", callback: "[unserializable]", sym: "[unserializable]" });
  });

  it("循環する値でも呼び手が落ちない", () => {
    const out = capture();
    const value: Record<string, unknown> = {};
    value["self"] = value;
    createLogger(context, out.sink).info("循環", { value });
    expect(out.records()[0]).toMatchObject({ value: { self: "[cycle]" } });
  });

  it("書き先の例外で呼び手が落ちない", () => {
    const log = createLogger(context, () => {
      throw new Error("書けない");
    });
    expect(() => log.error("書けなくても続く", { n: 1 })).not.toThrow();
    expect(() => log.child({ a: 1 }).info("子も")).not.toThrow();
  });

  it("呼び手の項目と child の文脈は必須の項目を上書きできず、field. の頭を付けて残る", () => {
    const out = capture();
    const log = createLogger(context, out.sink);
    log.warn("上書きしない", { request_id: "other", level: "info", time: "x", msg: "m", fn: "f", endpoint: "e" });
    log.child({ request_id: "child", level: "error" }).info("子も");
    for (const line of out.lines) expect(line.match(/"request_id":/g)).toHaveLength(1);
    const [first, second] = out.records();
    expect(first).toMatchObject({ level: "warn", msg: "上書きしない", request_id: "req-1", fn: "api", endpoint: "user" });
    expect(first).toMatchObject({ "field.request_id": "other", "field.level": "info", "field.time": "x", "field.msg": "m", "field.fn": "f", "field.endpoint": "e" });
    expect(first?.["time"]).not.toBe("x");
    expect(second).toMatchObject({ level: "info", request_id: "req-1", "field.request_id": "child", "field.level": "error" });
  });

  it("必須の名前の避け先が埋まっていれば番号を付けて、どちらの値も残す", () => {
    const out = capture();
    const log = createLogger(context, out.sink);
    log.info("同じ行", { time: "t", "field.time": "ft", request_id: "r", "field.request_id": "fr" });
    log.child({ time: "child" }).info("子と呼び出し", { time: "call" });
    log.child({ time: "c1" }).child({ time: "c2", "field.time": "own" }).info("孫", { time: "call" });
    for (const line of out.lines) {
      expect(line.match(/"field\.time":/g)).toHaveLength(1);
      expect(line.match(/"time":/g)).toHaveLength(1);
    }
    const [first, second, third] = out.records();
    expect(first).toMatchObject({ "field.time": "ft", "field.time#2": "t", "field.request_id": "fr", "field.request_id#2": "r", request_id: "req-1" });
    expect(second).toMatchObject({ "field.time": "child", "field.time#2": "call" });
    expect(third).toMatchObject({ "field.time": "own", "field.time#2": "c1", "field.time#3": "c2", "field.time#4": "call" });
  });

  it("child と呼び出しの同じ名前（必須でない）は呼び出しの値が勝ち、鍵を 2 度書かない", () => {
    const out = capture();
    createLogger(context, out.sink).child({ operation: "child" }).info("上書き", { operation: "call" });
    expect(out.lines[0]?.match(/"operation":/g)).toHaveLength(1);
    expect(out.records()[0]).toMatchObject({ operation: "call" });
  });

  it("child の項目を読めなくても、親のロガーで続ける", () => {
    const out = capture();
    const fields = Object.defineProperty({}, "bad", {
      enumerable: true,
      get() {
        throw new Error("読めない");
      },
    });
    const child = createLogger(context, out.sink).child(fields);
    expect(() => child.info("親で続く")).not.toThrow();
    expect(out.records()).toMatchObject([{ msg: "親で続く", request_id: "req-1" }]);
  });
});
