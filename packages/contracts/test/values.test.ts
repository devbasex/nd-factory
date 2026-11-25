import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ID_KINDS, idOf } from "../src/ids.ts";
import { ITEM_REASONS, REASON_CODE, REQUEST_REASONS } from "../src/reasons.ts";
import { delegationToken, machineToken, runnerTokenClaims } from "../src/tokens.ts";
import {
  calendarMonth,
  currencyCode,
  githubIssueRef,
  githubRepo,
  itemsArray,
  languageTag,
  MAX_ITEMS,
  money,
  timeZone,
  utcDateTime,
} from "../src/values.ts";

// 生成した JSON Schema の pattern を、Ajv と同じく u の旗で正規表現にして照らす（日時は下の ajvValidator でスキーマ全体を照らす）
function schemaPattern(schema: z.ZodType): RegExp {
  const json = z.toJSONSchema(schema) as { pattern?: string };
  if (json.pattern === undefined) throw new Error("JSON Schema に pattern が無い");
  return new RegExp(json.pattern, "u");
}

function passes(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

// 生成した JSON Schema の全体を Ajv（生成の単位の往復と同じ設定）で検証する
const ajv = new Ajv2020({ strict: true, validateFormats: false });
function ajvValidator(schema: z.ZodType): (value: unknown) => boolean {
  const validate = ajv.compile(z.toJSONSchema(schema));
  return (value) => validate(value);
}

const UUID_V7 = "01935b4e-7c2a-7d10-8f3e-2b6f0c9a1d42";

describe("utcDateTime", () => {
  const byAjv = ajvValidator(utcDateTime);

  function both(value: string): boolean {
    const byZod = passes(utcDateTime, value);
    expect(byAjv(value)).toBe(byZod);
    return byZod;
  }

  it.each([
    "2026-11-17T03:04:05.123Z",
    "2026-11-17T03:04:05Z",
    "2026-11-17T03:04:05.1Z",
    "2024-02-29T00:00:00Z",
    "2000-02-29T00:00:00Z",
    "2026-01-31T00:00:00Z",
    "2026-02-28T00:00:00Z",
    "2026-04-30T00:00:00Z",
    "2026-12-31T23:59:59Z",
  ])("通す（%s）", (value) => {
    expect(both(value)).toBe(true);
  });

  it.each([
    "2026-11-17T03:04:05+09:00",
    "2026-11-17T03:04:05",
    "2026-11-17T03:04:05.1234Z",
    "2026-11-17T03:04:05z",
    "2026-02-30T25:00:00Z",
    "2026-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-00T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:60Z",
  ])("拒む（%s）", (value) => {
    expect(both(value)).toBe(false);
  });

  it("時刻帯の無い日時を拒む（I15）", () => {
    expect(passes(utcDateTime, "2026-11-17T03:04:05.123")).toBe(false);
    expect(passes(utcDateTime, "2026-11-17 03:04:05")).toBe(false);
  });

  it("1896〜2104 年の毎日で、通す日付と実在する日付が食い違わない", () => {
    const mismatches: string[] = [];
    for (let y = 1896; y <= 2104; y++) {
      for (let m = 1; m <= 12; m++) {
        for (let d = 1; d <= 31; d++) {
          const at = new Date(Date.UTC(y, m - 1, d));
          const real = at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
          const text = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00Z`;
          if (passes(utcDateTime, text) !== real || byAjv(text) !== real) mismatches.push(text);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("money", () => {
  it("通貨つきの最小単位の整数を通す", () => {
    expect(passes(money, { amount_minor: 1234, currency: "USD" })).toBe(true);
    expect(passes(money, { amount_minor: 1000, currency: "JPY" })).toBe(true);
  });

  it("金額 0 を通す", () => {
    expect(passes(money, { amount_minor: 0, currency: "USD" })).toBe(true);
  });

  it("通貨の無い金額を拒む（I15）", () => {
    expect(passes(money, { amount_minor: 1234 })).toBe(false);
    expect(passes(money, 1234)).toBe(false);
  });

  it.each([
    { amount_minor: 12.34, currency: "USD" },
    { amount_minor: "1234", currency: "USD" },
    { amount_minor: 1234, currency: "usd" },
    { amount_minor: -1, currency: "USD" },
    { amount_minor: 1234, currency: "USD", note: "x" },
  ])("形の違う金額を拒む（%j）", (value) => {
    expect(passes(money, value)).toBe(false);
  });

  it("通貨の符号は英大文字 3 字", () => {
    expect(passes(currencyCode, "EUR")).toBe(true);
    expect(passes(currencyCode, "EURO")).toBe(false);
    expect(passes(currencyCode, "$")).toBe(false);
  });
});

describe("timeZone", () => {
  it.each(["Asia/Tokyo", "UTC", "America/Argentina/Buenos_Aires", "America/New_York", "Etc/GMT+9", "Etc/GMT-14"])(
    "通す（%s）",
    (value) => {
      expect(passes(timeZone, value)).toBe(true);
      expect(schemaPattern(timeZone).test(value)).toBe(true);
    },
  );

  it.each(["JST", "+09:00", "asia/tokyo", "", "Asia/", "/Tokyo"])("拒む（%s）", (value) => {
    expect(passes(timeZone, value)).toBe(false);
    expect(schemaPattern(timeZone).test(value)).toBe(false);
  });
});

describe("calendarMonth", () => {
  it("時刻帯つきの月を通す", () => {
    expect(passes(calendarMonth, { month: "2026-11", time_zone: "UTC" })).toBe(true);
    expect(passes(calendarMonth, { month: "2026-01", time_zone: "Asia/Tokyo" })).toBe(true);
  });

  it.each([
    { month: "2026-11" },
    { month: "2026-13", time_zone: "UTC" },
    { month: "2026-00", time_zone: "UTC" },
    { month: "2026-11", time_zone: "JST" },
    { month: "2026-11-01", time_zone: "UTC" },
  ])("拒む（%j）", (value) => {
    expect(passes(calendarMonth, value)).toBe(false);
  });
});

describe("languageTag", () => {
  it.each(["ja", "en", "pt-BR", "zh-Hant-TW", "es-419", "fil"])("通す（%s）", (value) => {
    expect(passes(languageTag, value)).toBe(true);
    expect(schemaPattern(languageTag).test(value)).toBe(true);
  });

  it.each(["ja_JP", "JA", "", "en-us", "zh-hant"])("拒む（%s）", (value) => {
    expect(passes(languageTag, value)).toBe(false);
    expect(schemaPattern(languageTag).test(value)).toBe(false);
  });
});

describe("githubRepo・githubIssueRef", () => {
  it("リポジトリの参照", () => {
    expect(passes(githubRepo, "acme/web")).toBe(true);
    expect(passes(githubRepo, "acme/web.site_v2-x")).toBe(true);
    expect(passes(githubRepo, `${"a".repeat(39)}/web`)).toBe(true);
    expect(passes(githubRepo, `${"a".repeat(40)}/web`)).toBe(false);
    expect(passes(githubRepo, "acme")).toBe(false);
    expect(passes(githubRepo, "acme/web#42")).toBe(false);
  });

  it("課題と PR の参照", () => {
    expect(passes(githubIssueRef, "acme/web#42")).toBe(true);
    expect(passes(githubIssueRef, "acme/web#1")).toBe(true);
    expect(passes(githubIssueRef, "acme/web#0")).toBe(false);
    expect(passes(githubIssueRef, "acme/web#")).toBe(false);
    expect(passes(githubIssueRef, "acme/web")).toBe(false);
  });
});

describe("itemsArray", () => {
  const items = itemsArray(z.strictObject({ id: z.string() }));

  it("要素の数は 1〜100", () => {
    expect(MAX_ITEMS).toBe(100);
    expect(passes(items, [{ id: "a" }])).toBe(true);
    expect(passes(items, Array.from({ length: 100 }, () => ({ id: "a" })))).toBe(true);
    expect(passes(items, Array.from({ length: 101 }, () => ({ id: "a" })))).toBe(false);
    expect(passes(items, [])).toBe(false);
  });

  it("配列でない本文を拒む（I12）", () => {
    expect(passes(items, { id: "a" })).toBe(false);
  });

  it("上限を渡せる", () => {
    const small = itemsArray(z.string(), 2);
    expect(passes(small, ["a", "b"])).toBe(true);
    expect(passes(small, ["a", "b", "c"])).toBe(false);
  });
});

describe("idOf", () => {
  it("頭と UUIDv7 が合う ID を通す", () => {
    expect(passes(idOf("spr"), `spr_${UUID_V7}`)).toBe(true);
  });

  it("どの頭も同じ形で作れる", () => {
    for (const kind of ID_KINDS) expect(passes(idOf(kind), `${kind}_${UUID_V7}`)).toBe(true);
    expect(ID_KINDS).toHaveLength(16);
  });

  it.each([
    `spr_${UUID_V7.toUpperCase()}`,
    `prj_${UUID_V7}`,
    "spr_01935b4e-7c2a-4d10-8f3e-2b6f0c9a1d42",
    "spr_01935b4e-7c2a-7d10-cf3e-2b6f0c9a1d42",
    "spr_01935b4e-7c2a-7d10-7f3e-2b6f0c9a1d42",
    UUID_V7,
    `spr-${UUID_V7}`,
  ])("拒む（%s）", (value) => {
    expect(passes(idOf("spr"), value)).toBe(false);
    expect(schemaPattern(idOf("spr")).test(value)).toBe(false);
  });
});

describe("delegationToken・machineToken", () => {
  const secret = "A".repeat(42) + "_";
  const usr = `usr_${UUID_V7}`;
  const dlg = `dlg_${UUID_V7}`;
  const team = `team_${UUID_V7}`;
  const mch = `mch_${UUID_V7}`;

  it("委任の token の形", () => {
    expect(passes(delegationToken, `ndfd_${usr}.${dlg}.${secret}`)).toBe(true);
    expect(passes(delegationToken, `ndfd_${dlg}.${usr}.${secret}`)).toBe(false);
    expect(passes(delegationToken, `ndfd_${usr}.${dlg}.${secret}A`)).toBe(false);
    expect(passes(delegationToken, `ndfd_${usr}.${dlg}.${"A".repeat(42)}=`)).toBe(false);
    expect(passes(delegationToken, `ndfm_${usr}.${dlg}.${secret}`)).toBe(false);
  });

  it("登録の token の形", () => {
    expect(passes(machineToken, `ndfm_${team}.${mch}.${secret}`)).toBe(true);
    expect(passes(machineToken, `ndfm_${usr}.${mch}.${secret}`)).toBe(false);
    expect(passes(machineToken, `ndfd_${team}.${mch}.${secret}`)).toBe(false);
  });
});

describe("runnerTokenClaims", () => {
  const lane = "lane_01890a5d-ac96-774b-bcce-000000000001";
  const prj = "prj_01890a5d-ac96-774b-bcce-000000000002";
  const runner = { aud: "lane", exp: 1_800_000_000, token_use: "lane", sub: lane, project_id: prj, generation: 2 };

  it("ランナーの主張は宛先 lane・用途 exchange か lane・レーンの ID・プロジェクトの ID・整数の世代を持つ", () => {
    expect(runnerTokenClaims.safeParse(runner).success).toBe(true);
    expect(runnerTokenClaims.safeParse({ ...runner, token_use: "exchange", iat: 1 }).success).toBe(true);
    for (const over of [{ aud: "acme-other" }, { token_use: "completion" }, { sub: prj }, { project_id: lane }, { generation: 1.5 }, { generation: "2" }, { exp: "1" }]) {
      expect(runnerTokenClaims.safeParse({ ...runner, ...over }).success).toBe(false);
    }
    const { generation: _generation, ...withoutGeneration } = runner;
    expect(runnerTokenClaims.safeParse(withoutGeneration).success).toBe(false);
  });

  it("形は JSON Schema で表せる", () => {
    expect(() => z.toJSONSchema(runnerTokenClaims)).not.toThrow();
  });
});

describe("理由のコード", () => {
  it("どのコードも英小文字・数字・_ で、集まりの中で重ならない", () => {
    for (const set of [REQUEST_REASONS, ITEM_REASONS]) {
      const codes = set.map((r) => r.code);
      for (const code of codes) expect(code).toMatch(REASON_CODE);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it("要素の理由は 9 つで、状態と条件が決まっている", () => {
    expect(ITEM_REASONS.map((r) => [r.code, r.status, r.when])).toEqual([
      ["item_invalid", 400, "always"],
      ["not_found", 404, "always"],
      ["role_insufficient", 403, "always"],
      ["human_only", 403, "human_only_per_item"],
      ["version_mismatch", 409, "write"],
      ["state_mismatch", 409, "write"],
      ["idempotency_key_reused", 422, "idempotency"],
      ["in_progress", 409, "idempotency"],
      ["not_applied", 409, "all_or_nothing"],
    ]);
  });

  it("要求全体の理由は 13 で、状態が決まっている", () => {
    expect(REQUEST_REASONS.map((r) => [r.code, r.status])).toEqual([
      ["body_not_json", 400],
      ["body_not_array", 400],
      ["body_empty", 400],
      ["too_many_items", 400],
      ["duplicate_item", 400],
      ["cursor_invalid", 400],
      ["unauthorized", 401],
      ["session_ended", 401],
      ["human_only", 403],
      ["scope_insufficient", 403],
      ["unavailable", 503],
      ["audit_unavailable", 503],
      ["too_many_requests", 429],
    ]);
  });
});
