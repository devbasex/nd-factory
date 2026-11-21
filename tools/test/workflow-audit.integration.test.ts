import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// zizmor の設定（.github/zizmor.yml）と ci.yml の workflow-audit のジョブの点検が、広すぎる権限・資格情報を残す取得・
// SHA で固定していない動作の参照を落とすことを確かめる（#1 の決定 5、受け入れ条件 1・13）。
// zizmor の実行ファイルを PATH から起こす。workflow-audit のジョブが固定の版を置いてから打つ
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI = join(ROOT, ".github", "workflows", "ci.yml");
const AUDIT_STEP = "ワークフローの点検";
const TIMEOUT = 60_000;

type Step = { name?: unknown; run?: unknown };
type CiWorkflow = { jobs?: Record<string, { steps?: Step[] } | null> };

/** ci.yml の workflow-audit のジョブの点検の手順の run（ジョブと同じ引数で打つ） */
function auditCommand(): string {
  const doc = parse(readFileSync(CI, "utf8")) as CiWorkflow;
  const step = doc.jobs?.["workflow-audit"]?.steps?.find((s) => s.name === AUDIT_STEP);
  if (typeof step?.run !== "string") throw new Error(`ci.yml の workflow-audit に「${AUDIT_STEP}」の run が無い`);
  return step.run;
}

// 作り物の正しいワークフロー。ci.yml の外の 2 つ目のファイルに置き、1 か所ずつ壊す
const EXTRA = [
  "name: extra",
  "on: pull_request",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  first:",
  "    runs-on: ubuntu-24.04",
  "    steps:",
  "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          persist-credentials: false",
  "      - run: echo first",
  "  second:",
  "    runs-on: ubuntu-24.04",
  "    steps:",
  "      - run: echo second",
  "",
].join("\n");

const trees: string[] = [];

afterEach(() => {
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
});

beforeAll(() => {
  const version = spawnSync("zizmor", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error("zizmor が PATH に無い。workflow-audit のジョブと同じ固定の版を置いて打つ");
});

/** 今のワークフローと zizmor の設定を写し、足すワークフローを置いた一時の木で、ジョブの点検を打つ */
function audit(extra: string | null): { status: number | null; output: string } {
  const tree = mkdtempSync(join(tmpdir(), "workflow-audit-"));
  trees.push(tree);
  mkdirSync(join(tree, ".github"), { recursive: true });
  cpSync(join(ROOT, ".github", "workflows"), join(tree, ".github", "workflows"), { recursive: true });
  cpSync(join(ROOT, ".github", "zizmor.yml"), join(tree, ".github", "zizmor.yml"));
  if (extra !== null) writeFileSync(join(tree, ".github", "workflows", "extra.yml"), extra);
  const env = { ...process.env };
  // ネットワークの点検を起こさないことを、token を渡さないことでも保つ
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "ZIZMOR_GITHUB_TOKEN", "ZIZMOR_CONFIG"]) delete env[name];
  const result = spawnSync("bash", ["-c", auditCommand()], { cwd: tree, encoding: "utf8", env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("workflow-audit の点検", () => {
  it.each([
    ["今のワークフローだけ", null],
    ["今のワークフローと作り物の正しいワークフロー", EXTRA],
  ])("%s を写した木で当たり 0 件", (_label, extra) => {
    const result = audit(extra);
    expect(result.output).toContain("No findings to report");
    expect(result.status).toBe(0);
  }, TIMEOUT);

  it.each([
    ["ワークフロー全体に書き込みの権限（2 つのジョブ）", EXTRA.replace("  contents: read\n", "  contents: write\n"), "excessive-permissions"],
    ["ジョブに write-all", EXTRA.replace("  second:\n", "  second:\n    permissions: write-all\n"), "excessive-permissions"],
    ["persist-credentials: false を外した取得", EXTRA.replace("        with:\n          persist-credentials: false\n", ""), "artipacked"],
    [
      "枝の名前で参照した動作",
      EXTRA.replace("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1", "actions/checkout@main"),
      "unpinned-uses",
    ],
    [
      "行の中の zizmor: ignore で外そうとした、枝の名前で参照した動作（--no-ignores で効かない）",
      EXTRA.replace(
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
        "actions/checkout@main # zizmor: ignore[unpinned-uses]",
      ),
      "unpinned-uses",
    ],
  ])("ci.yml の外のワークフローの %s で当たる", (_label, extra, audit_id) => {
    expect(extra).not.toBe(EXTRA);
    const result = audit(extra);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(`[${audit_id}]`);
    expect(result.output).toContain("extra.yml");
  }, TIMEOUT);
});
