import en from "./en.json";
import ja from "./ja.json";
import type { Locale } from "./locales.ts";

// 翻訳の引き当て。キーの型は原文の ja.json から作り、無いキーは型検査で落ちる

type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
}[keyof T & string];

// 複数の形の接尾辞は引き当てが選ぶので、呼ぶ側のキーからは落とす
type WithoutPlural<K extends string> = K extends `${infer Base}_${"zero" | "one" | "two" | "few" | "many" | "other"}`
  ? Base
  : K;

export type MessageKey = WithoutPlural<Leaves<typeof ja>>;

export type Translator = (key: MessageKey, params?: Record<string, string | number>) => string;

const MESSAGES: Record<Locale, unknown> = { ja, en };

function lookup(messages: unknown, key: string): string | undefined {
  let node = messages;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

// 理由のコードの文のキー。表に無いコードは汎用の文にし、コードの文字列をそのまま出さない
export function reasonKey(code: string): MessageKey {
  return (Object.hasOwn(ja.errors.reason, code) ? `errors.reason.${code}` : "errors.reason.unknown") as MessageKey;
}

// 送る列に入る操作の名前の文のキー。表に無い操作は汎用の文にし、操作の名前をそのまま出さない
export function operationKey(operation: string): MessageKey {
  const name = operation.replaceAll(".", "_");
  return `operations.${Object.hasOwn(ja.operations, name) ? name : "unknown"}` as MessageKey;
}

export function createTranslator(locale: Locale): Translator {
  const messages = MESSAGES[locale];
  const plurals = new Intl.PluralRules(locale);
  return (key, params = {}) => {
    const count = params["count"];
    const plural =
      typeof count === "number"
        ? (lookup(messages, `${key}_${plurals.select(count)}`) ?? lookup(messages, `${key}_other`))
        : undefined;
    const text = plural ?? lookup(messages, key) ?? key;
    return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => String(params[name] ?? whole));
  };
}
