/**
 * NDF の契約の取得と形（照合 `ndf-contract-check.ts` と生成のコマンド `ndf-contract-sync.ts` が共有する）。
 *
 * NDF のリポジトリから 1 つのコミットの契約のファイルを取り（`fetchContract`）、照合と生成が読む鍵の形（`SCHEMAS`）と、
 * 作業の木の固定の点（`readPinnedCommit`）を置く。
 */

import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { ndfEntrypointRowFields, reportRequiredRuleFields } from "@nd-factory/contracts/ndf-contract-use-schema";

/** NDF のリポジトリ（実行の文書の「NDF との契約」） */
export const NDF_REPO_URL = "https://github.com/devbasex/ai-plugins";

/** NDF のリポジトリの中の契約の置き場（`C/`） */
export const CONTRACT_DIR = "plugins/ndf/contracts";

/** 固定の点を置く唯一のファイル */
export const PIN_FILE = "ndf-pin.json";

// 固定の点のキー。参照の検査の版の比べに当たらないよう、この行に比べの記号と矢印の関数を置かない
export const PIN_KEY = "ndf_ref";

/** 読む契約のファイル（`C/` からの相対パス） */
const CONTRACT_PATHS = [
  "version.json",
  "domains/entrypoint-cases.json",
  "domains/entrypoints.json",
  "domains/env.json",
  "domains/ndf-files.json",
  "hooks/unattended-report.json",
] as const;

export type ContractPath = (typeof CONTRACT_PATHS)[number];

/** 取るコミット。固定の点はコミットを、先端はリポジトリの既定の枝（`HEAD` が指す枝）を引く */
export type ContractRev = { kind: "fixed"; commit: string } | { kind: "tip" };

/** 1 つのコミットの契約のファイル。`json` の鍵は `C/` からの相対パス */
export type ContractFiles = { commit: string; json: Record<string, unknown> };

/** 契約を取れない・読めない */
export class ContractFetchError extends Error {
  name = "ContractFetchError";
}

const COMMIT = /^[0-9a-f]{40}$/;
const execFileAsync = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new ContractFetchError(`git ${args[0] ?? ""} が失敗した${stderr === "" ? "" : `: ${stderr.split("\n")[0]}`}`);
  }
}

/** リポジトリの既定の枝（`HEAD` が指す枝）の参照の名前を引く。枝の名前は書き込まない */
async function defaultBranch(workDir: string, repoUrl: string): Promise<string> {
  const head = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(await git(workDir, ["ls-remote", "--symref", repoUrl, "HEAD"]));
  if (head?.[1] === undefined) throw new ContractFetchError("既定の枝（HEAD が指す枝）を引けない");
  return head[1];
}

/** NDF のリポジトリから 1 つのコミットを深さ 1 で取り、契約のファイルを読む */
export async function fetchContract(rev: ContractRev, repoUrl: string, workDir: string): Promise<ContractFiles> {
  if (rev.kind === "fixed" && !COMMIT.test(rev.commit)) {
    throw new ContractFetchError(`固定の点がコミットの形（40 桁の 16 進）でない: ${rev.commit}`);
  }
  await mkdir(workDir, { recursive: true });
  await git(workDir, ["init", "-q"]);
  const target = rev.kind === "fixed" ? rev.commit : await defaultBranch(workDir, repoUrl);
  await git(workDir, ["fetch", "-q", "--depth", "1", "--no-tags", "--", repoUrl, target]);
  const commit = (await git(workDir, ["rev-parse", "FETCH_HEAD"])).trim();
  if (rev.kind === "fixed" && commit !== rev.commit) {
    throw new ContractFetchError(`取ったコミット ${commit} が固定の点 ${rev.commit} と違う`);
  }
  const json: Record<string, unknown> = {};
  for (const path of CONTRACT_PATHS) {
    const full = `${CONTRACT_DIR}/${path}`;
    let text: string;
    try {
      text = await git(workDir, ["show", `${commit}:${full}`]);
    } catch {
      throw new ContractFetchError(`契約のファイルが無い: ${full}`);
    }
    try {
      json[path] = JSON.parse(text);
    } catch {
      throw new ContractFetchError(`契約のファイルが JSON でない: ${full}`);
    }
  }
  return { commit, json };
}

// 契約のファイルの形のうち、照合が読む鍵だけ。ほかの鍵は受け流す
const strings = z.array(z.string());
const rowsOf = <T extends z.ZodType>(row: T) => z.object({ rows: z.array(row) });
export const SCHEMAS = {
  "version.json": z.object({ history: z.array(z.object({ version: z.number(), sha256: z.string() })) }),
  "domains/entrypoint-cases.json": rowsOf(
    z.object({ id: z.string(), entrypoint: z.string(), call: z.string(), env: strings, valid: z.boolean() }),
  ),
  // 生成のデータと同じ列の定義から作る。上流の説明の列は z.object が捨てる
  "domains/entrypoints.json": rowsOf(z.object(ndfEntrypointRowFields)),
  "domains/env.json": rowsOf(z.object({ id: z.string(), set_by: z.string() })),
  "domains/ndf-files.json": rowsOf(
    z.object({ id: z.string(), path: z.string(), reader: z.string().optional(), fields: strings.optional() }),
  ),
  "hooks/unattended-report.json": z.object({
    shape: z.object({
      values: z.record(z.string(), z.unknown()),
      items: strings,
      material: z.record(z.string(), z.unknown()),
      // 生成のデータと同じ規則の定義から作る。条件の鍵（item・prefix・equals など）は catchall で残し、条件ごと照らして差分に出す
      required: z.record(z.string(), z.object(reportRequiredRuleFields)),
    }),
    cases: z.array(z.object({ text: z.string(), result: z.string(), errors: strings })),
  }),
} satisfies Record<ContractPath, z.ZodType>;

export type Parsed<P extends ContractPath> = z.infer<(typeof SCHEMAS)[P]>;

export function missing(wanted: readonly string[], have: Iterable<string>): string[] {
  const set = new Set(have);
  return wanted.filter((name) => !set.has(name));
}

export function list(names: readonly string[]): string {
  return names.join(", ");
}

/** 作業の木の `ndf-pin.json` から固定の点のコミットを読む */
export async function readPinnedCommit(root: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(join(root, PIN_FILE), "utf8"));
  const commit = (parsed as Record<string, unknown> | null)?.[PIN_KEY];
  if (typeof commit !== "string") throw new Error(`${PIN_FILE} に固定の点のキーの文字列が無い`);
  return commit;
}
