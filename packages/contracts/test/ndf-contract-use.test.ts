import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import useData from "../data/ndf-contract-use.json" with { type: "json" };
import generatedData from "../data/ndf-contract-use.generated.json" with { type: "json" };
import { DataFileError, NDF_CONTRACTS } from "../src/data.ts";
import { ndfContractUseGenerated, type NdfCall, type NdfEntrypointRow } from "../src/ndf-contract-use-schema.ts";
import { buildContractUse, filePathPattern, judgeCallWith, ndfContractUse, readReportWith } from "../src/ndf-contract-use.ts";
import { REPORT_ITEMS } from "../src/ndf-contract-use-schema.ts";

/** 固定の点（8d22be7）の契約の写し。説明の文の列は写していない */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ndf-contract-8d22be7");
const readFixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

type Case = NdfCall & { id: string; valid: boolean };
const CASES = (readFixture("entrypoint-cases.json") as { rows: Case[] }).rows;

const GENERATED = ndfContractUseGenerated.parse(generatedData);

type ReportCase = { text: string; result: string; errors: string[] };
const REPORT_CASES = (readFixture("unattended-report.json") as { cases: ReportCase[] }).cases;
const SKILL_PREFIX = "ndf:";

/** execution.md の「使うインタフェース」の表の 11 の id（表を変えるときに同じ変更で直す） */
const USED_ENTRYPOINTS = [
  "skill-workflow",
  "block-next",
  "report-unattended",
  "hook-unattended-start",
  "hook-unattended-stop",
  "hook-unattended-end",
  "file-plan-progress",
  "file-journals",
  "file-issue-request",
  "gate-record",
  "spec-io",
];

function judge(call: NdfCall, rows: readonly NdfEntrypointRow[] = GENERATED.entrypoints): boolean {
  return judgeCallWith(rows, GENERATED.files, SKILL_PREFIX, call);
}

function caseById(id: string): Case {
  const found = CASES.find((c) => c.id === id);
  if (found === undefined) throw new Error(`サンプルが無い: ${id}`);
  return found;
}

