import { z } from "zod";

// 国や地域で読み違えない値の形（docs/design/api.md の「値の形」、I15）。
// どれも JSON Schema へそのまま写る正規表現・長さ・列挙・整数だけで書き、refine と transform を使わない（決定 4・5）

// 要求の本文の要素の数の上限（操作の規約の値。operation.ts が同じ値を出す）
export const MAX_ITEMS = 100;

// RFC 3339 の UTC の日時。月ごとの日の数とうるう年を正規表現で書き、実在しない日付を通さない。
// 2 月 29 日は 4 で割れる年（100 で割れて 400 で割れない年を除く）だけ。うるう秒の 60 は通さない
export const UTC_DATE_TIME =
  /^(?:\d{4}-(?:(?:0[1-9]|1[0-2])-(?:0[1-9]|1\d|2[0-8])|(?:0[13-9]|1[0-2])-(?:29|30)|(?:0[13578]|1[02])-31)|(?:\d{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;

export const utcDateTime = z.string().regex(UTC_DATE_TIME);

// IANA の時刻帯の名前の形。略称（JST）と差（+09:00）を通さない。名前の実在はハンドラーが Intl で照らす（決定 5）
export const timeZone = z.string().regex(/^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/);

// 時刻帯つきの暦の月
export const calendarMonth = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  time_zone: timeZone,
});

// ISO 4217 の英字 3 字
export const currencyCode = z.string().regex(/^[A-Z]{3}$/);

// 通貨つきの最小単位（ISO 4217 の minor unit）の整数
export const money = z.strictObject({
  amount_minor: z.int().min(0),
  currency: currencyCode,
});

// AWS のアカウント ID（12 桁の数字）。生成の見本は作り物の 123456789012 へ置き換える（scripts/artifacts.ts）
export const AWS_ACCOUNT_ID = /^\d{12}$/;
export const awsAccountId = z.string().regex(AWS_ACCOUNT_ID);

// BCP 47 の言語・文字・地域の部分だけ
export const languageTag = z.string().regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/);

const GITHUB_REPO = "[A-Za-z0-9-]{1,39}\\/[A-Za-z0-9._-]{1,100}";

// GitHub のリポジトリ owner/name と、課題と PR の owner/name#N
export const githubRepo = z.string().regex(new RegExp(`^${GITHUB_REPO}$`));
export const githubIssueRef = z.string().regex(new RegExp(`^${GITHUB_REPO}#[1-9]\\d*$`));

// 要求の本文の配列。1 件のときも要素 1 個の配列にする（I12）
export function itemsArray<T extends z.ZodType>(item: T, max: number = MAX_ITEMS): z.ZodArray<T> {
  return z.array(item).min(1).max(max);
}
