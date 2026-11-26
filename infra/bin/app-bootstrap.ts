import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { fromIni } from "@aws-sdk/credential-providers";
import { RegionInfo } from "aws-cdk-lib/region-info";
import { restrictBootstrapTemplate } from "../lib/app-bootstrap-template.ts";
import { type BootstrapReader, checkQualifier } from "../lib/bootstrap-collision.ts";
import { TAG_KEYS, appBootstrapNames, appQualifier } from "../lib/naming.ts";
import { loadSettingsFile } from "../lib/settings-file.ts";
import { type Target, resolveProfile } from "../setup/aws-reader.ts";

// アプリ専用の bootstrap の準備のコマンド。qualifier の衝突を確かめ、制約を当てたテンプレートをリポジトリの外へ
// 書き出して、打つ cdk bootstrap のコマンドを表示する。bootstrap 自体は打たない

const USAGE = [
  "使い方:",
  "  npm run app-bootstrap -- check    --profile <profile> --settings <設定のファイル>",
  "  npm run app-bootstrap -- template --profile <profile> --settings <設定のファイル> --out <ファイル> [--direct-role <ARN>]...",
].join("\n");

type CheckArgs = { kind: "check"; profile: string; settings: string };
type TemplateArgs = { kind: "template"; profile: string; settings: string; out: string; directRoles: string[] };
type UsageError = { kind: "usage"; message: string };

export type BootstrapDeps = {
  // 同じリポジトリの作業ディレクトリ（メインと、登録済みの worktree）
  repoRoots: () => string[];
  // 利用者が渡した相対パスを解く場所
  cwd: string;
  resolveProfile: (profile: string) => Promise<Target>;
  reader: (target: Target) => BootstrapReader;
  readTemplate: () => string;
  // 既にあるファイルは上書きせず、例外にする
  writeText: (path: string, text: string) => void;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

const ROLE_ARN = /^arn:[a-z-]+:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/;

export function parseArgs(argv: string[]): CheckArgs | TemplateArgs | UsageError {
  const usage = (message: string): UsageError => ({ kind: "usage", message });
  const [sub, ...rest] = argv;
  if (sub !== "check" && sub !== "template") return usage("check か template を指定する");
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
        "direct-role": { type: "string", multiple: true },
      },
    }));
  } catch (e) {
    return usage((e as Error).message);
  }
  const { profile, settings, out } = values;
  const directRoles = values["direct-role"] ?? [];
  if (!profile || !settings) return usage("--profile と --settings が要る");
  if (sub === "check") {
    if (out !== undefined || directRoles.length > 0) return usage("check は --out と --direct-role を受けない");
    return { kind: "check", profile, settings };
  }
  if (!out) return usage("template には --out が要る");
  const bad = directRoles.filter((arn) => !ROLE_ARN.test(arn));
  if (bad.length > 0) return usage(`--direct-role は IAM のロールの ARN にする: ${bad.join(", ")}`);
  return { kind: "template", profile, settings, out, directRoles };
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}

export function bootstrapReader(target: Target): BootstrapReader {
  const config = { region: target.region, credentials: fromIni({ profile: target.profile }) };
  return {
    async versionExists(qualifier) {
      try {
        await new SSMClient(config).send(new GetParameterCommand({ Name: `/cdk-bootstrap/${qualifier}/version` }));
        return true;
      } catch (e) {
        if (errorName(e) === "ParameterNotFound") return false;
        throw new Error(`bootstrap の版を読めない（${errorName(e)}）`, { cause: e });
      }
    },
    async describeStack(name) {
      let stack;
      try {
        stack = (await new CloudFormationClient(config).send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
      } catch (e) {
        if (errorName(e) === "ValidationError" && (e as Error).message.includes("does not exist")) return null;
        throw new Error(`スタックを読めない（${errorName(e)}）`, { cause: e });
      }
      if (!stack?.StackStatus) throw new Error("スタックの状態が分からない");
      return {
        status: stack.StackStatus,
        qualifier: stack.Parameters?.find((p) => p.ParameterKey === "Qualifier")?.ParameterValue,
        tags: Object.fromEntries((stack.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""])),
      };
    },
  };
}

