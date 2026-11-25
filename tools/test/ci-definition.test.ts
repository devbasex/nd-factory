import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** 木の根からの相対の `path` の YAML を読み、解いた値と元の文字列を返す。解けないか鍵と値の組でなければ例外 */
export function loadWorkflowFile(root: string, path: string): LoadedWorkflow {
  const text = readFileSync(join(root, path), "utf8");
  // yaml は YAML 1.2 で読むので、鍵 `on` は真偽値にならない。書き誤りと重なった鍵は parse が例外にする
  const doc: unknown = parse(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`ワークフローが鍵と値の組でない: ${path}`);
  }
  return { path, text, doc: doc as Workflow };
}

/** `.github/workflows/` の `*.yml`・`*.yaml` を読み、解いた値と元の文字列を返す。解けなければ例外 */
export function loadWorkflows(root: string): LoadedWorkflow[] {
  const dir = join(root, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => loadWorkflowFile(root, join(".github", "workflows", name)));
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

/** `on` の起動の名前（文字列・配列・鍵の 3 つの書き方）。`on` が無ければ空 */
export function triggerNames(doc: Workflow): string[] {
  const on = doc.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((name): name is string => typeof name === "string");
  if (on !== null && typeof on === "object") return Object.keys(on);
  return [];
}

/** `on` が `pull_request` を持つか（文字列・配列・鍵の 3 つの書き方） */
export function triggersPullRequest(doc: Workflow): boolean {
  return triggerNames(doc).includes("pull_request");
}

/** 秘密を受ける再利用できるワークフローと、検査用の非公開リポジトリへ写す呼び出しのワークフローの見本のパス */
const SECRET_WORKFLOW_PATH = join(".github", "workflows", "leak-check-secret.yml");
export const CALLER_PATH = join("docs", "operations", "leak-check-caller.yml");

/**
 * ワークフローごとに許す起動（#96 #101 の決定 4）。禁止の起動ではなく許す起動を挙げ、点検していない起動
 * （`pull_request_target`・`workflow_run`・`issue_comment` など）を足すと落とす
 */
const ALLOWED_TRIGGERS: { secret: string[]; caller: string[]; others: string[] } = {
  secret: ["workflow_call"],
  caller: ["workflow_dispatch"],
  others: ["push", "pull_request", "schedule", "workflow_dispatch"],
};

/** 許す起動に無い起動を `<パス>#on.<起動>` の形で返す */
export function triggerViolations(workflows: LoadedWorkflow[], caller: LoadedWorkflow): string[] {
  const allowedFor = (workflow: LoadedWorkflow) => {
    if (workflow === caller) return ALLOWED_TRIGGERS.caller;
    if (workflow.path === SECRET_WORKFLOW_PATH) return ALLOWED_TRIGGERS.secret;
    return ALLOWED_TRIGGERS.others;
  };
  return [...workflows, caller].flatMap((workflow) =>
    triggerNames(workflow.doc)
      .filter((name) => !allowedFor(workflow).includes(name))
      .map((name) => `${workflow.path}#on.${name}`),
  );
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

/** 手順のうち gitleaks を置く手順がちょうど 1 件で、その `run:` が前後の空白を除いて install-gitleaks.sh の 1 行に一致するか */
function isGitleaksInstalledOnce(steps: Step[]): boolean {
  const installs = steps.filter((step) => step.name === GITLEAKS_STEP);
  return installs.length === 1 && typeof installs[0]?.run === "string" && installs[0].run.trim() === GITLEAKS_RUN;
}

/**
 * gitleaks を置く手順が install-gitleaks.sh の 1 行でない、ジョブか手順の `env` に `GITLEAKS_` で始まる名前がある所を
 * `<場所>#<印>` で返す
 */
function gitleaksInstallViolations(scope: string, job: Job | null | undefined): string[] {
  const found: string[] = [];
  if (!isGitleaksInstalledOnce(job?.steps ?? [])) found.push(`${scope}#gitleaks-install`);
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
  if (`${prRuns}\n${pushRuns}`.includes("--details") || `${prRuns}\n${pushRuns}`.includes("--paths")) found.push("jobs#details");
  if (!envNamesOf(push).includes("LEAK_CHECK_REQUIRE_PATTERN")) found.push("jobs.leak-check-push#require");
  return found;
}

/** 秘密を受けるワークフローの `run:` で動かしてよいコマンド（各コマンドの最初の語） */
const SECRET_WORKFLOW_COMMANDS = [
  "git",
  "tools/checks/install-gitleaks.sh",
  "tools/checks/export-tree.sh",
  "tools/checks/leak-scan-secret.sh",
  "echo",
  "exit",
  "[[",
];

/** 秘密を受けるワークフローの `run:` に置かない語 */
const SECRET_WORKFLOW_FORBIDDEN_WORDS = ["git archive", "tar ", "--details", "setup-node", "npm", "npx"];

/** コマンドの最初の語として読み飛ばす語 */
const SHELL_KEYWORDS = ["if", "then", "else", "fi", "!"];

/**
 * `run:` の文字列を行と `;`・`&&`・`||`・`|`・`$(` で区切り、各コマンドの最初の語を返す。
 * 変数の代入と `if`・`then`・`else`・`fi`・`!` は読み飛ばし、`#` で始まる行は読まない。
 * 決まった形の `run:` だけを読む簡単な区切りで、シェルの構文を解かない（ヒアドキュメントと関数の定義は呼ぶ側が落とす）
 */
export function runCommandWords(run: string): string[] {
  return run
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .flatMap((line) => line.split(/&&|\|\||\||;|\$\(/))
    .flatMap((segment) => {
      const words = segment.trim().split(/\s+/).filter((word) => word !== "");
      const first = words.find((word) => !SHELL_KEYWORDS.includes(word) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
      return first === undefined ? [] : [first];
    });
}

/** 秘密を受ける手順の名前 */
const SECRET_STEP = "秘密の規則を重ねて探す";

/** ジョブの表示名に入れる 6 つの入力 */
const SCAN_INPUTS = ["pr_number", "head_sha", "base_sha", "merge_sha", "code_sha", "generation"];

/**
 * `leak-check-secret.yml` が設計の決定 4 の形を外れた所を、印（`<パス>#<印>`）で返す。
 * 印は箇条ごとに 1 つで、1 つの箇条だけを壊せば、その印だけが出る
 */
export function secretWorkflowViolations(workflow: LoadedWorkflow, _ci: LoadedWorkflow): string[] {
  const marks = new Set<string>();
  const doc = workflow.doc;
  const jobs = Object.entries(doc.jobs ?? {});
  const steps = jobs.flatMap(([, job]) => job?.steps ?? []);
  const runs = steps.filter((step) => step.name !== GITLEAKS_STEP).flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
  const allRuns = steps.flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
  const runText = runs.join("\n");

  if (JSON.stringify(triggerNames(doc)) !== JSON.stringify(ALLOWED_TRIGGERS.secret)) marks.add("on");

  if (jobs.some(([, job]) => job?.uses !== undefined)) marks.add("uses");
  for (const step of steps) {
    if (step.uses === undefined) continue;
    if (typeof step.uses !== "string" || !/^actions\/checkout@[0-9a-f]{40}$/.test(step.uses)) {
      marks.add("uses");
      continue;
    }
    const options = step.with ?? {};
    if (
      options.repository !== "devbasex/nd-factory" ||
      options.ref !== "${{ inputs.code_sha }}" ||
      options["persist-credentials"] !== false ||
      Object.hasOwn(options, "allow-unsafe-pr-checkout")
    ) {
      marks.add("checkout");
    }
  }
  if (!steps.some((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"))) marks.add("checkout");

  const words = runs.flatMap((run) => runCommandWords(run));
  if (
    words.some((word) => !SECRET_WORKFLOW_COMMANDS.includes(word)) ||
    SECRET_WORKFLOW_FORBIDDEN_WORDS.some((word) => runText.includes(word)) ||
    runText.includes("<<") ||
    /\w+\s*\(\)\s*\{/.test(runText)
  ) {
    marks.add("run");
  }

  if (!isGitleaksInstalledOnce(steps)) marks.add("gitleaks-install");
  if (
    jobs.some(([, job]) => envNamesOf(job).some((name) => name.startsWith("GITLEAKS_"))) ||
    workflow.text.includes("github.com/gitleaks/gitleaks/releases")
  ) {
    marks.add("gitleaks-env");
  }

  if (allRuns.some((run) => /GITHUB_ENV|GITHUB_OUTPUT|GITHUB_PATH/.test(run))) marks.add("github-files");
  if (allRuns.some((run) => run.includes("${{ inputs."))) marks.add("run-inputs");

  const conditional = (item: Job | Step | null | undefined) => item?.if !== undefined || item?.["continue-on-error"] !== undefined;
  if (jobs.some(([, job]) => conditional(job)) || steps.some((step) => conditional(step))) marks.add("conditions");

  if (!isReadOnly(doc.permissions) || jobs.some(([, job]) => job?.permissions !== undefined)) marks.add("permissions");

  const readsSecret = (env: Record<string, unknown> | null | undefined) => JSON.stringify(env ?? {}).includes("secrets.LEAK_CHECK_PATTERN");
  if (
    jobs.some(([, job]) => readsSecret(job?.env)) ||
    steps.some((step) => step.name !== SECRET_STEP && readsSecret(step.env)) ||
    !steps.some((step) => step.name === SECRET_STEP && readsSecret(step.env))
  ) {
    marks.add("secret-steps");
  }
  // 必須の指定は変数で決めず、常に 1 にする（秘密が空なら Pull Request の出所によらず落とす）
  const scanSteps = steps.filter((step) => step.name === SECRET_STEP);
  if (scanSteps.length !== 1 || scanSteps[0]?.env?.LEAK_CHECK_REQUIRE_PATTERN !== "1") marks.add("require");

  const names = jobs.map(([, job]) => (typeof job?.name === "string" ? job.name : ""));
  if (names.length !== 1 || SCAN_INPUTS.some((input) => !names[0]?.includes(`\${{ inputs.${input} }}`))) marks.add("name");

  // 分岐点は、表示名に入る base と head の SHA からだけ求める
  const mergeBases = runText.split("git merge-base").length - 1;
  const fromInputs = runText.split('git merge-base "$BASE_SHA" "$HEAD_SHA"').length - 1;
  if (mergeBases === 0 || mergeBases !== fromInputs) marks.add("fork-point");
  if (!runText.includes("git rev-list --parents")) marks.add("parents");

  const required = [
    /tools\/checks\/export-tree\.sh "\$MERGE_SHA" "\$RUNNER_TEMP\/merge-tree"/,
    /tools\/checks\/export-tree\.sh --history "\$fork_point" "\$HEAD_SHA" "\$RUNNER_TEMP\/history"/,
    /tools\/checks\/leak-scan-secret\.sh dir "\$RUNNER_TEMP\/merge-tree"/,
    /tools\/checks\/leak-scan-secret\.sh history "\$RUNNER_TEMP\/history"/,
    /tools\/checks\/leak-scan-secret\.sh git --range "\$fork_point\.\.\$HEAD_SHA"/,
  ];
  if (required.some((pattern) => !pattern.test(runText))) marks.add("scans");

  return [...marks].map((mark) => `${workflow.path}#${mark}`);
}

/** 呼び出しのワークフローの見本が呼ぶ、公開のリポジトリの再利用できるワークフロー */
const CALLER_USES = "devbasex/nd-factory/.github/workflows/leak-check-secret.yml@main";

/** 呼び出しのワークフローの見本が設計の決定 4 の形を外れた所を、印（`<パス>#<印>`）で返す */
export function callerViolations(caller: LoadedWorkflow): string[] {
  const marks: string[] = [];
  const doc = caller.doc;
  const scan = doc.jobs?.scan;
  const generation = doc.jobs?.generation;
  if (JSON.stringify(triggerNames(doc)) !== JSON.stringify(ALLOWED_TRIGGERS.caller)) marks.push("on");
  if (scan?.uses !== CALLER_USES) marks.push("uses");
  if (Object.values(doc.jobs ?? {}).some((job) => job?.secrets === "inherit")) marks.push("secrets-inherit");
  else if (JSON.stringify(scan?.secrets) !== JSON.stringify({ LEAK_CHECK_PATTERN: "${{ secrets.LEAK_CHECK_PATTERN }}" })) {
    marks.push("secrets");
  }
  const needs = scan?.needs;
  if (!(needs === "generation" || (Array.isArray(needs) && needs.includes("generation")))) marks.push("needs");
  const generationText = JSON.stringify(generation ?? {});
  if (!generationText.includes("vars.LEAK_CHECK_GENERATION") || !generationText.includes("inputs.generation")) {
    marks.push("generation");
  }
  if (!isReadOnly(doc.permissions)) marks.push("permissions");
  return marks.map((mark) => `${caller.path}#${mark}`);
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

describe("triggerNames・triggerViolations", () => {
  it.each([
    ["文字列", "on: push\n", ["push"]],
    ["配列", "on: [push, pull_request]\n", ["push", "pull_request"]],
    ["鍵", "on:\n  push:\n  pull_request:\n", ["push", "pull_request"]],
    ["無い", "name: x\n", []],
  ])("%s の書き方で起動の名前を返す", (_label, text, expected) => {
    expect(triggerNames(docOf(`${text}jobs:\n  a:\n    runs-on: ubuntu-24.04\n`))).toEqual(expected);
  });

  const real = () => ({ workflows: loadWorkflows(ROOT), caller: loadWorkflowFile(ROOT, CALLER_PATH) });
  const replaced = (workflow: LoadedWorkflow, from: string, to: string): LoadedWorkflow => {
    const text = workflow.text.replace(from, to);
    if (text === workflow.text) throw new Error(`置き換える元が無い: ${from}`);
    return { ...workflow, text, doc: docOf(text) };
  };

  it.each([
    ["leak-check-secret.yml に pull_request_target を足す", SECRET_WORKFLOW_PATH, "pull_request_target"],
    ["leak-check-secret.yml に workflow_run を足す", SECRET_WORKFLOW_PATH, "workflow_run"],
    ["ci.yml に pull_request_target を足す", join(".github", "workflows", "ci.yml"), "pull_request_target"],
  ])("%s と当たる", (_label, path, trigger) => {
    const { workflows, caller } = real();
    const changed = workflows.map((workflow) =>
      workflow.path === path ? replaced(workflow, "\non:\n", `\non:\n  ${trigger}:\n`) : workflow,
    );
    expect(triggerViolations(changed, caller)).toEqual([`${path}#on.${trigger}`]);
  });

  it("見本に push を足すと当たる", () => {
    const { workflows, caller } = real();
    expect(triggerViolations(workflows, replaced(caller, "\non:\n", "\non:\n  push:\n"))).toEqual([`${CALLER_PATH}#on.push`]);
  });
});

describe("runCommandWords", () => {
  it.each([
    ["a && b | c", ["a", "b", "c"]],
    ['x="$(git rev-parse y)"', ["git"]],
    ["if [[ -n \"$x\" ]]; then\n  echo a\nfi", ["[[", "echo"]],
    ["if ! git fetch origin; then exit 1; fi", ["git", "exit"]],
    ["# 注\nstatus=0\ntools/checks/export-tree.sh a b || status=1", ["tools/checks/export-tree.sh"]],
  ])("%s の最初の語を返す", (run, expected) => {
    expect(runCommandWords(run)).toEqual(expected);
  });
});

describe("secretWorkflowViolations・callerViolations", () => {
  const secret = () => loadWorkflowFile(ROOT, SECRET_WORKFLOW_PATH);
  const ci = () => loadWorkflowFile(ROOT, CI_PATH);
  const broken = (base: LoadedWorkflow, from: string | RegExp, to: string): LoadedWorkflow => {
    const text = base.text.replace(from, to);
    if (text === base.text) throw new Error(`置き換える元が無い: ${String(from)}`);
    return { ...base, text, doc: docOf(text) };
  };
  const SCAN_STEP = "      - name: 秘密の規則を重ねて探す\n";

  it.each<[string, string | RegExp, string, string]>([
    ["ref を head にする", "ref: ${{ inputs.code_sha }}", "ref: ${{ inputs.head_sha }}", "checkout"],
    ["allow-unsafe-pr-checkout を渡す", "          persist-credentials: false\n", "          persist-credentials: false\n          allow-unsafe-pr-checkout: true\n", "checkout"],
    ["npm ci を足す", SCAN_STEP, `      - run: npm ci\n${SCAN_STEP}`, "run"],
    ["actions/setup-node を足す", SCAN_STEP, `      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n${SCAN_STEP}`, "uses"],
    ["run: に ${{ inputs.head_sha }} を書く", 'tools/checks/leak-scan-secret.sh dir "$RUNNER_TEMP/merge-tree"', 'echo "${{ inputs.head_sha }}"\n          tools/checks/leak-scan-secret.sh dir "$RUNNER_TEMP/merge-tree"', "run-inputs"],
    ["continue-on-error: true を足す", SCAN_STEP, `${SCAN_STEP}        continue-on-error: true\n`, "conditions"],
    ["表示名から head の SHA を外す", " head ${{ inputs.head_sha }}", "", "name"],
    ["親の確かめを外す", 'git rev-list --parents -n 1 "$MERGE_SHA"', 'git rev-parse "$MERGE_SHA"', "parents"],
    ["分岐点を別の値から求める", 'fork_point="$(git merge-base "$BASE_SHA" "$HEAD_SHA")"\n          tools/checks/leak-scan-secret.sh', 'fork_point="$(git merge-base "$MERGE_SHA" "$HEAD_SHA")"\n          tools/checks/leak-scan-secret.sh', "fork-point"],
    ["export-tree.sh --history の呼び出しを外す", /\n {10}tools\/checks\/export-tree\.sh --history [^\n]*/, "", "scans"],
    ["履歴の history の探しを外す", /\n {10}tools\/checks\/leak-scan-secret\.sh history [^\n]*/, "", "scans"],
    ["git archive を使う", 'tools/checks/export-tree.sh "$MERGE_SHA" "$RUNNER_TEMP/merge-tree"', 'git archive "$MERGE_SHA" -o "$RUNNER_TEMP/merge.tar"\n          tools/checks/export-tree.sh "$MERGE_SHA" "$RUNNER_TEMP/merge-tree"', "run"],
    ["--details を足す", 'tools/checks/leak-scan-secret.sh dir "$RUNNER_TEMP/merge-tree"', 'tools/checks/leak-scan-secret.sh dir "$RUNNER_TEMP/merge-tree" --details', "run"],
    ["GITHUB_OUTPUT に書く", 'tools/checks/leak-scan-secret.sh dir "$RUNNER_TEMP/merge-tree"', 'echo "fork_point=$fork_point" >>"$GITHUB_OUTPUT"\n          tools/checks/leak-scan-secret.sh dir "$RUNNER_TEMP/merge-tree"', "github-files"],
    ["pull-requests: write を足す", "permissions:\n  contents: read\n", "permissions:\n  contents: read\n  pull-requests: write\n", "permissions"],
    ["ジョブの env に GITLEAKS_VERSION を足す", "    timeout-minutes: 20\n", "    timeout-minutes: 20\n    env:\n      GITLEAKS_VERSION: 8.30.1\n", "gitleaks-env"],
    ["gitleaks を置く手順に curl を直に書く", 'run: tools/checks/install-gitleaks.sh "$RUNNER_TEMP/gitleaks"', "run: curl -fsSL -o g.tar.gz https://example.com/g.tar.gz", "gitleaks-install"],
    ["秘密をほかの手順でも受ける", "      - name: マージコミットの木と履歴の項目を取り出す\n        env:\n", "      - name: マージコミットの木と履歴の項目を取り出す\n        env:\n          LEAK_CHECK_PATTERN: ${{ secrets.LEAK_CHECK_PATTERN }}\n", "secret-steps"],
    ["pull_request_target を足す", "\non:\n", "\non:\n  pull_request_target:\n", "on"],
    ["必須の指定を変数にする", 'LEAK_CHECK_REQUIRE_PATTERN: "1"', "LEAK_CHECK_REQUIRE_PATTERN: ${{ vars.LEAK_CHECK_REQUIRE_PATTERN }}", "require"],
  ])("%s と、その印だけが出る", (_label, from, to, mark) => {
    expect(secretWorkflowViolations(broken(secret(), from, to), ci())).toEqual([`${SECRET_WORKFLOW_PATH}#${mark}`]);
  });

  const caller = () => loadWorkflowFile(ROOT, CALLER_PATH);
  it.each<[string, string | RegExp, string, string]>([
    ["secrets: inherit を使う", / {4}secrets:\n {6}LEAK_CHECK_PATTERN: .*\n/, "    secrets: inherit\n", "secrets-inherit"],
    ["@ の後を SHA にする", "leak-check-secret.yml@main", `leak-check-secret.yml@${"a".repeat(40)}`, "uses"],
    ["世代の確かめを外す", "    needs: generation\n", "", "needs"],
    ["世代の変数を読まない", "${{ vars.LEAK_CHECK_GENERATION }}", "1", "generation"],
  ])("見本で %s と当たる", (_label, from, to, mark) => {
    expect(callerViolations(broken(caller(), from, to))).toContain(`${CALLER_PATH}#${mark}`);
  });
});

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
      "leak-check-push に --details を渡す",
      [["tools/checks/leak-scan-secret.sh git --count-only", "tools/checks/leak-scan-secret.sh git --details"]],
      ["jobs.leak-check-push#scan-git", "jobs#details"],
    ],
    [
      "leak-check に --paths を渡す",
      [["tools/checks/leak-scan.sh dir .gitleaks.toml", "tools/checks/leak-scan.sh dir .gitleaks.toml --paths"]],
      ["jobs#details"],
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

  it("秘密 LEAK_CHECK_PATTERN を読むジョブは leak-check-push と leak-check-secret だけ", () => {
    expect(patternSecretReaders(workflows).sort()).toEqual(
      [`${CI_PATH}#jobs.leak-check-push`, `${SECRET_WORKFLOW_PATH}#jobs.leak-check-secret`].sort(),
    );
  });

  const caller = loadWorkflowFile(ROOT, CALLER_PATH);

  it("起動した人で分ける条件の語が、ワークフローにも見本にも無い", () => {
    expect(actorConditions([...workflows, caller])).toEqual([]);
  });

  it("漏れの検査のワークフローが直に打つスクリプトは、実行の権限を持つ", () => {
    const scripts = SECRET_WORKFLOW_COMMANDS.filter((command) => command.startsWith("tools/"));
    expect(scripts.filter((script) => (statSync(join(ROOT, script)).mode & 0o100) === 0)).toEqual([]);
  });

  it("どのワークフローと見本も、許す起動だけを持つ", () => {
    expect(triggerViolations(workflows, caller)).toEqual([]);
  });

  it("leak-check-secret.yml が決定 4 の形を外れない", () => {
    const secret = workflows.find((workflow) => workflow.path === SECRET_WORKFLOW_PATH);
    if (!secret || !ci) throw new Error("leak-check-secret.yml か ci.yml を読めない");
    expect(secretWorkflowViolations(secret, ci)).toEqual([]);
  });

  it("呼び出しのワークフローの見本が決定 4 の形を外れず、permissions が { contents: read } だけ", () => {
    expect(callerViolations(caller)).toEqual([]);
    expect(permissionViolations(caller.doc)).toEqual([]);
    expect(credentialWords(caller.text)).toEqual([]);
  });

  it("最上位の permissions が { contents: read } だけで、ジョブの permissions は持たないか同じ", () => {
    const found = workflows.flatMap((workflow) =>
      permissionViolations(workflow.doc).map((scope) => `${workflow.path}#${scope}`),
    );
    expect(found).toEqual([]);
  });
});
