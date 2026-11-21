import { describe, expect, it } from "vitest";
import {
  NDF_CONTRACTS,
  PLANS,
  readNdfContracts,
  readPlans,
  readRetryPolicies,
  readSecretShapes,
  RETRY_POLICIES,
  SECRET_SHAPES,
} from "../src/data.ts";

const SHA = "ed8b036584bec284dfc93a2bb5b988e2385b4f8f297d659399f5d3cb91b520c4";
const OTHER_SHA = "f".repeat(64);

describe("NDF_CONTRACTS", () => {
  it("受ける組は版 8 と sha256 の対 1 つ", () => {
    expect(NDF_CONTRACTS).toEqual({ accepted: [{ version: 8, sha256: SHA }] });
  });

  it.each([
    ["空", { accepted: [] }],
    ["同じ版の重なり", { accepted: [{ version: 8, sha256: SHA }, { version: 8, sha256: OTHER_SHA }] }],
    ["同じ sha256 の重なり", { accepted: [{ version: 8, sha256: SHA }, { version: 9, sha256: SHA }] }],
    ["版と sha256 の対でない形", { accepted: [{ version: 8, sha256: SHA.slice(1) }] }],
  ])("%s で読み込みが投げる", (_why, raw) => {
    expect(() => readNdfContracts(raw)).toThrow();
  });
});

describe("RETRY_POLICIES", () => {
  it("7 つの方針が種類ごとの形と値を持つ", () => {
    expect(RETRY_POLICIES).toEqual({
      dynamodb: { kind: "aws", retry_mode: "standard", max_attempts: 3, request_timeout_ms: 2000 },
      "aws-control": { kind: "aws", retry_mode: "standard", max_attempts: 3, request_timeout_ms: 5000 },
      "dynamodb-transaction": { kind: "transaction", retries: 2, min_ms: 50, max_ms: 1000 },
      "http-github": { kind: "http", limit: 3, timeout_ms: 10000, total_timeout_ms: 30000, backoff_limit_ms: 5000, max_retry_after_ms: 5000 },
      "http-notify": { kind: "http", limit: 3, timeout_ms: 5000, total_timeout_ms: 15000, backoff_limit_ms: 5000, max_retry_after_ms: 5000 },
      "runner-to-api": { kind: "http", limit: 5, timeout_ms: 10000, total_timeout_ms: 60000, backoff_limit_ms: 30000, max_retry_after_ms: 30000 },
      "http-idp-keys": { kind: "jwks", response_timeout_ms: 3000 },
    });
  });

  function withPolicy(name: string, policy: unknown): Record<string, unknown> {
    return { ...RETRY_POLICIES, [name]: policy };
  }

  it("今の値は読み直しても同じ", () => {
    expect(readRetryPolicies(structuredClone(RETRY_POLICIES))).toEqual(RETRY_POLICIES);
  });

  it.each([
    ["方針の欠け", Object.fromEntries(Object.entries(RETRY_POLICIES).filter(([name]) => name !== "dynamodb"))],
    ["名前に無い方針", withPolicy("http-other", { kind: "jwks", response_timeout_ms: 3000 })],
    ["鍵の欠け", withPolicy("dynamodb", { kind: "aws", retry_mode: "standard", max_attempts: 3 })],
    ["負の数", withPolicy("dynamodb-transaction", { kind: "transaction", retries: -1, min_ms: 50, max_ms: 1000 })],
    ["整数でない数", withPolicy("http-idp-keys", { kind: "jwks", response_timeout_ms: 2.5 })],
    ["種類に無い鍵", withPolicy("http-idp-keys", { kind: "jwks", response_timeout_ms: 3000, limit: 3 })],
    ["種類が無い", withPolicy("http-idp-keys", { response_timeout_ms: 3000 })],
    ["知らない種類", withPolicy("http-idp-keys", { kind: "grpc", response_timeout_ms: 3000 })],
    ["standard でない再試行の型", withPolicy("dynamodb", { kind: "aws", retry_mode: "adaptive", max_attempts: 3, request_timeout_ms: 2000 })],
  ])("%s で読み込みが投げる", (_why, raw) => {
    expect(() => readRetryPolicies(raw)).toThrow();
  });
});

