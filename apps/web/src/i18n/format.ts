import type { Locale } from "./locales.ts";

// 日時・数・金額の書式。利用者の言語と時刻帯は呼ぶ側が渡す

export type FormatOpts = { locale: Locale; timeZone: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatDateTime(iso: string, o: FormatOpts): string {
  return new Intl.DateTimeFormat(o.locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: o.timeZone,
  }).format(new Date(iso));
}

// 24 時間より前でなければ「3 分前」の形、それより前は日付と時刻
export function formatRelative(iso: string, nowMs: number, o: FormatOpts): string {
  const diff = Date.parse(iso) - nowMs;
  const size = Math.abs(diff);
  if (size > DAY_MS) return formatDateTime(iso, o);
  const format = new Intl.RelativeTimeFormat(o.locale, { numeric: "always" });
  if (size < MINUTE_MS) return format.format(Math.trunc(diff / 1000), "second");
  if (size < HOUR_MS) return format.format(Math.trunc(diff / MINUTE_MS), "minute");
  return format.format(Math.trunc(diff / HOUR_MS), "hour");
}

/** 数を出す画面は機能の画面（#28）が作る @internal */
export function formatNumber(n: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(n);
}

// 通貨の無い金額は描かない（I15）。呼ぶ側が null をエラーの表示にする
export function formatMoney(amount: number, currency: string | null, locale: Locale): string | null {
  if (currency === null || !/^[A-Z]{3}$/.test(currency)) return null;
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
}