// まだ無いファイルの置き場は、ある親のリンクを解いて比べる
function realPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(realPath(parent), basename(path));
}

// git の無い置き方（アーカイブの展開）では、このディレクトリだけを返す。
// .git があるのに一覧を読めなければ、書き込みへ進まないよう例外のままにする
export function repositoryRoots(repoRoot: string): string[] {
  if (!existsSync(join(repoRoot, ".git"))) return [repoRoot];
  // パスは改行を含めるので、行ではなく NUL（-z）で区切って読む
  const listed = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return [repoRoot, ...listed];
}

function insideRepo(repoRoot: string, path: string): boolean {
  const rel = relative(realPath(repoRoot), realPath(path));
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

async function run(args: CheckArgs | TemplateArgs, deps: BootstrapDeps): Promise<void> {
  const settings = loadSettingsFile(resolve(deps.cwd, args.settings));
  const out = args.kind === "template" ? resolve(deps.cwd, args.out) : undefined;
  // テンプレートはアカウントの値を持つので、リポジトリに置かせない
  if (out && deps.repoRoots().some((root) => insideRepo(root, out))) {
    throw new Error("--out はリポジトリ（登録済みの worktree を含む）の外にする（テンプレートはアカウントの値を持つ）");
  }
  // 設定のファイルなどを指しても壊さない
  if (out && existsSync(out)) throw new Error(`--out のファイルが既にある。上書きしないので、別のファイル名を指定する: ${out}`);

  const target = await deps.resolveProfile(args.profile);
  const names = appBootstrapNames(settings);
  const qualifier = appQualifier(settings);
  const [prefixKey, envKey] = TAG_KEYS;
  const tags = { [prefixKey]: settings.prefix, [envKey]: settings.environment };
  const check = await checkQualifier({ qualifier, stackName: names.stack, tags }, deps.reader(target));
  if (!check.ok) throw new Error(check.reason);
  const what = check.mode === "create" ? "新しく作る" : "この設置のものを更新する";
  deps.stdout(`qualifier ${qualifier} は使える（${what}。スタック ${names.stack}）`);
  if (args.kind === "check" || !out) return;

  const partition = RegionInfo.get(target.region).partition ?? "aws";
  const { account, region, profile } = target;
  deps.writeText(
    out,
    restrictBootstrapTemplate(deps.readTemplate(), { partition, account, region, settings, directRoleArns: args.directRoles }),
  );
  deps.stdout(`テンプレートを書いた: ${out}`);
  deps.stdout("承認を受けた後、次のコマンドを打つ。後日に打つときは、先に check を打ち直す");
  deps.stdout(
    [
      `npx cdk bootstrap aws://${account}/${region}`,
      `--profile ${profile}`,
      `--template '${out}'`,
      `--qualifier ${qualifier}`,
      `--toolkit-stack-name ${names.stack}`,
      `--cloudformation-execution-policies arn:${partition}:iam::${account}:policy/${names.executionPolicy}`,
      ...Object.entries(tags).map(([key, value]) => `--tags ${key}=${value}`),
    ].join(" \\\n  "),
  );
}

export async function mainAppBootstrap(argv: string[], deps: BootstrapDeps): Promise<number> {
  const args = parseArgs(argv);
  if (args.kind === "usage") {
    deps.stderr(`${args.message}\n${USAGE}`);
    return 2;
  }
  try {
    await run(args, deps);
    return 0;
  } catch (e) {
    deps.stderr(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) {
  const template = new URL("lib/api/bootstrap/bootstrap-template.yaml", import.meta.resolve("aws-cdk/package.json"));
  process.exitCode = await mainAppBootstrap(process.argv.slice(2), {
    repoRoots: () => repositoryRoots(fileURLToPath(new URL("../../", import.meta.url))),
    // npm run は最上位で打つため、利用者の打った場所は INIT_CWD にある
    cwd: process.env.INIT_CWD ?? process.cwd(),
    resolveProfile,
    reader: bootstrapReader,
    readTemplate: () => readFileSync(template, "utf8"),
    writeText: (path, text) => writeFileSync(path, text, { flag: "wx" }),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
}
