import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import generatedData from "../data/ndf-contract-use.generated.json" with { type: "json" };
import { ndfContractUseGenerated, type NdfCall, type NdfEntrypointRow } from "../src/ndf-contract-use-schema.ts";
import { filePathPattern, judgeCallWith } from "../src/ndf-contract-use.ts";

/** 固定の点（8d22be7）の契約の写し。説明の文の列は写していない */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ndf-contract-8d22be7");
const readFixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

type Case = NdfCall & { id: string; valid: boolean };
const CASES = (readFixture("entrypoint-cases.json") as { rows: Case[] }).rows;

const GENERATED = ndfContractUseGenerated.parse(generatedData);
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