describe("SECRET_SHAPES", () => {
  // 作り物の値。検査の道具に本物の秘密と見られないよう、頭と中身を分けて組む
  const fake = (head: string, body: string): string => `${head}${body}`;

  const hits: Record<string, string> = {
    delegation_token: fake("ndfd_", "usr_x.dlg_y.EXAMPLE"),
    machine_token: fake("ndfm_", "team_x.mch_y.EXAMPLE"),
    jwt: fake("eyJ", "hbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2ln"),
    github_app_token: fake("ghs_", "EXAMPLE"),
    github_personal_token: fake("ghp_", "EXAMPLE"),
    github_oauth_token: fake("gho_", "EXAMPLE"),
    github_fine_grained_token: fake("github_pat_", "EXAMPLE"),
    private_key: fake("-----BEGIN RSA ", "PRIVATE KEY-----"),
    url_with_credentials: fake("postgres://acme:", "example@db.example.com/acme"),
    aws_temporary_key: fake("ASIA", "EXAMPLE0EXAMPLE0"),
  };

  const misses: Record<string, string> = {
    delegation_token: "ndf_usr_x",
    machine_token: "ndfx_team_x",
    jwt: "eyJonly.one",
    github_app_token: "ghs-EXAMPLE",
    github_personal_token: "ghp-EXAMPLE",
    github_oauth_token: "gho-EXAMPLE",
    github_fine_grained_token: "github_EXAMPLE",
    private_key: "-----BEGIN PUBLIC KEY-----",
    url_with_credentials: "https://db.example.com/acme",
    aws_temporary_key: "ASIAshort",
  };

  it("鍵の名前に含む語を持つ", () => {
    expect(SECRET_SHAPES.keyNames).toEqual(["authorization", "token", "secret", "password", "credentials", "private_key", "dsn"]);
  });

  it("値の形の各行が作り物の値に当たり、当たらない値に当たらない", () => {
    expect(SECRET_SHAPES.valuePatterns.map((p) => p.name).sort()).toEqual(Object.keys(hits).sort());
    for (const { name, pattern } of SECRET_SHAPES.valuePatterns) {
      const re = new RegExp(pattern, "u");
      expect(re.test(hits[name] ?? ""), `${name} に当たる`).toBe(true);
      expect(re.test(misses[name] ?? "ndf"), `${name} に当たらない`).toBe(false);
    }
  });

  it.each([
    ["正規表現として読めない行", { key_names: ["token"], value_patterns: [{ name: "broken", pattern: "(ab" }] }],
    ["鍵の名前が空", { key_names: [], value_patterns: [{ name: "jwt", pattern: "eyJ" }] }],
    ["値の形が空", { key_names: ["token"], value_patterns: [] }],
    ["名前の重なり", { key_names: ["token"], value_patterns: [{ name: "jwt", pattern: "eyJ" }, { name: "jwt", pattern: "eyK" }] }],
  ])("%s で読み込みが投げる", (_why, raw) => {
    expect(() => readSecretShapes(raw)).toThrow();
  });
});

describe("PLANS", () => {
  it("上限なしの 1 行", () => {
    expect(PLANS).toEqual([{ name: "unlimited", places: ["hosted", "machine"], inference: ["managed", "byok"], concurrency: null, monthly_cap: null }]);
  });

  it("月の上限額は通貨つきの金額", () => {
    const row = { name: "small", places: ["hosted"], inference: ["managed"], concurrency: 2, monthly_cap: { amount_minor: 10000, currency: "USD" } };
    expect(readPlans([row])).toEqual([row]);
  });

  it.each([
    ["空", []],
    ["通貨の無い上限額", [{ name: "small", places: ["hosted"], inference: ["managed"], concurrency: null, monthly_cap: { amount_minor: 10000 } }]],
    ["知らない実行の場所", [{ name: "small", places: ["cloud"], inference: ["managed"], concurrency: null, monthly_cap: null }]],
    ["同時の数が 0", [{ name: "small", places: ["hosted"], inference: ["managed"], concurrency: 0, monthly_cap: null }]],
    [
      "名前の重なり",
      [
        { name: "small", places: ["hosted"], inference: ["managed"], concurrency: null, monthly_cap: null },
        { name: "small", places: ["machine"], inference: ["byok"], concurrency: null, monthly_cap: null },
      ],
    ],
  ])("%s で読み込みが投げる", (_why, raw) => {
    expect(() => readPlans(raw)).toThrow();
  });
});
