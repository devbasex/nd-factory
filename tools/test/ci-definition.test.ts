import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DECLARATION = join(ROOT, ".ndf", "project.json");

/** ワークフローの解いた値のうち、このテストが読む鍵 */
export type Workflow = {
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<string, { permissions?: unknown } | null>;
};

export type LoadedWorkflow = { path: string; text: string; doc: Workflow };

/** `.github/workflows/` の `*.yml`・`*.yaml` を読み、解いた値と元の文字列を返す。解けなければ例外 */
export function loadWorkflows(root: string): LoadedWorkflow[] {
  const dir = join(root, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => {
      const path = join(".github", "workflows", name);
      const text = readFileSync(join(root, path), "utf8");
      // yaml は YAML 1.2 で読むので、鍵 `on` は真偽値にならない。書き誤りと重なった鍵は parse が例外にする
      const doc: unknown = parse(text);
      if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
        throw new Error(`ワークフローが鍵と値の組でない: ${path}`);
      }
      return { path, text, doc: doc as Workflow };
    });
}

/** `jobs` の鍵の名前を返す */
export function jobNames(doc: Workflow): string[] {
  return doc.jobs ? Object.keys(doc.jobs) : [];
}

/** `on` が `pull_request` を持つか（文字列・配列・鍵の 3 つの書き方） */
export function triggersPullRequest(doc: Workflow): boolean {
  const on = doc.on;
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  if (on !== null && typeof on === "object") return Object.hasOwn(on, "pull_request");
  return false;
}

/** 最上位と各ジョブの `permissions` を、場所と値の組で返す */
export function permissionBlocks(doc: Workflow): { scope: string; value: unknown }[] {
  const blocks: { scope: string; value: unknown }[] = [];
  if (doc.permissions !== undefined) blocks.push({ scope: "workflow", value: doc.permissions });
  for (const [name, job] of Object.entries(doc.jobs ?? {})) {
    if (job?.permissions !== undefined) blocks.push({ scope: `jobs.${name}`, value: job.permissions });
  }
  return blocks;
}

/** AWS の資格情報を CI へ渡す書き方。1 つでもあれば CI が資格情報を持つ */
export const CREDENTIAL_WORDS = [
  "configure-aws-credentials",
  "role-to-assume",
  "id-token: write",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "aws-access-key-id",
  "aws-secret-access-key",
  "AWS_PROFILE",
];

export function credentialWords(yaml: string): string[] {
  return CREDENTIAL_WORDS.filter((word) => yaml.includes(word));
}

const READ_ONLY = { contents: "read" };

/** `permissions` が `{ contents: read }` だけでない場所。最上位は持たないことも当たる */
function permissionViolations(doc: Workflow): string[] {
  const blocks = permissionBlocks(doc);
  const wrong = blocks.filter((block) => !isReadOnly(block.value)).map((block) => block.scope);
  return blocks.some((block) => block.scope === "workflow") ? wrong : ["workflow", ...wrong];
}

function isReadOnly(value: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(READ_ONLY);
}

/** Pull Request で起動するワークフローのジョブの名前の和集合 */
function pullRequestJobs(workflows: LoadedWorkflow[]): string[] {
  return workflows
    .filter((workflow) => triggersPullRequest(workflow.doc))
    .flatMap((workflow) => jobNames(workflow.doc));
}

/** ワークフローの間で重なるジョブの名前 */
function duplicatedJobs(workflows: LoadedWorkflow[]): string[] {
  const names = workflows.flatMap((workflow) => jobNames(workflow.doc));
  return [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
}

// 作り物のワークフロー。テストの中で組み、一時の木に置く
const CHECK_WORKFLOW = [
  "name: ci",
  "on:",
  "  push:",
  "    branches: [main]",
  "  pull_request:",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  check:",
  "    runs-on: ubuntu-24.04",
  "    steps:",
  "      - run: npm run check",
  "",
].join("\n");

const NIGHTLY_WORKFLOW = [
  "name: nightly",
  "on:",
  "  schedule:",
  "    - cron: '0 0 * * *'",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  nightly:",
  "    runs-on: ubuntu-24.04",
  "    steps:",
  "      - run: npm run check",
  "",
].join("\n");

const roots: string[] = [];

/** 渡したワークフローを `.github/workflows/` に置いた一時の木を作る */
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-definition-"));
  roots.push(root);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, ".github", "workflows", name), body);
  return root;
}