describe("judgeCallWith", () => {
  const used = CASES.filter((c) => USED_ENTRYPOINTS.includes(c.entrypoint));

  it("使うインタフェースへのサンプルは固定の点で 21 件", () => {
    expect(used).toHaveLength(21);
  });

  it.each(used.map((c) => [c.id, c] as const))("サンプル %s で判定が valid と同じ", (_id, sample) => {
    expect(judge(sample)).toBe(sample.valid);
  });

  it("block-next は /goal の前置きが無い resume も、ある resume-loop も真", () => {
    expect(judge(caseById("resume"))).toBe(true);
    expect(judge(caseById("resume-loop"))).toBe(true);
  });

  it("block-next は Skill の前置きと target の後に空白が無いと偽", () => {
    expect(judge({ ...caseById("resume"), call: "/ndf:development-workflow#895" })).toBe(false);
    expect(judge({ ...caseById("resume"), call: "/development-workflow #895" })).toBe(false);
  });

  it("spec は target の配下のファイルだけを真にする（spec-io-args は真、spec-outside は偽、target そのものも偽）", () => {
    expect(judge(caseById("spec-io-args"))).toBe(true);
    expect(judge(caseById("spec-outside"))).toBe(false);
    expect(judge({ entrypoint: "spec-io", call: "contracts/schemas/io/", env: [] })).toBe(false);
    expect(judge({ entrypoint: "spec-io", call: "contracts/schemas/io", env: [] })).toBe(false);
  });

  it("file は読むファイルの path の形に一致する（plan-progress・issue-request の .）", () => {
    expect(judge(caseById("plan-progress"))).toBe(true);
    expect(judge(caseById("issue-request"))).toBe(true);
    expect(judge({ ...caseById("issue-request"), call: "a" })).toBe(false);
    expect(judge({ entrypoint: "file-journals", call: "gate-rejections.jsonl", env: ["NDF_MVV_STATE_DIR"] })).toBe(true);
  });

  it("引数の正規表現は全体で一致させる（loop-bad-budget・unknown-flag は偽）", () => {
    expect(judge(caseById("loop-bad-budget"))).toBe(false);
    expect(judge(caseById("unknown-flag"))).toBe(false);
    expect(judge({ ...caseById("new"), call: "#895 extra" })).toBe(false);
  });

  it("行の env に無い環境変数を入れる呼び出しは偽（terminal-env）", () => {
    expect(judge(caseById("terminal-env"))).toBe(false);
  });

  it("hook は事象の名前が target と同じときだけ真", () => {
    expect(judge(caseById("hook-stop"))).toBe(true);
    expect(judge({ ...caseById("hook-stop"), call: "SessionEnd" })).toBe(false);
  });

  it("使わないインタフェースの呼び出しは、契約で有効でも偽", () => {
    for (const id of ["loop-record", "organizer-request", "spec-page", "spec-ndf_settings"]) {
      expect(caseById(id).valid).toBe(true);
      expect(judge(caseById(id))).toBe(false);
    }
  });

  it("読めない正規表現を持つ行では、例外を投げずに偽", () => {
    const rows = GENERATED.entrypoints.map((row) => (row.id === "gate-record" ? { ...row, args: ["(", ...(row.args ?? [])] } : row));
    expect(judge(caseById("gate-design"), rows)).toBe(true);
    const broken = GENERATED.entrypoints.map((row) => (row.id === "gate-record" ? { ...row, args: ["("] } : row));
    expect(() => judge(caseById("gate-design"), broken)).not.toThrow();
    expect(judge(caseById("gate-design"), broken)).toBe(false);
  });

  it("args を持たない skill・report・command の行では偽", () => {
    const rows = GENERATED.entrypoints.map((row) => {
      if (row.id !== "report-unattended") return row;
      const { args: _args, ...rest } = row;
      return rest;
    });
    expect(judge(caseById("report-done"), rows)).toBe(false);
  });

  it("知らない kind の行では偽", () => {
    const rows = GENERATED.entrypoints.map((row) => (row.id === "hook-unattended-stop" ? { ...row, kind: "other" } : row));
    expect(judge(caseById("hook-stop"), rows)).toBe(false);
  });
});

describe("filePathPattern", () => {
  it("<名前> は / を含まない 1 文字以上の並びに一致する", () => {
    const re = filePathPattern("<sprint>/<n>-<plan>-state/progress.jsonl");
    expect(re.test("s1/8-release-request-state/progress.jsonl")).toBe(true);
    expect(re.test("s1/x/8-release-request-state/progress.jsonl")).toBe(false);
    expect(re.test("/8-release-request-state/progress.jsonl")).toBe(false);
  });

  it(". は . だけに一致する", () => {
    const re = filePathPattern(".");
    expect(re.test(".")).toBe(true);
    expect(re.test("a")).toBe(false);
    expect(re.test("..")).toBe(false);
  });

  it("path の中の特殊文字は、そのままの文字にだけ一致する", () => {
    const re = filePathPattern("ask.jsonl");
    expect(re.test("ask.jsonl")).toBe(true);
    expect(re.test("askxjsonl")).toBe(false);
    expect(filePathPattern("a+(b)[c]").test("a+(b)[c]")).toBe(true);
  });
});

