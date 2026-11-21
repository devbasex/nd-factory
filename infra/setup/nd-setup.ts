import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { EXIT } from "@nd-factory/contracts/exit-codes";
import type { Settings } from "@nd-factory/contracts/settings";
import { assemblyDigest } from "../lib/assembly-digest.ts";
import {
  STACK_KEYS,
  type StackKey,
  appResourceNames,
  googleRedirectUri,
  pipelineResourceNames,
  stackName,
} from "../lib/naming.ts";
import { SettingsFileError, loadSettingsFile } from "../lib/settings-file.ts";
import {
  ProfileError,
  type Target,
  readBootstrapVersion,
  readCostAllocationTags,
  readGetAzsCount,
  readOrganizationManager,
  resolveProfile,
} from "./aws-reader.ts";
import { MISSING_CHECKS, type MissingContext, collectMissingSettings, printMissingSettings } from "./missing-settings.ts";

// 設置のコマンド。diff は確かめ・合成・差分・確認の値を出して止まり、AWS へ書かない。
// deploy は diff が保存した合成の結果を合成し直さずに、確認の値が同じときだけ反映する。
// 書き込みの前の確かめ（設定のファイル・profile・bootstrap の版・確認の値）のどれかが欠ければ、書かずに止まる

export type { StackKey } from "../lib/naming.ts";

// 合成の結果の置き場に書く、選んだスタックの一覧。要約値に含まれる
export const STACKS_FILE = "nd-setup-stacks.json";

export type DiffArgs = { kind: "diff"; profile: string; settings: string; out: string; stacks: StackKey[] | null };
export type DeployArgs = { kind: "deploy"; profile: string; assembly: string; confirm: string };
export type UsageError = { kind: "usage"; message: string };

export type RunOptions = { cwd: string; env?: Record<string, string> };

export type SetupFiles = {
  readText: (path: string) => Promise<string>;
  writeText: (path: string, text: string) => Promise<void>;
  removeDir: (path: string) => Promise<void>;
  isDirectory: (path: string) => Promise<boolean>;
};

// 外部コマンド・AWS を読む関数・ファイルを差し替えられるようにする。テストは本物の AWS を呼ばない
export type SetupDeps = {
  // リポジトリの最上位
  repoRoot: string;
  // 利用者が渡した相対パスを解く場所
  cwd: string;
  // 外部コマンドを打ち、終了コードを返す。出力は利用者の端末へそのまま流す
  run: (command: string, args: string[], options: RunOptions) => Promise<number>;
  resolveProfile: (profile: string) => Promise<Target>;
  readBootstrapVersion: (target: Target) => Promise<number | null>;
  // 足りない設定の一覧のために読むもの（読むだけ）
  readCostAllocationTags: MissingContext["readCostAllocationTags"];
  readOrganizationManager: MissingContext["readOrganizationManager"];
  readGetAzsCount: MissingContext["readGetAzsCount"];
  files: SetupFiles;
  digest: (dir: string) => Promise<string>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export class SynthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SynthError";
  }
}

class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export const USAGE = [
  "使い方:",
  "  npm run nd-setup -- diff   --profile <profile> --settings <設定のファイル> --out <合成の結果の置き場> [--stack app|pipeline]...",
  "  npm run nd-setup -- deploy --profile <profile> --assembly <合成の結果の置き場> --confirm <確認の値>",
].join("\n");

function isStackKey(value: string): value is StackKey {
  return (STACK_KEYS as readonly string[]).includes(value);
}

function orderStacks(stacks: readonly StackKey[]): StackKey[] {
  return STACK_KEYS.filter((k) => stacks.includes(k));
}

function usage(message: string): UsageError {
  return { kind: "usage", message };
}