function docOf(text: string): Workflow {
  const root = makeTree({ "w.yml": text });
  const [workflow] = loadWorkflows(root);
  if (!workflow) throw new Error("ワークフローを読めない");
  return workflow.doc;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadWorkflows・triggersPullRequest・jobNames", () => {
  it("2 つのワークフローを読み、Pull Request で起動するものを選ぶ", () => {
    const root = makeTree({ "ci.yml": CHECK_WORKFLOW, "nightly.yaml": NIGHTLY_WORKFLOW, "README.md": "x\n" });
    const workflows = loadWorkflows(root);
    expect(workflows.map((workflow) => workflow.path)).toEqual([
      join(".github", "workflows", "ci.yml"),
      join(".github", "workflows", "nightly.yaml"),
    ]);
    expect(workflows.map((workflow) => triggersPullRequest(workflow.doc))).toEqual([true, false]);
    expect(pullRequestJobs(workflows)).toEqual(["check"]);
    expect(workflows[0]?.text).toBe(CHECK_WORKFLOW);
  });

  it("鍵 on は真偽値でなく文字列の鍵で取れる", () => {
    const doc = docOf(CHECK_WORKFLOW);
    expect(Object.keys(doc)).toContain("on");
    expect(Object.keys(doc)).not.toContain("true");
  });

  it.each([
    ["on: pull_request", "on: pull_request\n"],
    ["on: [pull_request]", "on: [push, pull_request]\n"],
    ["on: の下の鍵", "on:\n  pull_request:\n    branches: [main]\n"],
  ])("%s の書き方で Pull Request の起動と読む", (_label, on) => {
    expect(triggersPullRequest(docOf(`${on}jobs:\n  a:\n    runs-on: ubuntu-24.04\n`))).toBe(true);
  });

  it.each([
    ["文字列", "on: push\n"],
    ["配列", "on: [push]\n"],
    ["鍵", "on:\n  pull_request_target:\n"],
  ])("pull_request を持たない %s は起動と読まない", (_label, on) => {
    expect(triggersPullRequest(docOf(`${on}jobs:\n  a:\n    runs-on: ubuntu-24.04\n`))).toBe(false);
  });

  it("jobs の鍵の名前を返し、jobs が無ければ空", () => {
    expect(jobNames(docOf(CHECK_WORKFLOW))).toEqual(["check"]);
    expect(jobNames(docOf("on: push\n"))).toEqual([]);
  });

  it("解けない YAML で失敗する", () => {
    const root = makeTree({ "ci.yml": CHECK_WORKFLOW, "broken.yml": "on: [pull_request\njobs:\n" });
    expect(() => loadWorkflows(root)).toThrow();
  });

  it("鍵と値の組でないワークフローで失敗する", () => {
    const root = makeTree({ "list.yml": "- a\n- b\n" });
    expect(() => loadWorkflows(root)).toThrow("鍵と値の組でない");
  });

  it("2 つ目のワークフローにだけ資格情報の語を足すと、そのワークフローで当たる", () => {
    const added = `${NIGHTLY_WORKFLOW}      - uses: aws-actions/configure-aws-credentials@v4\n`;
    const root = makeTree({ "ci.yml": CHECK_WORKFLOW, "nightly.yml": added });
    const hits = loadWorkflows(root).map((workflow) => [workflow.path, credentialWords(workflow.text)]);
    expect(hits).toEqual([
      [join(".github", "workflows", "ci.yml"), []],
      [join(".github", "workflows", "nightly.yml"), ["configure-aws-credentials"]],
    ]);
  });

  it("2 つ目のワークフローにだけ id-token: write を足すと、語と権限の両方で当たる", () => {
    const added = NIGHTLY_WORKFLOW.replace("  contents: read\n", "  contents: read\n  id-token: write\n");
    const root = makeTree({ "ci.yml": CHECK_WORKFLOW, "nightly.yml": added });
    const [first, second] = loadWorkflows(root);
    if (!first || !second) throw new Error("ワークフローを 2 つ読めない");
    expect(credentialWords(first.text)).toEqual([]);
    expect(credentialWords(second.text)).toEqual(["id-token: write"]);
    expect(permissionViolations(second.doc)).toEqual(["workflow"]);
  });

  it("ジョブの名前がワークフローの間で重なると当たる", () => {
    const other = CHECK_WORKFLOW.replace("name: ci", "name: other");
    const root = makeTree({ "ci.yml": CHECK_WORKFLOW, "other.yml": other });
    expect(duplicatedJobs(loadWorkflows(root))).toEqual(["check"]);
  });
});