describe("readReportWith", () => {
  const read = (text: string) => readReportWith(GENERATED.report, text);

  /** 結果の行の前に `before` を、後ろに項目の行を置いた区間の報告 */
  function report(result: string, items: Record<string, string> | [string, string][], before = ""): string {
    const lines = (Array.isArray(items) ? items : Object.entries(items)).map(([k, v]) => `- ${k}: ${v}`);
    return `${before}## 区間の報告\n\n- 結果: ${result}\n${lines.join("\n")}\n`;
  }

  const GATE = { 課題: "#12", 区分: "ndf-ask:cost", 質問: "進めてよいか" };

  it("固定の点の cases は 16 件", () => {
    expect(REPORT_CASES).toHaveLength(16);
  });

  it.each(REPORT_CASES.map((c, i) => [i, c] as const))("cases[%i] で result と errors の有無がサンプルと同じ", (_i, sample) => {
    const got = read(sample.text);
    expect(got.result).toBe(sample.result);
    expect(got.errors.length > 0).toBe(sample.errors.length > 0);
  });

  it("有効な報告で、items の値と URL の並びの material を返す", () => {
    const got = read(report("判断が要る", { ...GATE, "Pull Request": "無し", 材料: "https://github.com/acme/app/issues/1 https://github.com/acme/app/pull/2" }));
    expect(got.errors).toEqual([]);
    expect(got.items).toMatchObject({ 区分: "ndf-ask:cost", 質問: "進めてよいか", "Pull Request": "無し", 課題: "#12" });
    expect(got.material).toEqual({ kind: "urls", urls: ["https://github.com/acme/app/issues/1", "https://github.com/acme/app/pull/2"] });
  });

  it("items は REPORT_ITEMS の名前だけを持ち、報告に無い項目のキーを持たない", () => {
    const got = read(report("完了", { 課題: "#1", 次のコマンド: "/ndf:x" }));
    expect(got.items).toEqual({ 課題: "#1" });
  });

  it("同じ項目が 2 行あれば後ろの値を採る（材料・区分）", () => {
    const got = read(
      report("判断が要る", [
        ["区分", "ndf-ask:legal"],
        ["質問", "進めてよいか"],
        ["材料", "https://github.com/acme/app/issues/1"],
        ["材料", "https://github.com/acme/app/issues/2"],
        ["区分", "ndf-ask:cost"],
      ]),
    );
    expect(got.errors).toEqual([]);
    expect(got.items.材料).toBe("https://github.com/acme/app/issues/2");
    expect(got.items.区分).toBe("ndf-ask:cost");
    expect(got.material).toEqual({ kind: "urls", urls: ["https://github.com/acme/app/issues/2"] });
  });

  it("結果の行が 2 つあれば最後の行を採り、前の行より前の項目を読まない", () => {
    const got = read(`- 結果: 判断が要る\n- 理由: 前の理由\n\n${report("完了", { 課題: "#7" })}`);
    expect(got.result).toBe("完了");
    expect(got.items).toEqual({ 課題: "#7" });
  });

  it("完了とできなかったの 材料: 無し は誤りにしない", () => {
    expect(read(report("完了", { 材料: "無し" })).errors).toEqual([]);
    expect(read(report("できなかった", { 理由: "外部の系が止まっている", 材料: "無し" })).errors).toEqual([]);
    expect(read(report("完了", { 材料: "無し" })).material).toEqual({ kind: "none" });
  });

  describe("材料: 本文 の節", () => {
    const body = (before: string) => read(report("判断が要る", { ...GATE, 材料: "本文" }, before));

    it("見出しが 2 つあれば最後の見出しの節を返し、節は次の ## の見出しの前で終わる", () => {
      const got = body("## 判断の材料\n\n古い節。\n\n## 判断の材料\n\n新しい節。\n\n## 別の見出し\n\n外。\n\n");
      expect(got.errors).toEqual([]);
      expect(got.material).toEqual({ kind: "body", section: "\n新しい節。\n\n" });
    });

    it("節は # の見出しの前でも終わり、### の見出しでは終わらない", () => {
      const got = body("## 判断の材料\n\n節。\n\n### 小見出し\n\n中。\n\n# 別\n\n");
      expect(got.material).toEqual({ kind: "body", section: "\n節。\n\n### 小見出し\n\n中。\n\n" });
    });

    it.each([
      ["=== の Setext 見出し", "別の見出し\n==="],
      ["--- の Setext 見出し", "別の見出し\n---"],
    ])("節は次の %s の前で終わる", (_why, setext) => {
      const got = body(`## 判断の材料\n\n節。\n\n${setext}\n\n外。\n\n`);
      expect(got.material).toEqual({ kind: "body", section: "\n節。\n\n" });
    });

    it.each([
      ["``` のコードブロック", "```\n## 判断の材料\n\nhttps://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf\n```\n\n"],
      ["~~~~ のコードブロック", "~~~~\n## 判断の材料\n~~~~\n\n"],
      ["<div> で始まる HTML のブロック", "<div>\n## 判断の材料\nhttps://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf\n</div>\n\n"],
      ["リストの項目", "- 項目\n  ## 判断の材料\n\n"],
      ["引用", "> ## 判断の材料\n\n"],
    ])("%s の中の ## 判断の材料 を見出しとみなさない", (_why, inner) => {
      expect(body(inner).errors).toEqual([{ code: "material_heading_missing", item: "材料" }]);
      const got = body(`${inner}## 判断の材料\n\nhttps://github.com/acme/app/issues/3\n\n`);
      expect(got.errors).toEqual([]);
      expect(got.material).toEqual({ kind: "body", section: "\nhttps://github.com/acme/app/issues/3\n\n" });
    });

    it("閉じないフェンスのコードブロックは結果の行の前まで続き、その後ろの見出し風の行を見出しとみなさない", () => {
      expect(body("```\n\n## 判断の材料\n\n").errors).toEqual([{ code: "material_heading_missing", item: "材料" }]);
    });
  });

  describe("誤り", () => {
    it("結果の行が無ければ result は空で result_line_missing だけ", () => {
      expect(read("## 確認したいこと\n\n- 材料: 本文\n")).toEqual({
        result: "",
        errors: [{ code: "result_line_missing", item: "結果" }],
        items: {},
        material: { kind: "none" },
      });
    });

    it("結果が 3 つの値のどれでもなければ result_value_unknown だけで、項目を読まない", () => {
      expect(read(report("保留", { 理由: "無し" }))).toEqual({
        result: "保留",
        errors: [{ code: "result_value_unknown", item: "結果" }],
        items: {},
        material: { kind: "none" },
      });
    });

    it("判断が要るの 材料: 無し は item_missing", () => {
      expect(read(report("判断が要る", { ...GATE, 材料: "無し" })).errors).toEqual([{ code: "item_missing", item: "材料" }]);
    });

    it("区分が ndf-gate: で始まり承認ゲートが無いと item_missing", () => {
      const got = read(report("判断が要る", { ...GATE, 区分: "ndf-gate:1", 材料: "https://github.com/acme/app/issues/1" }));
      expect(got.errors).toEqual([{ code: "item_missing", item: "承認ゲート" }]);
      expect(got.material).toEqual({ kind: "none" });
    });

    it("要る項目は always の後に when の順で、同じ項目は 1 回だけ確かめる", () => {
      const got = read(report("判断が要る", { 区分: "ndf-gate:1", 承認ゲート: "設計 Pull Request のマージ" }));
      expect(got.errors).toEqual([
        { code: "item_missing", item: "質問" },
        { code: "item_missing", item: "材料" },
        { code: "item_missing", item: "Pull Request" },
      ]);
    });

    it("材料: 本文 で見出しが無いと material_heading_missing", () => {
      expect(read(report("判断が要る", { ...GATE, 材料: "本文" })).errors).toEqual([
        { code: "material_heading_missing", item: "材料" },
      ]);
    });

    it("材料が URL の並びでないと material_form_invalid の 1 件だけで、誤りの一覧に値を入れない", () => {
      const value = "https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000 not-a-url";
      const got = read(report("判断が要る", { ...GATE, 材料: value }));
      expect(got.errors).toEqual([{ code: "material_form_invalid", item: "材料" }]);
      const text = JSON.stringify(got.errors);
      for (const leak of ["X-Amz-Signature", "0000", "not-a-url"]) expect(text).not.toContain(leak);
      expect(got.material).toEqual({ kind: "none" });
    });

    it("https:// だけの値は URL とみなさない", () => {
      expect(read(report("判断が要る", { ...GATE, 材料: "https://" })).errors).toEqual([{ code: "material_form_invalid", item: "材料" }]);
    });

    it("例外を投げない", () => {
      for (const text of ["", "\n", "- 結果:", "- 結果: 判断が要る\n- 材料: 本文\n", "```\n- 結果: 完了"]) {
        expect(() => read(text)).not.toThrow();
      }
    });
  });
});

