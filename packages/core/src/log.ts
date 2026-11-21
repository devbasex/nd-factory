import { pino, type Logger as PinoLogger, type LoggerOptions } from "pino";
import { redact } from "./redact.ts";

// 1 行の JSON を出すログの書き手。書き手は pino（画面では pino のブラウザー版）で、値の伏せ字は redact だけが持つ
// （pino の鍵のパスの伏せ字は使わない。同じ規則を 2 か所に置かない）。画面でも動くよう node: の組み込みを読まない（決定 6）

export type LogContext = {
  request_id: string;
  fn: string;
  // 受け口
  endpoint?: string;
};

export type LogFields = Record<string, unknown>;

export type Logger = {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
};

const UNSERIALIZABLE = "[unserializable]";

// JSON にできない値（bigint・関数・symbol）を替える。redact の写しは素の物と配列と日時と原始の値だけを持つ
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return UNSERIALIZABLE;
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
}

function loggable(value: unknown): Record<string, unknown> {
  const safe = jsonSafe(redact(value));
  return safe !== null && typeof safe === "object" && !Array.isArray(safe) ? (safe as Record<string, unknown>) : {};
}

function loggableText(text: unknown): unknown {
  return typeof text === "string" ? redact(text) : text;
}

// ログの欠けは操作の結果を変えない。書き先の例外と JSON にできない値で呼び手を落とさない
function quietly(write: () => void): void {
  try {
    write();
  } catch {
    // 捨てる（detail.md の異常系の「書けない」の行）
  }
}

// 行の必須の項目。呼び手の項目と child の文脈はこの名前を上書きできない（Node の pino は同じ鍵を 2 度書き、ブラウザー版は後の値で替える）
const RESERVED = new Set(["time", "level", "msg", "request_id", "fn", "endpoint"]);
const RESERVED_PREFIX = "field.";

// 必須の名前に当たる呼び手の鍵は "field." を頭に付けて残す（黙って落とさない）
function reserved(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!RESERVED.has(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED.has(key) && !(`${RESERVED_PREFIX}${key}` in out)) out[`${RESERVED_PREFIX}${key}`] = value;
  }
  return out;
}

function wrap(base: PinoLogger): Logger {
  return {
    info: (msg, fields) => quietly(() => base.info(reserved(fields ?? {}), msg)),
    warn: (msg, fields) => quietly(() => base.warn(reserved(fields ?? {}), msg)),
    error: (msg, fields) => quietly(() => base.error(reserved(fields ?? {}), msg)),
    // 子の項目を扱えない（読むと投げる getter など）ときは、親のロガーのまま続ける
    child: (fields) => {
      try {
        return wrap(base.child(reserved(loggable(fields))));
      } catch {
        return wrap(base);
      }
    },
  };
}

function withoutNewline(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

type Level = "info" | "warn" | "error";

// ブラウザーの既定の書き先。物でなく 1 行の JSON を、レベルに合う console の口へ渡す
function consoleLine(line: string, level: unknown): void {
  const out = globalThis.console;
  if (level === "error") out.error(line);
  else if (level === "warn") out.warn(line);
  else out.info(line);
}

// sink を渡さなければ既定の書き先（Node では pino の標準出力、ブラウザーでは console へ JSON の 1 行）へ書く
export function createLogger(context: LogContext, sink?: (line: string) => void): Logger {
  const emit = (line: string, level?: Level): void => quietly(() => (sink === undefined ? consoleLine(line, level) : sink(line)));
  const levelLabel = (label: string) => ({ level: label });
  const options: LoggerOptions = {
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: levelLabel, bindings: loggable, log: loggable },
    hooks: {
      // 文も伏せる。項目は formatters.log、文脈は formatters.bindings が伏せる
      logMethod(args, method) {
        const [first, ...rest] = args;
        method.apply(this, [first, ...rest.map(loggableText)] as Parameters<typeof method>);
      },
    },
    // ブラウザー版は hooks と bindings の整形を持たない。文と文脈も入った 1 つの物を formatters.log で伏せる
    // write は sink の有無に依らず置き、物でなく JSON の 1 行を書き先へ渡す
    browser: {
      asObject: true,
      formatters: { level: levelLabel, log: loggable },
      write: (record: object) => quietly(() => emit(JSON.stringify(record), (record as { level?: Level }).level)),
    },
  };
  const root = sink === undefined ? pino(options) : pino(options, { write: (line: string) => emit(withoutNewline(line)) });
  return wrap(root.child(loggable(context)));
}