describe("permissionBlocks", () => {
  it("最上位とジョブの permissions を場所と値の組で返す", () => {
    const text = CHECK_WORKFLOW.replace("    runs-on:", "    permissions:\n      contents: read\n    runs-on:");
    expect(permissionBlocks(docOf(text))).toEqual([
      { scope: "workflow", value: { contents: "read" } },
      { scope: "jobs.check", value: { contents: "read" } },
    ]);
  });

  it("ジョブの permissions: { contents: read } は通る", () => {
    const text = CHECK_WORKFLOW.replace("    runs-on:", "    permissions: { contents: read }\n    runs-on:");
    expect(permissionViolations(docOf(text))).toEqual([]);
  });

  it("ジョブに pull-requests: write を足すと場所つきで当たる", () => {
    const text = CHECK_WORKFLOW.replace(
      "    runs-on:",
      "    permissions:\n      contents: read\n      pull-requests: write\n    runs-on:",
    );
    expect(permissionViolations(docOf(text))).toEqual(["jobs.check"]);
  });

  it("ジョブに write-all を足すと場所つきで当たる", () => {
    const text = CHECK_WORKFLOW.replace("    runs-on:", "    permissions: write-all\n    runs-on:");
    expect(permissionViolations(docOf(text))).toEqual(["jobs.check"]);
  });

  it("最上位の permissions が無いと当たる", () => {
    expect(permissionViolations(docOf(CHECK_WORKFLOW.replace("permissions:\n  contents: read\n", "")))).toEqual([
      "workflow",
    ]);
  });
});

describe("CI の定義", () => {
  const workflows = loadWorkflows(ROOT);

  it("ワークフローを 1 つ以上読む", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it("Pull Request で起動するジョブの名前の集合が NDF の宣言の必須のチェックと等しい", () => {
    const declared = JSON.parse(readFileSync(DECLARATION, "utf8")) as { ci: { required_checks: string[] } };
    const jobs = pullRequestJobs(workflows);
    expect(new Set(jobs)).toEqual(new Set(declared.ci.required_checks));
    expect(jobs).toHaveLength(declared.ci.required_checks.length);
  });

  it("ジョブの名前がワークフローの間で重ならない", () => {
    expect(duplicatedJobs(workflows)).toEqual([]);
  });

  it("どのワークフローにも AWS の資格情報の語が無い", () => {
    const found = workflows.filter((workflow) => credentialWords(workflow.text).length > 0);
    expect(found.map((workflow) => workflow.path)).toEqual([]);
  });

  it("最上位の permissions が { contents: read } だけで、ジョブの permissions は持たないか同じ", () => {
    const found = workflows.flatMap((workflow) =>
      permissionViolations(workflow.doc).map((scope) => `${workflow.path}#${scope}`),
    );
    expect(found).toEqual([]);
  });
});
