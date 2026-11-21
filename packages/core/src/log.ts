import { pino, type Logger as PinoLogger, type LoggerOptions } from "pino";
import { redact } from "./redact.ts";

// 1 行の JSON を出すログの書き手。書き手は pino（画面では pino のブラウザー版）で、値の伏せ字は redact だけが持つ
// （pino の鍵のパスの伏せ字は使わない。同じ規則を 2 か所に置かない）。画面でも動くよう node: の組み込みを読まない（決定 6）

export type LogContext = {
  request_id: string;
  fn: string;
  // 受け口（必須。画面は自分が呼ぶ受け口の名前を渡す）
  endpoint: string;
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

// 伏せた項目の 1 つ。id は上書きを決める元の鍵の識別子、key は伏せた鍵、value は伏せた値
type Entry = readonly [id: string, key: string, value: unknown];

// 元の鍵から秘密の原文を残さずに同一性を判定する識別子を作る。ロガーごとに作る秘密の鍵で HMAC-SHA-256 を取り、
// 識別子だけからは鍵の候補を照らせないようにする（固定の種のハッシュでは、URL の利用者名と宿が分かれば合言葉の候補を照らせる）。
// 画面でも動くよう node:crypto を使わず、同期で要るため Web Crypto の subtle（非同期）も使わない。
// 伏せない鍵は名前そのものを識別子にする（頭の "k:" と "h:" で 2 つを分ける）
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

function sha256(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1;
    }
    // v は作業の 8 語（a〜h）。1 周ごとに 1 つずらし、頭に新しい a、5 つ目（e）に d + t1 を置く
    const v = Array.from(h);
    for (let i = 0; i < 64; i += 1) {
      const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, hh = 0] = v;
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      v.splice(0, 8, (t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g);
    }
    for (let i = 0; i < 8; i += 1) h[i] = ((h[i] ?? 0) + (v[i] ?? 0)) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i] ?? 0);
  return out;
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i += 1) {
    inner[i] = (block[i] ?? 0) ^ 0x36;
    outer[i] = (block[i] ?? 0) ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

// ロガー（createLogger の 1 回）ごとの秘密の鍵。child は親の鍵を受け継ぎ、同じ鍵の上書きの判定を保つ
function newKeyIdSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

const encoder = new TextEncoder();

function keyId(secret: Uint8Array, original: string, safeKey: string): string {
  if (safeKey === original) return `k:${original}`;
  const digest = hmacSha256(secret, encoder.encode(original));
  return `h:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// 項目を伏せた組の並びにする。鍵の名前で伏せる値（token など）も伏せるよう、鍵と値の組で redact に通す。
// 秘密の形の鍵は "[redacted]" になり、元の鍵は識別子でだけ残す（長く生きる child に原文を持たせない）
function entries(secret: Uint8Array, fields: LogFields): Entry[] {
  return Object.entries(fields).map(([key, value]) => {
    const [safeKey, safe] = Object.entries(loggable({ [key]: value }))[0] ?? [key, undefined];
    return [keyId(secret, key, safeKey), safeKey, safe] as const;
  });
}

function put(out: LogFields, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function freeKey(out: LogFields, base: string): string {
  let target = base;
  for (let n = 2; Object.hasOwn(out, target); n += 1) target = `${base}#${n}`;
  return target;
}

// child の文脈（先）と呼び出しの項目（後）を 1 つの物へ組む。pino の child の束ねは使わない
// （Node の pino は束ねと項目の同じ鍵を 2 度書き、JSON を読むと先の値が消えるため）。
// 上書きは元の鍵の識別子で決め（伏せた鍵では、別の鍵が同じ "[redacted]" に重なる）、必須でない名前は後の値が先の値に勝つ。
// 残った伏せた鍵の重なりには "[redacted]#2" のように番号を付ける。必須の名前は "field." を頭に付けて残し、避け先が埋まっていれば
// "field.time#2" のように番号を付ける（黙って落とさない）。避け先は呼び手の鍵を先に置いてから決める
function reserved(layers: readonly (readonly Entry[])[]): LogFields {
  const kept = new Map<string, readonly [string, unknown]>();
  const moved: [string, unknown][] = [];
  for (const layer of layers) {
    for (const [id, key, value] of layer) {
      if (RESERVED.has(key)) moved.push([key, value]);
      else kept.set(id, [key, value]);
    }
  }
  const out: LogFields = {};
  for (const [key, value] of kept.values()) put(out, freeKey(out, key), value);
  for (const [key, value] of moved) put(out, freeKey(out, `${RESERVED_PREFIX}${key}`), value);
  return out;
}

function wrap(base: PinoLogger, secret: Uint8Array, bound: readonly (readonly Entry[])[]): Logger {
  const line = (fields: LogFields | undefined): LogFields => reserved([...bound, entries(secret, fields ?? {})]);
  return {
    info: (msg, fields) => quietly(() => base.info(line(fields), msg)),
    warn: (msg, fields) => quietly(() => base.warn(line(fields), msg)),
    error: (msg, fields) => quietly(() => base.error(line(fields), msg)),
    // 子の項目はこの時に鍵と値を伏せた写しを取って持つ。扱えない（読むと投げる getter など）ときは、親のロガーのまま続ける
    child: (fields) => {
      try {
        return wrap(base, secret, [...bound, entries(secret, fields)]);
      } catch {
        return wrap(base, secret, bound);
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
  return wrap(root.child(loggable(context)), newKeyIdSecret(), []);
}
