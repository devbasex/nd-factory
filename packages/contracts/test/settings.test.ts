import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSettings } from "../src/settings.ts";

const example = JSON.parse(readFileSync(new URL("../../../infra/settings.example.json", import.meta.url), "utf8")) as unknown;

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
    expect(parseSettings({ ...base(), budget: 1 })).toEqual({ ok: false, issues: [expect.stringMatching(/^budget: /)] });
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
