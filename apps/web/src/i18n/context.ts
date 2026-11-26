import { createContext, useContext } from "react";
import type { FormatOpts } from "./format.ts";
import type { Locale } from "./locales.ts";
import { createTranslator, type Translator } from "./translate.ts";

// 部品が文言・言語・時刻帯・今の時刻を読む文脈。値は起動の組み立てが 1 度だけ作る

export type I18n = FormatOpts & { locale: Locale; t: Translator; now: () => number };

export function createI18n(locale: Locale, timeZone: string, now: () => number): I18n {
  return { locale, timeZone, now, t: createTranslator(locale) };
}

export const I18nContext = createContext<I18n | null>(null);

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (value === null) throw new Error("I18nContext の外で部品を描いた");
  return value;
}