describe("ndfContractUse", () => {
  it("使うインタフェースの id の集合が、execution.md の表の 11 の id とちょうど同じ（網羅）", () => {
    expect([...ndfContractUse.entrypoints.map((row) => row.id)].sort()).toEqual([...USED_ENTRYPOINTS].sort());
    expect(ndfContractUse.entrypoints).toHaveLength(USED_ENTRYPOINTS.length);
  });

  it("受ける組は NDF_CONTRACTS.accepted そのもの（コピーしない）", () => {
    expect(ndfContractUse.acceptedVersions).toBe(NDF_CONTRACTS.accepted);
  });

  it("固定の点・前置き・読む項目・区間の報告の形を生成と手で書くデータから持つ", () => {
    expect(ndfContractUse.pinnedCommit).toBe(GENERATED.commit);
    expect(ndfContractUse.skillPrefix).toBe("ndf:");
    expect(ndfContractUse.reportItems).toBe(REPORT_ITEMS);
    expect(ndfContractUse.report).toEqual(GENERATED.report);
  });

  it("judgeCall と readReport は生成のデータで判定し、読む", () => {
    expect(ndfContractUse.judgeCall(caseById("resume"))).toBe(true);
    expect(ndfContractUse.judgeCall(caseById("loop-record"))).toBe(false);
    expect(ndfContractUse.readReport("- 結果: 完了\n").result).toBe("完了");
  });
});

