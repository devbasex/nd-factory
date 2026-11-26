import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INFRA_DEFAULTS, infraValues, parseSettings } from "../src/settings.ts";

const example = JSON.parse(readFileSync(new URL("../../../infra/settings.example.json", import.meta.url), "utf8")) as unknown;
const schema = JSON.parse(readFileSync(new URL("../schema/settings.schema.json", import.meta.url), "utf8")) as {
  properties: { network: { properties: { vpc_cidr: { pattern: string } } } };
};
const schemaCidr = new RegExp(schema.properties.network.properties.vpc_cidr.pattern);

function base(): Record<string, unknown> {
  return { prefix: "acme", environment: "test", login: { google: {} } };
}

describe("parseSettings", () => {
  it("見本は形に合う", () => {
    const r = parseSettings(example);
    expect(r.ok).toBe(true);
  });

  it("パイプラインとクライアントの ID を含む全部のキーを受ける", () => {
    const r = parseSettings({
      ...base(),
      login: { google: { client_id: "example-client-id.apps.googleusercontent.com" } },
      pipeline: { repository: "example-org/example-app", branch: "main", notify_emails: ["ops@example.com"] },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        prefix: "acme",
        environment: "test",
        login: { google: { client_id: "example-client-id.apps.googleusercontent.com" } },
        pipeline: { repository: "example-org/example-app", branch: "main", notify_emails: ["ops@example.com"] },
      },
    });
  });

  it.each(["abc", "a".repeat(20)])("prefix は 3 文字と 20 文字で通る（%s）", (prefix) => {
    expect(parseSettings({ ...base(), prefix }).ok).toBe(true);
  });

  it.each(["ab", "a".repeat(21), "Acme", "acme_x", "-acme", "acme-"])("prefix の形の誤りを 1 件にする（%s）", (prefix) => {
    const r = parseSettings({ ...base(), prefix });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]).toMatch(/^prefix: /);
    }
  });

  it("client_id が無くても通る", () => {
    expect(parseSettings(base()).ok).toBe(true);
  });

  it("aws で始まる prefix を 1 件の誤りにする", () => {
    const r = parseSettings({ ...base(), prefix: "awsome" });
    expect(r).toEqual({ ok: false, issues: [expect.stringMatching(/^prefix: .*aws/)] });
  });

  it("未知のキーを 1 件の誤りにする（入れ子の中も）", () => {
    expect(parseSettings({ ...base(), quota: 1 })).toEqual({ ok: false, issues: [expect.stringMatching(/^quota: 知らないキー/)] });
    expect(parseSettings({ ...base(), login: { google: {}, github: {} } })).toEqual({
      ok: false,
      issues: [expect.stringMatching(/^login\.github: /)],
    });
  });

  it("pipeline に repository が無いと 1 件の誤りにする", () => {
    const r = parseSettings({ ...base(), pipeline: { branch: "main" } });
    expect(r).toEqual({ ok: false, issues: [expect.stringMatching(/^pipeline\.repository: .*必須/)] });
  });

  it("足りないキーを 1 件 1 文字列で並べる", () => {
    const r = parseSettings({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toEqual([
        expect.stringMatching(/^prefix: /),
        expect.stringMatching(/^environment: /),
        expect.stringMatching(/^login: /),
      ]);
    }
  });

  it("environment の形を確かめる", () => {
    expect(parseSettings({ ...base(), environment: "t" }).ok).toBe(false);
    expect(parseSettings({ ...base(), environment: "test-1" }).ok).toBe(false);
    expect(parseSettings({ ...base(), environment: "abcdefghij" }).ok).toBe(true);
  });

  it("login.google が無いと誤りにする", () => {
    expect(parseSettings({ ...base(), login: {} })).toEqual({
      ok: false,
      issues: [expect.stringMatching(/^login\.google: /)],
    });
  });

  it("pipeline の repository の形と宛先のメールを確かめる", () => {
    expect(parseSettings({ ...base(), pipeline: { repository: "example-app", branch: "main" } }).ok).toBe(false);
    expect(
      parseSettings({ ...base(), pipeline: { repository: "example-org/example-app", branch: "main", notify_emails: ["x"] } }).ok,
    ).toBe(false);
  });

  it("オブジェクトでない入力を最上位の誤りにする", () => {
    expect(parseSettings([])).toEqual({ ok: false, issues: [expect.stringMatching(/^\(最上位\): /)] });
  });
});