export function parseArgs(argv: string[]): DiffArgs | DeployArgs | UsageError {
  const [sub, ...rest] = argv;
  if (sub === "diff") {
    let values;
    try {
      ({ values } = parseNodeArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: {
          profile: { type: "string" },
          settings: { type: "string" },
          out: { type: "string" },
          stack: { type: "string", multiple: true },
        },
      }));
    } catch (e) {
      return usage((e as Error).message);
    }
    const { profile, settings, out, stack } = values;
    if (!profile || !settings || !out) return usage("diff には --profile・--settings・--out が要る");
    if (stack === undefined) return { kind: "diff", profile, settings, out, stacks: null };
    const bad = stack.filter((k) => !isStackKey(k));
    if (bad.length > 0) return usage(`--stack は app か pipeline: ${bad.join(", ")}`);
    return { kind: "diff", profile, settings, out, stacks: orderStacks(stack as StackKey[]) };
  }
  if (sub === "deploy") {
    if (rest.some((a) => a === "--stack" || a.startsWith("--stack="))) {
      return usage("deploy は --stack を受けない。反映するスタックは diff で選んだ一覧に従う");
    }
    let values;
    try {
      ({ values } = parseNodeArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: {
          profile: { type: "string" },
          assembly: { type: "string" },
          confirm: { type: "string" },
        },
      }));
    } catch (e) {
      return usage((e as Error).message);
    }
    const { profile, assembly, confirm } = values;
    if (!profile || !assembly || !confirm) return usage("deploy には --profile・--assembly・--confirm が要る");
    return { kind: "deploy", profile, assembly, confirm };
  }
  return usage(sub === undefined ? "サブコマンドが無い" : `知らないサブコマンド: ${sub}`);
}

export function confirmValue(digest: string, target: Target, stacks: StackKey[]): string {
  return `${digest.slice(0, 12)}:${target.account}:${target.region}:${orderStacks(stacks).join(",")}`;
}

function infraDir(deps: SetupDeps): string {
  return join(deps.repoRoot, "infra");
}

function cdk(args: string[]): string[] {
  return ["--no-install", "cdk", ...args];
}

function stackNames(s: Settings, stacks: StackKey[]): string[] {
  return orderStacks(stacks).map((k) => stackName(s, k));
}

export async function synthesize(
  settingsPath: string,
  out: string,
  stacks: StackKey[],
  target: Target,
  deps: SetupDeps,
): Promise<void> {
  const settings = loadSettingsFile(settingsPath);
  const ordered = orderStacks(stacks);
  // 前の合成の結果を残さない。残すと別の合成のアセットが要約値に混ざる
  await deps.files.removeDir(out);

  const build = await deps.run("npm", ["run", "build", "-w", "apps/web"], { cwd: deps.repoRoot });
  if (build !== 0) throw new SynthError(`画面のビルドが失敗した（終了コード ${build}）`);

  const synth = await deps.run("npx", cdk(["synth", "-q", "--profile", target.profile, "-o", out]), {
    cwd: infraDir(deps),
    env: {
      ND_SETTINGS: settingsPath,
      ND_STACKS: ordered.join(","),
      CDK_DEFAULT_ACCOUNT: target.account,
      CDK_DEFAULT_REGION: target.region,
    },
  });
  if (synth !== 0) throw new SynthError(`合成が失敗した（終了コード ${synth}）`);

  await mkdir(out, { recursive: true });
  await deps.files.writeText(
    join(out, STACKS_FILE),
    `${JSON.stringify({ stacks: ordered, stack_names: stackNames(settings, ordered) }, null, 2)}\n`,
  );
}

export async function checkBootstrap(
  assembly: string,
  target: Target,
  deps: SetupDeps,
): Promise<{ ok: true } | { ok: false; required: number; current: number | null }> {
  let manifest: { artifacts?: Record<string, { properties?: { requiresBootstrapStackVersion?: unknown } }> };
  try {
    manifest = JSON.parse(await deps.files.readText(join(assembly, "manifest.json")));
  } catch {
    throw new ManifestError("合成の結果の manifest.json を読めない");
  }
  const versions = Object.values(manifest.artifacts ?? {})
    .map((a) => a.properties?.requiresBootstrapStackVersion)
    .filter((v): v is number => typeof v === "number");
  if (versions.length === 0) throw new ManifestError("合成の結果の manifest に求める bootstrap の版が無い");
  const required = Math.max(...versions);
  const current = await deps.readBootstrapVersion(target);
  if (current !== null && current >= required) return { ok: true };
  return { ok: false, required, current };
}

