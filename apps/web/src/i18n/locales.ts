// 画面の言語の一覧と決め方。言語を足すときは翻訳のファイル 1 つと、ここの 1 行を足す

const LOCALES = ["ja", "en"] as const;

export type Locale = (typeof LOCALES)[number];

function match(tag: string): Locale | undefined {
  const language = tag.toLowerCase().split("-")[0];
  return LOCALES.find((l) => l === language);
}

// 自分の設定 → ブラウザーの言語の最初に当たるもの → 日本語
export function pickLocale(setting: string | null, preferred: readonly string[]): Locale {
  for (const tag of setting === null ? preferred : [setting, ...preferred]) {
    const found = match(tag);
    if (found !== undefined) return found;
  }
  return "ja";
}