describe("parseSettings のインフラのキー", () => {
  function infra(): Record<string, unknown> {
    return {
      ...base(),
      network: { vpc_cidr: "10.80.0.0/16" },
      progress_db: { max_acu: 2 },
      budget: { monthly_usd: 30, scope: "tags" },
      ops: { notify_emails: ["ops@example.com"] },
    };
  }

  function issuesOf(raw: unknown): string[] {
    const r = parseSettings(raw);
    return r.ok ? [] : r.issues;
  }

  it("5 つのキーを持つ設定のファイルを受け、値をそのまま返す", () => {
    const r = parseSettings(infra());
    expect(r).toEqual({ ok: true, value: infra() });
  });

  it("5 つのキーを持たない設定のファイルと、空の入れ物を受ける", () => {
    expect(parseSettings(base()).ok).toBe(true);
    expect(parseSettings({ ...base(), network: {}, progress_db: {}, budget: {}, ops: {} }).ok).toBe(true);
  });

  it.each(["10.80.0.0/16", "172.16.0.0/20", "192.168.16.0/20"])("CIDR の接頭辞 16〜20 は通る（%s）", (vpc_cidr) => {
    expect(parseSettings({ ...base(), network: { vpc_cidr } }).ok).toBe(true);
  });

  it.each(["10.0.0.0/15", "10.80.0.0/21", "10.80.0.0", "10.80.0.256/16", "10.80.0.0/x", "fd00::/16", ""])(
    "CIDR の形と接頭辞の誤りを 1 件にする（%s）",
    (vpc_cidr) => {
      const issues = issuesOf({ ...base(), network: { vpc_cidr } });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/^network\.vpc_cidr: /);
    },
  );

  it("CIDR のホストの部分が 0 でないと誤りにする", () => {
    expect(issuesOf({ ...base(), network: { vpc_cidr: "10.80.1.0/16" } })).toEqual([
      expect.stringMatching(/^network\.vpc_cidr: /),
    ]);
    expect(parseSettings({ ...base(), network: { vpc_cidr: "10.80.16.0/20" } }).ok).toBe(true);
    expect(parseSettings({ ...base(), network: { vpc_cidr: "10.80.8.0/20" } }).ok).toBe(false);
  });

  it.each([
    "10.80.0.0/16",
    "10.80.128.0/17",
    "10.80.192.0/18",
    "10.80.224.0/19",
    "10.80.240.0/20",
    "10.80.1.0/16",
    "10.80.64.0/17",
    "10.80.32.0/18",
    "10.80.16.0/19",
    "10.80.8.0/20",
    "10.80.0.1/20",
    "10.80.0.0/21",
    "010.80.0.0/16",
  ])("生成した JSON Schema の pattern と parseSettings の判定がそろう（%s）", (vpc_cidr) => {
    expect(schemaCidr.test(vpc_cidr)).toBe(parseSettings({ ...base(), network: { vpc_cidr } }).ok);
  });

  it.each([1, 1.5, 16])("最大 ACU の 1〜16 の 0.5 刻みは通る（%s）", (max_acu) => {
    expect(parseSettings({ ...base(), progress_db: { max_acu } }).ok).toBe(true);
  });

  it.each([0.5, 16.5, 1.25, 0, -1])("最大 ACU の範囲と刻みの誤りを 1 件にする（%s）", (max_acu) => {
    const issues = issuesOf({ ...base(), progress_db: { max_acu } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^progress_db\.max_acu: /);
  });

  it("最大 ACU が数でないと型の誤りにする", () => {
    expect(issuesOf({ ...base(), progress_db: { max_acu: "2" } })).toEqual([
      expect.stringMatching(/^progress_db\.max_acu: 型が違う/),
    ]);
  });

  it.each([1, 30, 100_000])("予算の額の 1〜100,000 の整数は通る（%s）", (monthly_usd) => {
    expect(parseSettings({ ...base(), budget: { monthly_usd } }).ok).toBe(true);
  });

  it.each([0, 100_001, 1.5, -1])("予算の額の範囲と整数の誤りを 1 件にする（%s）", (monthly_usd) => {
    const issues = issuesOf({ ...base(), budget: { monthly_usd } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^budget\.monthly_usd: /);
  });

  it.each(["tags", "account"])("予算の範囲の %s は通る", (scope) => {
    expect(parseSettings({ ...base(), budget: { scope } }).ok).toBe(true);
  });

  it.each(["tag", "TAGS", ""])("予算の範囲の一覧に無い値を 1 件の誤りにする（%s）", (scope) => {
    expect(issuesOf({ ...base(), budget: { scope } })).toEqual([expect.stringMatching(/^budget\.scope: /)]);
  });

  it("運用の知らせの宛先は 0 件と 10 件で通り、11 件で落ちる", () => {
    const emails = (n: number) => Array.from({ length: n }, (_, i) => `ops${i}@example.com`);
    expect(parseSettings({ ...base(), ops: { notify_emails: [] } }).ok).toBe(true);
    expect(parseSettings({ ...base(), ops: { notify_emails: emails(10) } }).ok).toBe(true);
    expect(issuesOf({ ...base(), ops: { notify_emails: emails(11) } })).toEqual([
      expect.stringMatching(/^ops\.notify_emails: /),
    ]);
  });

  it("メールでない宛先を、その要素のパスの 1 件の誤りにする", () => {
    expect(issuesOf({ ...base(), ops: { notify_emails: ["ops@example.com", "ops"] } })).toEqual([
      expect.stringMatching(/^ops\.notify_emails\.1: メールの形でない/),
    ]);
  });

  it("入れ物の中の未知のキーを 1 件の誤りにする", () => {
    expect(issuesOf({ ...base(), network: { vpc_cidr: "10.80.0.0/16", subnet_mask: 24 } })).toEqual([
      "network.subnet_mask: 知らないキー",
    ]);
    expect(issuesOf({ ...base(), budget: { amount: 30 } })).toEqual(["budget.amount: 知らないキー"]);
    expect(issuesOf({ ...base(), ops: { notify: [] } })).toEqual(["ops.notify: 知らないキー"]);
  });

  it("#13 の読まないキーはまだ知らないキーにする", () => {
    expect(issuesOf({ ...base(), limits: { max_concurrent_lanes: 20 } })).toEqual([
      expect.stringMatching(/^limits: 知らないキー/),
    ]);
    expect(issuesOf({ ...base(), progress_db: { rotation_retry_limit: 3 } })).toEqual([
      "progress_db.rotation_retry_limit: 知らないキー",
    ]);
    expect(issuesOf({ ...base(), retention: { records_days: 365 } })).toEqual([
      expect.stringMatching(/^retention: 知らないキー/),
    ]);
  });
});

describe("infraValues", () => {
  function settingsOf(raw: unknown) {
    const r = parseSettings(raw);
    if (!r.ok) throw new Error(r.issues.join("\n"));
    return r.value;
  }

  it("キーの無い設定では既定を返す", () => {
    expect(infraValues(settingsOf(base()))).toEqual({
      vpcCidr: "10.80.0.0/16",
      maxAcu: 2,
      budgetUsd: 30,
      budgetScope: "tags",
      opsEmails: [],
    });
    expect(infraValues(settingsOf(base()))).toEqual(INFRA_DEFAULTS);
  });

  it("空の入れ物でも既定を返す", () => {
    expect(infraValues(settingsOf({ ...base(), network: {}, progress_db: {}, budget: {}, ops: {} }))).toEqual(INFRA_DEFAULTS);
  });

  it("書いたキーだけを設定の値にする", () => {
    const s = settingsOf({
      ...base(),
      network: { vpc_cidr: "172.16.0.0/20" },
      budget: { scope: "account" },
      ops: { notify_emails: ["ops@example.com"] },
    });
    expect(infraValues(s)).toEqual({
      vpcCidr: "172.16.0.0/20",
      maxAcu: 2,
      budgetUsd: 30,
      budgetScope: "account",
      opsEmails: ["ops@example.com"],
    });
  });

  it("返した宛先の配列を変えても既定は変わらない", () => {
    const v = infraValues(settingsOf(base()));
    expect(() => (v.opsEmails as string[]).push("ops@example.com")).not.toThrow();
    expect(INFRA_DEFAULTS.opsEmails).toEqual([]);
  });

  it("既定は設定のファイルの形に合う", () => {
    const r = parseSettings({
      ...base(),
      network: { vpc_cidr: INFRA_DEFAULTS.vpcCidr },
      progress_db: { max_acu: INFRA_DEFAULTS.maxAcu },
      budget: { monthly_usd: INFRA_DEFAULTS.budgetUsd, scope: INFRA_DEFAULTS.budgetScope },
      ops: { notify_emails: [...INFRA_DEFAULTS.opsEmails] },
    });
    expect(r.ok).toBe(true);
  });
});

describe("pipeline.branch の形", () => {
  const withBranch = (branch: string) => ({ ...base(), pipeline: { repository: "example-org/example-app", branch } });
  const schemaBranch = new RegExp(
    (
      JSON.parse(readFileSync(new URL("../schema/settings.schema.json", import.meta.url), "utf8")) as {
        properties: { pipeline: { properties: { branch: { pattern: string } } } };
      }
    ).properties.pipeline.properties.branch.pattern,
  );

  it.each(["main", "release/v1", "feature_x-1.2"])("受ける（%s）", (branch) => {
    expect(parseSettings(withBranch(branch)).ok).toBe(true);
    expect(schemaBranch.test(branch)).toBe(true);
  });

  it.each(["*", "a?b", "a[0]", "{a}", "!main", "a\\b", "my branch", ""])("拒む（%j）", (branch) => {
    const r = parseSettings(withBranch(branch));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatch(/^pipeline\.branch: /);
    expect(schemaBranch.test(branch)).toBe(false);
  });
});