describe("buildContractUse", () => {
  const clone = <T>(value: T): T => structuredClone(value);
  const build = (data: unknown = useData, generated: unknown = generatedData) => buildContractUse(data, generated, NDF_CONTRACTS.accepted);

  it("読むファイルの行は、生成の path に手で書く fields を id で付けたもの", () => {
    const use = build();
    expect(use.files).toContainEqual({ id: "plan-progress", path: "<sprint>/<n>-<plan>-state/progress.jsonl", fields: ["step", "attention"] });
    expect(use.files).toContainEqual({ id: "gate-rejections", path: "gate-rejections.jsonl", fields: [] });
    expect(use.files).toContainEqual({ id: "issue-request", path: ".", fields: ["repo", "title", "body", "labels"] });
  });

  it("手で書くデータの形が違うと DataFileError", () => {
    expect(() => build({ ...clone(useData), extra: 1 })).toThrow(DataFileError);
    expect(() => build({ ...clone(useData), skillPrefix: 1 })).toThrow(DataFileError);
  });

  it("生成のデータの形が違うと DataFileError", () => {
    expect(() => build(useData, { ...clone(generatedData), commit: "x" })).toThrow(DataFileError);
  });

  it("手で書く id と生成の行の id が一致しないと、片方にだけある id を並べた DataFileError", () => {
    const data = { ...clone(useData), entrypoints: [...useData.entrypoints.filter((id) => id !== "block-next"), "file-loop-record"] };
    const run = () => build(data);
    expect(run).toThrow(DataFileError);
    expect(run).toThrow(/block-next/);
    expect(run).toThrow(/file-loop-record/);
  });

  it("手で書く files の id が生成の files に無いと DataFileError", () => {
    const data = { ...clone(useData), files: [...useData.files, { id: "loop-record", fields: [] }] };
    expect(() => build(data)).toThrow(DataFileError);
  });

  it("env の entrypoint が使うインタフェースに無いと DataFileError", () => {
    const data = { ...clone(useData), env: [...useData.env, { entrypoint: "file-loop-record", site: "local", names: [] }] };
    expect(() => build(data)).toThrow(DataFileError);
  });
});
