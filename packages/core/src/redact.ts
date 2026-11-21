import { SECRET_SHAPES } from "@nd-factory/contracts/data";

// 値の木を写し、秘密の鍵の名前の下の値と、秘密の形に当たる文字列を伏せる。秘密の形は漏れの検査と同じデータを読む
// 画面でも動くよう node: の組み込みを読まない（決定 6）

const REDACTED = "[redacted]";
const CYCLE = "[cycle]";

const KEY_NAMES = SECRET_SHAPES.keyNames;
const VALUE_PATTERNS = SECRET_SHAPES.valuePatterns.map((p) => new RegExp(p.pattern, "u"));

// 鍵の名前は大文字と小文字を分けず、秘密の名前を含めば当たる（access_token・Authorization など）
function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return KEY_NAMES.some((name) => lower.includes(name));
}

// 当たった文字列は丸ごと伏せる。当たった所だけを替えると、私有鍵の本体のように形の外へ続く秘密が残る
function isSecretText(text: string): boolean {
  return VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

function isSecretKeyValue(key: unknown): boolean {
  return typeof key === "string" && isSecretKey(key);
}

// 伏せた鍵の名前が重なっても前の項目を消さない。2 つ目からは "[redacted]#2" のように番号を付ける
function freeKey(out: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(out, key)) return key;
  let n = 2;
  while (Object.hasOwn(out, `${key}#${n}`)) n += 1;
  return `${key}#${n}`;
}

export function redact(value: unknown): unknown {
  return copy(value, new Set());
}

// ancestors は今たどっている道の上の値だけを持つ。同じ値を 2 か所から指すだけなら循環としない
function copy(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "string") return isSecretText(value) ? REDACTED : value;
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return CYCLE;
  if (value instanceof Date) return new Date(value.getTime());
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => copy(item, ancestors));
    // 例外は名前と文だけを写す（頭書きや応答を持つ項目を運ばない）
    if (value instanceof Error) return { name: copy(value.name, ancestors), message: copy(value.message, ancestors) };
    // Set は配列、Map は [鍵, 値] の組の配列に写す（Object.entries が空になり、{} として中身が黙って落ちるのを防ぐ）
    if (value instanceof Set) return [...value].map((item) => copy(item, ancestors));
    if (value instanceof Map) return [...value].map(([key, item]) => [copy(key, ancestors), isSecretKeyValue(key) ? REDACTED : copy(item, ancestors)]);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // 代入でなく defineProperty で書く。"__proto__" の鍵（JSON.parse の結果など）を代入すると、項目にならずプロトタイプの差し替えになり黙って落ちる
      Object.defineProperty(out, freeKey(out, isSecretText(key) ? REDACTED : key), {
        value: isSecretKey(key) ? REDACTED : copy(item, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}
