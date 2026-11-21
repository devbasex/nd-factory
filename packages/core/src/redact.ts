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
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[isSecretText(key) ? REDACTED : key] = isSecretKey(key) ? REDACTED : copy(item, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}