// bootstrap の版を確かめ、止めるときは終了コードを返す。manifest の誤りのコードは呼ぶ側で違う
async function bootstrapGate(assembly: string, target: Target, deps: SetupDeps, manifestCode: number): Promise<number | null> {
  let result;
  try {
    result = await checkBootstrap(assembly, target, deps);
  } catch (e) {
    const err = e as Error;
    if (err instanceof ManifestError) {
      deps.stderr(err.message);
      return manifestCode;
    }
    deps.stderr(`bootstrap の版を読めない: ${err.name}: ${err.message}`);
    return EXIT.BOOTSTRAP;
  }
  if (result.ok) return null;
  deps.stderr(
    `bootstrap の版が足りない: 求める版 ${result.required}・今の版 ${result.current ?? "無し"}（アカウント ${target.account}・リージョン ${target.region}）`,
  );
  deps.stderr("このコマンドは bootstrap を打たない。上げ方は docs/operations/setup.md の「前提」にある");
  return EXIT.BOOTSTRAP;
}

function printNames(s: Settings, stacks: StackKey[], target: Target, deps: SetupDeps): void {
  deps.stdout("作る資源の名前:");
  deps.stdout(`  スタック: ${stackNames(s, stacks).join(", ")}`);
  if (stacks.includes("app")) {
    for (const [key, name] of Object.entries(appResourceNames(s))) deps.stdout(`  ${key}: ${name}`);
  }
  if (stacks.includes("pipeline")) {
    for (const [key, name] of Object.entries(pipelineResourceNames(s))) deps.stdout(`  ${key}: ${name}`);
  }
  if (stacks.includes("app")) {
    deps.stdout(`Google のクライアントに登録する戻り先の URL: ${googleRedirectUri(s, target.region)}`);
  }
}

export async function runDiff(a: DiffArgs, deps: SetupDeps): Promise<number> {
  const settingsPath = resolve(deps.cwd, a.settings);
  const out = resolve(deps.cwd, a.out);

  let settings: Settings;
  try {
    settings = loadSettingsFile(settingsPath);
  } catch (e) {
    if (!(e instanceof SettingsFileError)) throw e;
    deps.stderr(`設定のファイルを使えない: ${settingsPath}`);
    for (const issue of e.issues) deps.stderr(issue);
    return EXIT.SETTINGS;
  }
  const stacks = a.stacks ?? (settings.pipeline ? ["app", "pipeline"] : ["app"]);
  if (stacks.includes("pipeline") && !settings.pipeline) {
    deps.stderr("--stack pipeline を選んだが、設定のファイルに pipeline が無い");
    return EXIT.USAGE;
  }

  let target: Target;
  try {
    target = await deps.resolveProfile(a.profile);
  } catch (e) {
    if (!(e instanceof ProfileError)) throw e;
    deps.stderr(e.message);
    return EXIT.PROFILE;
  }

  try {
    await synthesize(settingsPath, out, stacks, target, deps);
  } catch (e) {
    if (!(e instanceof SynthError)) throw e;
    deps.stderr(e.message);
    return EXIT.BUILD;
  }

  // 求める版は合成の結果にしか無いため、合成の後に比べる
  const gate = await bootstrapGate(out, target, deps, EXIT.BUILD);
  if (gate !== null) return gate;

  deps.stdout("差分（保存した合成の結果と、今のスタックのテンプレートの比べ。変更のセットは作らない）:");
  const diff = await deps.run(
    "npx",
    cdk(["diff", "--app", out, "--method=template", "--profile", a.profile, ...stackNames(settings, stacks)]),
    { cwd: infraDir(deps) },
  );
  if (diff !== 0) {
    deps.stderr(`差分の作成が失敗した（終了コード ${diff}）`);
    return EXIT.BUILD;
  }

  const confirm = confirmValue(await deps.digest(out), target, stacks);
  printNames(settings, stacks, target, deps);
  deps.stdout(`確認の値: ${confirm}`);
  deps.stdout(`差分を承認した後に打つ: npm run nd-setup -- deploy --profile ${a.profile} --assembly ${out} --confirm ${confirm}`);

  // 足りない設定は反映を止めないため、終了コードを変えない
  const missing = await collectMissingSettings(
    {
      settings,
      target,
      readCostAllocationTags: deps.readCostAllocationTags,
      readOrganizationManager: deps.readOrganizationManager,
      readGetAzsCount: deps.readGetAzsCount,
    },
    MISSING_CHECKS,
  );
  printMissingSettings(missing, deps.stdout);
  return EXIT.OK;
}

type StacksFile = { stacks: StackKey[]; stack_names: string[] };

