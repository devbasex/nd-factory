import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DECLARATION = join(ROOT, ".ndf", "project.json");

/** ジョブの手順の解いた値のうち、このテストが読む鍵 */
export type Step = {
  name?: unknown;
  uses?: unknown;
  with?: Record<string, unknown> | null;
  run?: unknown;
  env?: Record<string, unknown> | null;
  if?: unknown;
  "continue-on-error"?: unknown;
};

/** ジョブの解いた値のうち、このテストが読む鍵 */
export type Job = {
  name?: unknown;
  permissions?: unknown;
  strategy?: { matrix?: unknown } | null;
  if?: unknown;
  environment?: unknown;
  needs?: unknown;
  uses?: unknown;
  with?: Record<string, unknown> | null;
  secrets?: unknown;
  steps?: Step[] | null;
  env?: Record<string, unknown> | null;
  "continue-on-error"?: unknown;
};

/** ワークフローの解いた値のうち、このテストが読む鍵 */
export type Workflow = {
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<string, Job | null>;
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

/**
 * ジョブが GitHub へ報告するチェックの名前を返す。`name` があればその値、無ければ `jobs` の鍵。
 * 行列のジョブは GitHub が名前に行列の値を足すため、宣言の名前と合わない印を付けて返す
 */
export function checkNames(doc: Workflow): string[] {
  return Object.entries(doc.jobs ?? {}).map(([id, job]) => {
    const name = typeof job?.name === "string" ? job.name : id;
    return job?.strategy?.matrix === undefined ? name : `${name} (行列の値つき)`;
  });
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

/**
 * Pull Request で起動するワークフローにあっても、必須のチェックに数えないジョブの鍵。
 * main への push だけで動き（ジョブの `if:`）、Pull Request のマージを決めない（#96 #101 の決定 3）
 */
const NOT_REQUIRED_JOBS = ["leak-check-push"];

/** Pull Request で起動するワークフローのジョブが報告するチェックの名前の和集合（`NOT_REQUIRED_JOBS` の鍵のジョブを除く） */
function pullRequestChecks(workflows: LoadedWorkflow[]): string[] {
  return workflows
    .filter((workflow) => triggersPullRequest(workflow.doc))
    .flatMap((workflow) => {
      const jobs = Object.fromEntries(
        Object.entries(workflow.doc.jobs ?? {}).filter(([id]) => !NOT_REQUIRED_JOBS.includes(id)),
      );
      return checkNames({ ...workflow.doc, jobs });
    });
}

/** gitleaks を置く手順の名前と、許す `run:`（版と要約値を持つ install-gitleaks.sh を 1 行で呼ぶだけ） */
const GITLEAKS_STEP = "gitleaks を固定の版と要約値で置く";
const GITLEAKS_RUN = 'tools/checks/install-gitleaks.sh "$RUNNER_TEMP/gitleaks"';

/** ジョブの手順の `run:` の文字列 */
function runsOf(job: Job | null | undefined): string[] {
  return (job?.steps ?? []).flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
}

/** ジョブと手順の `env` の名前 */
function envNamesOf(job: Job | null | undefined): string[] {
  const names = Object.keys(job?.env ?? {});
  for (const step of job?.steps ?? []) names.push(...Object.keys(step.env ?? {}));
  return names;
}

/**
 * gitleaks を置く手順が install-gitleaks.sh の 1 行でない、ジョブか手順の `env` に `GITLEAKS_` で始まる名前がある所を
 * `<場所>#<印>` で返す
 */
function gitleaksInstallViolations(scope: string, job: Job | null | undefined): string[] {
  const found: string[] = [];
  const steps = (job?.steps ?? []).filter((step) => step.name === GITLEAKS_STEP);
  if (steps.length !== 1 || typeof steps[0]?.run !== "string" || steps[0].run.trim() !== GITLEAKS_RUN) {
    found.push(`${scope}#gitleaks-install`);
  }
  if (envNamesOf(job).some((name) => name.startsWith("GITLEAKS_"))) found.push(`${scope}#gitleaks-env`);
  return found;
}

/**
 * `ci.yml` の `leak-check` と `leak-check-push` の分け方（#96 #101 の決定 3・9）を外れた所を返す。
 * `leak-check` は Pull Request だけで動き、環境と秘密と必須の変数を持たず、今の木と分岐点から head までを探す。
 * `leak-check-push` は main への push だけで動き、環境 `leak-scan` で秘密と必須の変数を受け、今の木と到達できるすべてのコミットを
 * 件数だけを出す指定で探す
 */
export function leakJobViolations(ci: LoadedWorkflow): string[] {
  const found: string[] = [];
  const pr = ci.doc.jobs?.["leak-check"];
  const push = ci.doc.jobs?.["leak-check-push"];
  found.push(...gitleaksInstallViolations("jobs.leak-check", pr), ...gitleaksInstallViolations("jobs.leak-check-push", push));

  if (pr?.if !== "github.event_name == 'pull_request'") found.push("jobs.leak-check#if");
  if (pr?.environment !== undefined) found.push("jobs.leak-check#environment");
  const prText = JSON.stringify(pr ?? {});
  if (prText.includes("secrets.")) found.push("jobs.leak-check#secrets");
  if (prText.includes("LEAK_CHECK_REQUIRE_PATTERN")) found.push("jobs.leak-check#require");
  const prRuns = runsOf(pr).join("\n");
  if (!/tools\/checks\/leak-scan\.sh dir /.test(prRuns)) found.push("jobs.leak-check#scan-dir");
  if (!/tools\/checks\/leak-scan\.sh git \S+ --range /.test(prRuns)) found.push("jobs.leak-check#scan-range");

  if (push?.if !== "github.event_name == 'push'") found.push("jobs.leak-check-push#if");
  if (push?.environment !== "leak-scan") found.push("jobs.leak-check-push#environment");
  const pushRuns = runsOf(push).join("\n");
  if (!pushRuns.includes("tools/checks/leak-scan-secret.sh dir --count-only")) found.push("jobs.leak-check-push#scan-dir");
  if (!pushRuns.includes("tools/checks/leak-scan-secret.sh git --count-only")) found.push("jobs.leak-check-push#scan-git");
  if (pushRuns.includes("--range")) found.push("jobs.leak-check-push#range");
  if (!envNamesOf(push).includes("LEAK_CHECK_REQUIRE_PATTERN")) found.push("jobs.leak-check-push#require");
  return found;
}

/** 起動した人で分ける条件の語。漏れの検査のワークフローと見本は持たない（#96 #101 の決定 2） */
const ACTOR_WORDS = ["github.actor", "github.triggering_actor", "dependabot"];

/** ワークフローの文字列に、起動した人で分ける条件の語がある所を `<パス>#<語>` で返す */
export function actorConditions(workflows: LoadedWorkflow[]): string[] {
  return workflows.flatMap((workflow) =>
    ACTOR_WORDS.filter((word) => workflow.text.includes(word)).map((word) => `${workflow.path}#${word}`),
  );
}

/** `secrets.LEAK_CHECK_PATTERN` を読むジョブを `<パス>#jobs.<鍵>` の形で返す */
export function patternSecretReaders(workflows: LoadedWorkflow[]): string[] {
  return workflows.flatMap((workflow) =>
    Object.entries(workflow.doc.jobs ?? {})
      .filter(([, job]) => JSON.stringify(job ?? {}).includes("secrets.LEAK_CHECK_PATTERN"))
      .map(([id]) => `${workflow.path}#jobs.${id}`),
  );
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
    expect(pullRequestChecks(workflows)).toEqual(["check"]);
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

  it("報告するチェックの名前は、name があればその値、無ければ jobs の鍵", () => {
    expect(checkNames(docOf(CHECK_WORKFLOW))).toEqual(["check"]);
    const renamed = CHECK_WORKFLOW.replace("  check:\n", "  check:\n    name: CDK synth\n");
    expect(jobNames(docOf(renamed))).toEqual(["check"]);
    expect(checkNames(docOf(renamed))).toEqual(["CDK synth"]);
  });

  it("鍵と同じ name は鍵のまま報告する", () => {
    const same = CHECK_WORKFLOW.replace("  check:\n", "  check:\n    name: check\n");
    expect(checkNames(docOf(same))).toEqual(["check"]);
  });

  it("行列のジョブは宣言の名前と合わない名前で報告する", () => {
    const matrix = CHECK_WORKFLOW.replace("    runs-on:", "    strategy:\n      matrix:\n        node: [22, 24]\n    runs-on:");
    expect(checkNames(docOf(matrix))).not.toContain("check");
  });

  it("name を上書きしたジョブは、鍵が必須のチェックの宣言と同じでも、宣言と合わない", () => {
    const renamed = CHECK_WORKFLOW.replace("  check:\n", "  check:\n    name: CDK synth\n");
    const root = makeTree({ "ci.yml": renamed });
    expect(new Set(pullRequestChecks(loadWorkflows(root)))).not.toEqual(new Set(["check"]));
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

const CI_PATH = join(".github", "workflows", "ci.yml");

/** 実際の `ci.yml` の文字列を置き換えた作り物を読む。置き換える元が無ければ失敗する */
function ciWith(...replacements: [string | RegExp, string][]): LoadedWorkflow {
  let text = readFileSync(join(ROOT, CI_PATH), "utf8");
  for (const [from, to] of replacements) {
    const next = text.replace(from, to);
    if (next === text) throw new Error(`置き換える元が ci.yml に無い: ${String(from)}`);
    text = next;
  }
  return { path: CI_PATH, text, doc: docOf(text) };
}

describe("leakJobViolations・patternSecretReaders・actorConditions", () => {
  it.each<[string, [string | RegExp, string][], string[]]>([
    [
      "leak-check に GITLEAKS_SHA256 を戻す",
      [["    if: github.event_name == 'pull_request'\n", "    if: github.event_name == 'pull_request'\n    env:\n      GITLEAKS_SHA256: x\n"]],
      ["jobs.leak-check#gitleaks-env"],
    ],
    [
      "leak-check-push に GITLEAKS_VERSION を戻す",
      [["    environment: leak-scan\n", "    environment: leak-scan\n    env:\n      GITLEAKS_VERSION: 8.30.1\n"]],
      ["jobs.leak-check-push#gitleaks-env"],
    ],
    [
      "leak-check の gitleaks を置く手順に curl を直に書く",
      [[/( {2}leak-check:[\s\S]*?run: )tools\/checks\/install-gitleaks\.sh "\$RUNNER_TEMP\/gitleaks"/, "$1curl -fsSL -o g.tar.gz https://example.com/g.tar.gz"]],
      ["jobs.leak-check#gitleaks-install"],
    ],
    [
      "leak-check に秘密を戻す",
      [["          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n", "          LEAK_CHECK_PATTERN: ${{ secrets.LEAK_CHECK_PATTERN }}\n          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n"]],
      ["jobs.leak-check#secrets"],
    ],
    [
      "leak-check に環境を戻す",
      [["    if: github.event_name == 'pull_request'\n", "    if: github.event_name == 'pull_request'\n    environment: leak-scan\n"]],
      ["jobs.leak-check#environment"],
    ],
    [
      "leak-check を push でも動かす",
      [["    if: github.event_name == 'pull_request'\n", ""]],
      ["jobs.leak-check#if"],
    ],
    [
      "leak-check-push から環境を外す",
      [["    environment: leak-scan\n", ""]],
      ["jobs.leak-check-push#environment"],
    ],
    [
      "leak-check-push から dir の呼び出しを外す",
      [["tools/checks/leak-scan-secret.sh dir --count-only", "true"]],
      ["jobs.leak-check-push#scan-dir"],
    ],
    [
      "leak-check-push に --range を渡す",
      [["tools/checks/leak-scan-secret.sh git --count-only", 'tools/checks/leak-scan-secret.sh git --count-only --range "$BEFORE..HEAD"']],
      ["jobs.leak-check-push#range"],
    ],
    [
      "leak-check-push が必須の変数を受けない",
      [[/ {10}LEAK_CHECK_REQUIRE_PATTERN: .*\n/, ""]],
      ["jobs.leak-check-push#require"],
    ],
  ])("%s と当たる", (_label, replacements, expected) => {
    expect(leakJobViolations(ciWith(...replacements))).toEqual(expected);
  });

  it("leak-check で秘密を読むと、秘密を読むジョブに leak-check が加わる", () => {
    const ci = ciWith([
      "          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n",
      "          LEAK_CHECK_PATTERN: ${{ secrets.LEAK_CHECK_PATTERN }}\n          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n",
    ]);
    const others = loadWorkflows(ROOT).filter((workflow) => workflow.path !== CI_PATH);
    expect(patternSecretReaders([ci, ...others]).sort()).toEqual(
      [`${CI_PATH}#jobs.leak-check`, `${CI_PATH}#jobs.leak-check-push`, ...patternSecretReaders(others)].sort(),
    );
  });

  it("起動した人で分ける条件を足すと当たる", () => {
    const ci = ciWith(["    if: github.event_name == 'pull_request'\n", "    if: github.event_name == 'pull_request' && github.actor != 'dependabot[bot]'\n"]);
    expect(actorConditions([ci])).toEqual([`${CI_PATH}#github.actor`, `${CI_PATH}#dependabot`]);
  });

  it("Pull Request で起動するワークフローの leak-check-push は必須のチェックに数えず、ほかの Pull Request のジョブは数える", () => {
    const root = makeTree({
      "ci.yml": CHECK_WORKFLOW.replace(
        "      - run: npm run check\n",
        "      - run: npm run check\n  leak-check-push:\n    if: github.event_name == 'push'\n    runs-on: ubuntu-24.04\n    steps:\n      - run: x\n  extra:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: x\n",
      ),
    });
    expect(pullRequestChecks(loadWorkflows(root))).toEqual(["check", "extra"]);
  });
});

describe("CI の定義", () => {
  const workflows = loadWorkflows(ROOT);
  const ci = workflows.find((workflow) => workflow.path === CI_PATH);

  it("ワークフローを 1 つ以上読む", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it("Pull Request で起動するジョブが報告するチェックの名前の集合が NDF の宣言の必須のチェックと等しい", () => {
    const declared = JSON.parse(readFileSync(DECLARATION, "utf8")) as { ci: { required_checks: string[] } };
    const checks = pullRequestChecks(workflows);
    expect(new Set(checks)).toEqual(new Set(declared.ci.required_checks));
    expect(checks).toHaveLength(declared.ci.required_checks.length);
  });

  it("ジョブの名前がワークフローの間で重ならない", () => {
    expect(duplicatedJobs(workflows)).toEqual([]);
  });

  it("どのワークフローにも AWS の資格情報の語が無い", () => {
    const found = workflows.filter((workflow) => credentialWords(workflow.text).length > 0);
    expect(found.map((workflow) => workflow.path)).toEqual([]);
  });

  it("leak-check は Pull Request だけで秘密を受けずに探し、leak-check-push は main への push で環境 leak-scan の秘密を受けて探す", () => {
    if (!ci) throw new Error("ci.yml を読めない");
    expect(leakJobViolations(ci)).toEqual([]);
  });

  it("秘密 LEAK_CHECK_PATTERN を読むジョブは leak-check-push だけ", () => {
    expect(patternSecretReaders(workflows)).toEqual([`${CI_PATH}#jobs.leak-check-push`]);
  });

  it("起動した人で分ける条件の語が無い", () => {
    expect(actorConditions(workflows)).toEqual([]);
  });

  it("最上位の permissions が { contents: read } だけで、ジョブの permissions は持たないか同じ", () => {
    const found = workflows.flatMap((workflow) =>
      permissionViolations(workflow.doc).map((scope) => `${workflow.path}#${scope}`),
    );
    expect(found).toEqual([]);
  });
});
