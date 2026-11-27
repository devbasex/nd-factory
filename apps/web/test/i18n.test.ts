import { describe, expect, it } from "vitest";
import en from "../src/i18n/en.json";
import { formatDateTime, formatMoney, formatNumber, formatRelative } from "../src/i18n/format.ts";
import ja from "../src/i18n/ja.json";
import { pickLocale } from "../src/i18n/locales.ts";
import { createTranslator, reasonKey } from "../src/i18n/translate.ts";

function keys(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe("pickLocale", () => {
  it("自分の設定が最優先", () => {
    expect(pickLocale("en", ["ja-JP"])).toBe("en");
  });
  it("ブラウザーの言語を地域を落として引く", () => {
    expect(pickLocale(null, ["fr-FR", "en-US"])).toBe("en");
    expect(pickLocale(null, ["ja-JP"])).toBe("ja");
  });
  it("どれも対応外なら ja", () => {
    expect(pickLocale("de", ["fr"])).toBe("ja");
    expect(pickLocale(null, [])).toBe("ja");
  });
});

describe("createTranslator", () => {
  it("言語を替えると文言が翻訳のファイルの文に変わる", () => {
    expect(createTranslator("ja")("common.retry")).toBe(ja.common.retry);
    expect(createTranslator("en")("common.retry")).toBe(en.common.retry);
    expect(ja.common.retry).not.toBe(en.common.retry);
  });
  it("差し込みと複数の形を解く", () => {
    const t = createTranslator("en");
    expect(t("offline.pending", { count: 1 })).toBe("1 operation waiting to be confirmed");
    expect(t("offline.pending", { count: 0 })).toBe("0 operations waiting to be confirmed");
    expect(createTranslator("ja")("offline.lastReceived", { time: "10:00" })).toContain("10:00");
  });
  it("無い理由のコードは汎用の文のキーを引く", () => {
    expect(reasonKey("store_unavailable")).toBe("errors.reason.store_unavailable");
    expect(reasonKey("http_599")).toBe("errors.reason.unknown");
    expect(reasonKey("toString")).toBe("errors.reason.unknown");
  });
  it("ja と en のキーの集合が一致する", () => {
    expect(keys(en).sort()).toEqual(keys(ja).sort());
  });
});

describe("日時・数・金額", () => {
  const iso = "2026-01-02T23:30:00.000Z";

  it("時刻帯で日付が替わる", () => {
    expect(formatDateTime(iso, { locale: "ja", timeZone: "UTC" })).toContain("2026/01/02");
    expect(formatDateTime(iso, { locale: "ja", timeZone: "Asia/Tokyo" })).toContain("2026/01/03");
  });
  it("24 時間以内は相対、ちょうど 24 時間までは相対で、それより前は日時", () => {
    const at = Date.parse(iso);
    const o = { locale: "en", timeZone: "UTC" } as const;
    expect(formatRelative(iso, at + 3 * 60_000, o)).toBe("3 minutes ago");
    expect(formatRelative(iso, at + 5 * 3_600_000, o)).toBe("5 hours ago");
    expect(formatRelative(iso, at + 86_400_000, o)).toBe("24 hours ago");
    expect(formatRelative(iso, at + 86_400_001, o)).toBe(formatDateTime(iso, o));
  });
  it("言語ごとに数と金額を出し、通貨の無い金額は null", () => {
    expect(formatNumber(1234567.5, "en")).toBe("1,234,567.5");
    expect(formatMoney(1200, "JPY", "ja")).toMatch(/1,200/);
    expect(formatMoney(1200, "JPY", "ja")).not.toMatch(/\./);
    expect(formatMoney(12.5, "USD", "en")).toBe("$12.50");
    expect(formatMoney(12.5, null, "en")).toBeNull();
    expect(formatMoney(12.5, "", "en")).toBeNull();
  });
});