function parseStacksFile(text: string): StacksFile {
  const raw = JSON.parse(text) as Partial<StacksFile>;
  const stacks = raw.stacks;
  const names = raw.stack_names;
  if (!Array.isArray(stacks) || stacks.length === 0 || !stacks.every((k) => typeof k === "string" && isStackKey(k))) {
    throw new Error("stacks の形が違う");
  }
  if (!Array.isArray(names) || names.length !== stacks.length || !names.every((n) => typeof n === "string" && n.length > 0)) {
    throw new Error("stack_names の形が違う");
  }
  return { stacks, stack_names: names };
}

export async function runDeploy(a: DeployArgs, deps: SetupDeps): Promise<number> {
  const assembly = resolve(deps.cwd, a.assembly);
  if (!(await deps.files.isDirectory(assembly))) {
    deps.stderr(`合成の結果の置き場が無い: ${assembly}。先に diff を打つ`);
    return EXIT.SETTINGS;
  }
  let selected: StacksFile;
  try {
    selected = parseStacksFile(await deps.files.readText(join(assembly, STACKS_FILE)));
  } catch (e) {
    deps.stderr(`合成の結果の置き場に ${STACKS_FILE} が無いか読めない（${(e as Error).message}）。diff を打ち直す`);
    return EXIT.SETTINGS;
  }

  let target: Target;
  try {
    target = await deps.resolveProfile(a.profile);
  } catch (e) {
    if (!(e instanceof ProfileError)) throw e;
    deps.stderr(e.message);
    return EXIT.PROFILE;
  }

  const gate = await bootstrapGate(assembly, target, deps, EXIT.SETTINGS);
  if (gate !== null) return gate;

  let digest: string;
  try {
    digest = await deps.digest(assembly);
  } catch (e) {
    deps.stderr(`合成の結果の置き場を読めない: ${(e as Error).message}`);
    return EXIT.SETTINGS;
  }
  if (confirmValue(digest, target, selected.stacks) !== a.confirm) {
    deps.stderr("確認の値が違うため反映しない。置き場が書き換わったか、diff と違うアカウントかリージョンの profile を渡した");
    deps.stderr("diff を打ち直し、新しい差分を承認してから、その確認の値で deploy を打つ");
    return EXIT.CONFIRM_MISMATCH;
  }

  const code = await deps.run(
    "npx",
    cdk(["deploy", "--app", assembly, "--profile", a.profile, "--require-approval", "never", ...selected.stack_names]),
    { cwd: infraDir(deps) },
  );
  if (code !== 0) {
    deps.stderr(`反映が失敗した（終了コード ${code}）。CloudFormation の戻しで前の状態へ戻る。原因を直して diff から打ち直す`);
    return EXIT.DEPLOY_FAILED;
  }
  deps.stdout(`反映した: ${selected.stack_names.join(", ")}`);
  return EXIT.OK;
}

export async function mainSetup(argv: string[], deps: SetupDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "usage") {
    deps.stderr(parsed.message);
    deps.stderr(USAGE);
    return EXIT.USAGE;
  }
  try {
    return parsed.kind === "diff" ? await runDiff(parsed, deps) : await runDeploy(parsed, deps);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    deps.stderr(`想定しない失敗: ${err.name}: ${err.message}`);
    return EXIT.BUILD;
  }
}

export const defaultFiles: SetupFiles = {
  readText: (path) => readFile(path, "utf8"),
  writeText: (path, text) => writeFile(path, text),
  removeDir: (path) => rm(path, { recursive: true, force: true }),
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
};

function runCommand(command: string, args: string[], options: RunOptions): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: "inherit" });
    child.on("error", (e) => {
      process.stderr.write(`${command} を起動できない: ${e.message}\n`);
      done(127);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

export function defaultDeps(): SetupDeps {
  return {
    repoRoot: fileURLToPath(new URL("../../", import.meta.url)),
    // npm run は最上位で打つため、利用者の打った場所は INIT_CWD にある
    cwd: process.env.INIT_CWD ?? process.cwd(),
    run: runCommand,
    resolveProfile,
    readBootstrapVersion,
    readCostAllocationTags,
    readOrganizationManager,
    readGetAzsCount,
    files: defaultFiles,
    digest: assemblyDigest,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

if (import.meta.main) {
  process.exitCode = await mainSetup(process.argv.slice(2), defaultDeps());
}
