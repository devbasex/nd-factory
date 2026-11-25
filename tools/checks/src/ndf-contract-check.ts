/**
 * NDF の契約の照合（F23。#1 の決定 6・7）。
 *
 * NDF のリポジトリから、`ndf-pin.json` の固定の点と既定の枝の先端の 2 つのコミットの契約のファイルを取り、
 * 形の正本の NDF の契約の使い方（#2 の書き出し。呼び出しの判定・区間の報告の読み取り・使い方のデータ）と照らす。
 * 照らすことの表は docs/design-process/issue-1/design-detail.md の「NDF の契約の照合」にある。
 *
 *     node tools/checks/src/ndf-contract-check.ts [--root <作業の木>] [--summary <要約のファイル>]
 *     node tools/checks/src/ndf-contract-check.ts sync [--root <作業の木>]
 *
 * `sync` は、固定の点の契約から使い方の生成のファイル（`GENERATED_PATH`）を書き直す（#136 の決定 5）。
 * 終了コード: 0 書いた、1 手で書く id が契約に無いなど生成できない、2 引数の誤り・読めない・取得できない・書けない。
 *
 * 終了コード: 0 固定の点で食い違いが無い（先端の食い違いは要約に並べるだけ）、1 固定の点で食い違う・
 * 使い方が要るのに書き出しが無い、2 引数の誤り・固定の点の契約を読めない・使い方の書き出しの形が違う。
 */

import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";

import {
  ndfContractUseData,
  ndfContractUseGenerated,
  type NdfContractUseGenerated,
  type NdfEntrypointRow,
} from "@nd-factory/contracts/ndf-contract-use-schema";

/** NDF のリポジトリ（実行の文書の「NDF との契約」） */
export const NDF_REPO_URL = "https://github.com/devbasex/ai-plugins";

/** NDF のリポジトリの中の契約の置き場（`C/`） */
export const CONTRACT_DIR = "plugins/ndf/contracts";

/**
 * NDF の契約の使い方の書き出しが要るか。#2 が書き出しを置く Pull Request で真にし、偽へ戻さない。
 * 偽の間は書き出しが無いと 1〜6 を照らさずに `skip: no-contract-use` で通し、真の後は `fail: no-contract-use` で落ちる
 */
export const CONTRACT_USE_REQUIRED = false;

/** NDF の契約の使い方の書き出し（#2 が置く。K2-6）。書き出しの `ndfContractUse` が `NdfContractUse` の形 */
export const CONTRACT_USE_EXPORT = "@nd-factory/contracts/ndf-contract-use";

/** 使い方の生成のファイル（作業の木の根からの相対パス）。生成のコマンドだけが書く */
export const GENERATED_PATH = "packages/contracts/data/ndf-contract-use.generated.json";

/** 使い方の手で書くデータ（作業の木の根からの相対パス） */
export const USE_DATA_PATH = "packages/contracts/data/ndf-contract-use.json";

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

type ContractPath = (typeof CONTRACT_PATHS)[number];

/** 取るコミット。固定の点はコミットを、先端はリポジトリの既定の枝（`HEAD` が指す枝）を引く */
export type ContractRev = { kind: "fixed"; commit: string } | { kind: "tip" };

/** 1 つのコミットの契約のファイル。`json` の鍵は `C/` からの相対パス */
export type ContractFiles = { commit: string; json: Record<string, unknown> };

/** 照らすことの番号（設計の表の 1〜6） */
export type CheckNumber = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * 区間の報告の結果の値ごとの要る項目。`always` は無条件に要る項目、`when` は条件つきで要る項目。
 * `when` の行は `need` のほかの鍵（`item`・`prefix`・`equals` など）が条件で、条件ごと照らす
 */
export type ReportRequiredRule = {
  always: readonly string[];
  when: readonly ({ item: string; need: readonly string[] } & Readonly<Record<string, unknown>>)[];
};

/** 食い違い。`path` は NDF のリポジトリの中の契約のファイルのパス、`id` は見本の id か配列の位置 */
export type ContractFinding = { check: CheckNumber; path: string; id?: string; detail: string };

/**
 * NDF の契約の使い方（#2 の書き出しから写す型。#2 が書き出しを置くときに、この型と書き出しを合わせる）。
 * ランナー（#6）と照合の両方が同じ判定とデータを使う（決定 7）
 */
export type NdfContractUse = {
  /** 受ける契約の版と sha256 の組（照らすこと 2） */
  acceptedVersions: readonly { version: number; sha256: string }[];
  /** 使う口（`entrypoints.json` の id。照らすこと 6） */
  entrypoints: readonly string[];
  /** 口と実行の場（ホステッド・手元のマシン）の組ごとの渡す環境変数の名前（照らすこと 3） */
  env: readonly { entrypoint: string; site: "hosted" | "local"; names: readonly string[] }[];
  /**
   * 渡す名前のうち `env.json` の `set_by` が `service` でない名前と、その名前の契約の `set_by` の値（照らすこと 3）。
   * ランナーが利用者に代わって取得して渡す資格情報（`GH_TOKEN` は `user`）と、ランナーが利用者に代わって
   * レーンの作業場所の下を指す状態の保存先の根（`NDF_STATE_HOME` は `user`）を載せる。
   * 載せた名前は契約の `set_by` が同じ値でなければ、載せない名前は `service` でなければ食い違い
   */
  envSetBy: Readonly<Record<string, string>>;
  /** 読むファイル（`ndf-files.json` の id）と、翻訳が読む項目（照らすこと 4） */
  files: readonly { id: string; fields: readonly string[] }[];
  /** 区間の報告から読む値と項目（照らすこと 5） */
  report: {
    values: readonly string[];
    items: readonly string[];
    /** 結果の値ごとに、ランナーが要るとして読む項目（無条件と条件つき） */
    required: Readonly<Record<string, ReportRequiredRule>>;
    /** 読む `shape.material` の鍵と値 */
    material: Readonly<Record<string, string>>;
  };
  /** ランナーが NDF を起こす前に通す呼び出しの判定（照らすこと 1） */
  judgeCall: (call: { entrypoint: string; call: string; env: readonly string[] }) => boolean;
  /** 区間の報告の読み取り（照らすこと 5） */
  readReport: (text: string) => { result: string; errors: readonly string[] };
};

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
const SCHEMAS = {
  "version.json": z.object({ history: z.array(z.object({ version: z.number(), sha256: z.string() })) }),
  "domains/entrypoint-cases.json": rowsOf(
    z.object({ id: z.string(), entrypoint: z.string(), call: z.string(), env: strings, valid: z.boolean() }),
  ),
  "domains/entrypoints.json": rowsOf(
    z.object({
      id: z.string(),
      kind: z.string(),
      target: z.string(),
      lead: z.string().optional(),
      args: strings.optional(),
      env: strings,
      files: strings.optional(),
    }),
  ),
  "domains/env.json": rowsOf(z.object({ id: z.string(), set_by: z.string() })),
  "domains/ndf-files.json": rowsOf(
    z.object({ id: z.string(), path: z.string(), reader: z.string().optional(), fields: strings.optional() }),
  ),
  "hooks/unattended-report.json": z.object({
    shape: z.object({
      values: z.record(z.string(), z.unknown()),
      items: strings,
      material: z.record(z.string(), z.unknown()),
      required: z.record(
        z.string(),
        // 条件の鍵（item・prefix・equals など）を捨てずに残し、条件ごと照らして差分に出す
        z.object({ always: strings, when: z.array(z.object({ item: z.string(), need: strings }).catchall(z.unknown())) }),
      ),
    }),
    cases: z.array(z.object({ text: z.string(), result: z.string(), errors: strings })),
  }),
} satisfies Record<ContractPath, z.ZodType>;

type Parsed<P extends ContractPath> = z.infer<(typeof SCHEMAS)[P]>;

/** 契約のファイルを照合が読む形で読む。読めなければ食い違いを足して null */
function read<P extends ContractPath>(
  files: ContractFiles,
  path: P,
  check: CheckNumber,
  findings: ContractFinding[],
): Parsed<P> | null {
  const result = SCHEMAS[path].safeParse(files.json[path]);
  if (result.success) return result.data as Parsed<P>;
  const where = result.error.issues[0]?.path.join(".") ?? "";
  findings.push({ check, path: `${CONTRACT_DIR}/${path}`, detail: `契約のファイルの形が読めない（${where}）` });
  return null;
}

function missing(wanted: readonly string[], have: Iterable<string>): string[] {
  const set = new Set(have);
  return wanted.filter((name) => !set.has(name));
}

function list(names: readonly string[]): string {
  return names.join(", ");
}

/** 使い方の生成のファイルを作れない（契約に無い id・契約のファイルの形が読めない） */
export class ContractUseSyncError extends Error {
  name = "ContractUseSyncError";
}

/** 生成のために契約のファイルを読む。読めなければ例外 */
function readForSync<P extends ContractPath>(files: ContractFiles, path: P): Parsed<P> {
  const result = SCHEMAS[path].safeParse(files.json[path]);
  if (result.success) return result.data as Parsed<P>;
  const where = result.error.issues[0]?.path.join(".") ?? "";
  throw new ContractUseSyncError(`契約のファイルの形が読めない: ${CONTRACT_DIR}/${path}（${where}）`);
}

/** 契約の行から、使い方が持つ列（id と 6 つの列）だけを決まった順で取り出す */
function entrypointRow(row: Parsed<"domains/entrypoints.json">["rows"][number]): NdfEntrypointRow {
  return {
    id: row.id,
    kind: row.kind,
    target: row.target,
    ...(row.lead === undefined ? {} : { lead: row.lead }),
    ...(row.args === undefined ? {} : { args: row.args }),
    env: row.env,
    ...(row.files === undefined ? {} : { files: row.files }),
  };
}

/**
 * 契約のファイルから、手で書く id の行と、その行の `files` が指す読むファイルの `path` と、区間の報告の形を取り出す。
 * 行は手で書く id の順、読むファイルは最初に現れた順に並べ、生成し直しても差分が出ないようにする
 */
export function generateContractUse(files: ContractFiles, ids: readonly string[]): NdfContractUseGenerated {
  const entrypoints = readForSync(files, "domains/entrypoints.json");
  const ndfFiles = readForSync(files, "domains/ndf-files.json");
  const report = readForSync(files, "hooks/unattended-report.json");
  const absent = missing(ids, entrypoints.rows.map((row) => row.id));
  if (absent.length > 0) throw new ContractUseSyncError(`契約の entrypoints.json に無い id: ${list(absent)}`);
  const rows = ids.flatMap((id) => entrypoints.rows.filter((row) => row.id === id).slice(0, 1).map(entrypointRow));
  const fileIds = [...new Set(rows.flatMap((row) => row.files ?? []))];
  const paths = fileIds.flatMap((id) => ndfFiles.rows.filter((row) => row.id === id).slice(0, 1).map((row) => ({ id, path: row.path })));
  const noPath = missing(fileIds, paths.map((p) => p.id));
  if (noPath.length > 0) throw new ContractUseSyncError(`契約の ndf-files.json に無い読むファイル: ${list(noPath)}`);
  const parsed = ndfContractUseGenerated.safeParse({
    commit: files.commit,
    entrypoints: rows,
    files: paths,
    report: { values: Object.keys(report.shape.values), required: report.shape.required, material: report.shape.material },
  });
  if (!parsed.success) {
    throw new ContractUseSyncError(`生成のデータが形に合わない（${parsed.error.issues[0]?.path.join(".") ?? ""}）`);
  }
  return parsed.data;
}

/** 1: 見本を呼び出しの判定へ通し、`valid` と同じ判定になる。見本の口が口の表にある */
function checkCases(files: ContractFiles, use: NdfContractUse, findings: ContractFinding[]): void {
  const cases = read(files, "domains/entrypoint-cases.json", 1, findings);
  const entrypoints = read(files, "domains/entrypoints.json", 1, findings);
  if (cases === null || entrypoints === null) return;
  const path = `${CONTRACT_DIR}/domains/entrypoint-cases.json`;
  const ids = new Set(entrypoints.rows.map((row) => row.id));
  for (const row of cases.rows) {
    if (!ids.has(row.entrypoint)) {
      findings.push({ check: 1, path, id: row.id, detail: `見本の口 ${row.entrypoint} が口の表に無い` });
      continue;
    }
    let judged: boolean;
    try {
      judged = use.judgeCall({ entrypoint: row.entrypoint, call: row.call, env: row.env });
    } catch (error) {
      findings.push({ check: 1, path, id: row.id, detail: `呼び出しの判定が例外を投げた: ${(error as Error).message}` });
      continue;
    }
    if (judged !== row.valid) {
      findings.push({ check: 1, path, id: row.id, detail: `呼び出しの判定が ${judged} で、見本の valid ${row.valid} と違う` });
    }
  }
}

/** 2: `version.json` の `history` の最後の行（版と sha256）が受ける組にある */
function checkVersion(files: ContractFiles, use: NdfContractUse, findings: ContractFinding[]): void {
  const version = read(files, "version.json", 2, findings);
  if (version === null) return;
  const path = `${CONTRACT_DIR}/version.json`;
  const last = version.history.at(-1);
  if (last === undefined) {
    findings.push({ check: 2, path, detail: "history が空" });
    return;
  }
  const accepted = use.acceptedVersions.some((pair) => pair.version === last.version && pair.sha256 === last.sha256);
  if (!accepted) {
    findings.push({
      check: 2,
      path,
      id: String(version.history.length - 1),
      detail: `最後の行（版 ${last.version}・sha256 ${last.sha256}）が受ける組に無い`,
    });
  }
}

/**
 * 3: 口と実行の場の組ごとの渡す環境変数の名前が、その口の `env` 列にあり、`env.json` の行にある。
 * 使い方の `envSetBy` に載せた名前は `set_by` がその値と同じで（`GH_TOKEN`・`NDF_STATE_HOME` の `user`）、
 * 載せない名前は `set_by` が `service` である
 */
function checkEnv(files: ContractFiles, use: NdfContractUse, findings: ContractFinding[]): void {
  const entrypoints = read(files, "domains/entrypoints.json", 3, findings);
  const env = read(files, "domains/env.json", 3, findings);
  if (entrypoints === null || env === null) return;
  const setBy = new Map(env.rows.map((row) => [row.id, row.set_by]));
  for (const pair of use.env) {
    const id = `${pair.entrypoint}/${pair.site}`;
    const row = entrypoints.rows.find((r) => r.id === pair.entrypoint);
    if (row === undefined) {
      findings.push({ check: 3, path: `${CONTRACT_DIR}/domains/entrypoints.json`, id, detail: "口が口の表に無い" });
      continue;
    }
    const notInColumn = missing(pair.names, row.env);
    if (notInColumn.length > 0) {
      findings.push({
        check: 3,
        path: `${CONTRACT_DIR}/domains/entrypoints.json`,
        id,
        detail: `口の env 列に無い名前: ${list(notInColumn)}`,
      });
    }
    const notKnown: string[] = [];
    const otherSetter: string[] = [];
    for (const name of pair.names) {
      const actual = setBy.get(name);
      if (actual === undefined) {
        notKnown.push(name);
        continue;
      }
      // envSetBy に載せた名前は契約の値との一致を先に照らす（user から service へ変わっても見逃さない）。
      // 載せない名前だけに service を求める
      const declared = Object.hasOwn(use.envSetBy, name) ? use.envSetBy[name] : undefined;
      const expected = declared ?? "service";
      if (actual !== expected) {
        otherSetter.push(`${name}（set_by: ${actual}${declared === undefined ? "" : `。使い方は ${declared}`}）`);
      }
    }
    if (notKnown.length > 0) {
      findings.push({ check: 3, path: `${CONTRACT_DIR}/domains/env.json`, id, detail: `env.json に無い名前: ${list(notKnown)}` });
    }
    if (otherSetter.length > 0) {
      findings.push({
        check: 3,
        path: `${CONTRACT_DIR}/domains/env.json`,
        id,
        detail: `set_by が使い方の envSetBy の値（載せない名前は service）と違う名前: ${list(otherSetter)}`,
      });
    }
  }
}

/** 4: 読むファイルの行が `reader: service` であり、その `fields` が翻訳が読む項目を含む */
function checkFiles(files: ContractFiles, use: NdfContractUse, findings: ContractFinding[]): void {
  const ndfFiles = read(files, "domains/ndf-files.json", 4, findings);
  if (ndfFiles === null) return;
  const path = `${CONTRACT_DIR}/domains/ndf-files.json`;
  for (const wanted of use.files) {
    const row = ndfFiles.rows.find((r) => r.id === wanted.id);
    if (row === undefined) {
      findings.push({ check: 4, path, id: wanted.id, detail: "読むファイルの行が無い" });
      continue;
    }
    if (row.reader !== "service") {
      findings.push({ check: 4, path, id: wanted.id, detail: `reader が service でない（${row.reader ?? "無し"}）` });
    }
    const lacking = missing(wanted.fields, row.fields ?? []);
    if (lacking.length > 0) {
      findings.push({ check: 4, path, id: wanted.id, detail: `fields に無い項目: ${list(lacking)}` });
    }
  }
}

/**
 * 5: 区間の報告の `shape` がランナーが読む値と項目を含み、`cases` の見本を区間の報告の読み取りへ通して
 * `result` と `errors` の有無が同じ判定になる
 */
function checkReport(files: ContractFiles, use: NdfContractUse, findings: ContractFinding[]): void {
  const report = read(files, "hooks/unattended-report.json", 5, findings);
  if (report === null) return;
  const path = `${CONTRACT_DIR}/hooks/unattended-report.json`;
  const { shape } = report;
  const shapeFinding = (detail: string) => findings.push({ check: 5, path, detail });
  const values = missing(use.report.values, Object.keys(shape.values));
  if (values.length > 0) shapeFinding(`shape.values に無い値: ${list(values)}`);
  const items = missing(use.report.items, shape.items);
  if (items.length > 0) shapeFinding(`shape.items に無い項目: ${list(items)}`);
  for (const value of use.report.values) {
    if (!Object.hasOwn(shape.required, value)) shapeFinding(`shape.required に値 ${value} が無い`);
  }
  for (const [value, wanted] of Object.entries(use.report.required)) {
    const rule = shape.required[value] ?? { always: [], when: [] };
    const always = missing(wanted.always, rule.always);
    if (always.length > 0) shapeFinding(`shape.required.${value}.always が無条件に要るとしない項目: ${list(always)}`);
    for (const want of wanted.when) {
      const key = conditionKey(want);
      const same = rule.when.filter((w) => conditionKey(w) === key).flatMap((w) => w.need);
      const lacking = missing(want.need, [...rule.always, ...same]);
      if (lacking.length > 0) shapeFinding(`shape.required.${value}.when が条件 ${key} で要るとしない項目: ${list(lacking)}`);
    }
  }
  for (const [key, wanted] of Object.entries(use.report.material)) {
    const have = shape.material[key];
    if (have !== wanted) shapeFinding(`shape.material.${key} が ${JSON.stringify(wanted)} でない（${JSON.stringify(have ?? null)}）`);
  }
  checkReportCases(report.cases, use, path, findings);
}

/** 5 のうち、`cases` の見本を区間の報告の読み取りへ通し、`result` と `errors` の有無が見本と同じ判定になるかを照らす */
function checkReportCases(
  cases: Parsed<"hooks/unattended-report.json">["cases"],
  use: NdfContractUse,
  path: string,
  findings: ContractFinding[],
): void {
  cases.forEach((sample, index) => {
    let got: { result: string; errors: readonly string[] };
    try {
      got = use.readReport(sample.text);
    } catch (error) {
      findings.push({ check: 5, path, id: String(index), detail: `区間の報告の読み取りが例外を投げた: ${(error as Error).message}` });
      return;
    }
    const sameErrors = got.errors.length > 0 === sample.errors.length > 0;
    if (got.result !== sample.result || !sameErrors) {
      findings.push({
        check: 5,
        path,
        id: String(index),
        detail: `読み取りが result ${JSON.stringify(got.result)}・errors ${got.errors.length} 件で、見本の result ${JSON.stringify(sample.result)}・errors ${sample.errors.length} 件と違う`,
      });
    }
  });
}

/** `when` の行の条件（`need` のほかの鍵）を、鍵の順によらない文字列にする */
function conditionKey(rule: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(rule)
    .filter(([key]) => key !== "need")
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));
  return JSON.stringify(Object.fromEntries(entries));
}

/** 6: 使う口がすべて契約の口の表にある */
function checkEntrypoints(files: ContractFiles, use: NdfContractUse, findings: ContractFinding[]): void {
  const entrypoints = read(files, "domains/entrypoints.json", 6, findings);
  if (entrypoints === null) return;
  const path = `${CONTRACT_DIR}/domains/entrypoints.json`;
  for (const id of missing(use.entrypoints, entrypoints.rows.map((row) => row.id))) {
    findings.push({ check: 6, path, id, detail: "使う口が口の表に無い" });
  }
}

/** 照らすこと 1〜6 を照らし、食い違いを返す。使い方が null なら照らさない */
export function compareContract(files: ContractFiles, use: NdfContractUse | null): ContractFinding[] {
  if (use === null) return [];
  const findings: ContractFinding[] = [];
  checkCases(files, use, findings);
  checkVersion(files, use, findings);
  checkEnv(files, use, findings);
  checkFiles(files, use, findings);
  checkReport(files, use, findings);
  checkEntrypoints(files, use, findings);
  return findings;
}

/**
 * 食い違いにしない知らせの行。`ask-journal` の行が `fields` を持つようになったら出す（#41 の決定 106 の答えを知るため）。
 * 形が読めないときは何も出さない（食い違いは照らすこと 4 が出す）
 */
export function contractNotices(files: ContractFiles): string[] {
  const parsed = SCHEMAS["domains/ndf-files.json"].safeParse(files.json["domains/ndf-files.json"]);
  if (!parsed.success) return [];
  const row = parsed.data.rows.find((r) => r.id === "ask-journal");
  if (row?.fields === undefined) return [];
  return [`notice: ${files.commit} の ask-journal が fields を持つ: ${list(row.fields)}（#41 の決定 106）`];
}

/** 先端の区間の報告の `shape` を固定の点と比べ、差分の行を返す（通っても並べる） */
export function reportShapeDiff(fixed: ContractFiles, tip: ContractFiles): string[] {
  const schema = SCHEMAS["hooks/unattended-report.json"];
  const before = schema.safeParse(fixed.json["hooks/unattended-report.json"]);
  const after = schema.safeParse(tip.json["hooks/unattended-report.json"]);
  if (!before.success || !after.success) return [];
  const lines: string[] = [];
  const setDiff = (name: string, old: string[], now: string[]) => {
    const added = missing(now, old);
    const removed = missing(old, now);
    if (added.length > 0) lines.push(`diff: ${name} に足された: ${list(added)}`);
    if (removed.length > 0) lines.push(`diff: ${name} から消えた: ${list(removed)}`);
  };
  const a = before.data.shape;
  const b = after.data.shape;
  setDiff("shape.values", Object.keys(a.values), Object.keys(b.values));
  setDiff("shape.items", a.items, b.items);
  setDiff("shape.required", Object.keys(a.required), Object.keys(b.required));
  // 足された・消えた値と条件も、片側を空として always と条件ごとの need の差分を出す
  type Rule = (typeof a.required)[string];
  const empty: Rule = { always: [], when: [] };
  const needs = (rules: Rule["when"]) => {
    const byKey = new Map<string, string[]>();
    for (const rule of rules) byKey.set(conditionKey(rule), [...(byKey.get(conditionKey(rule)) ?? []), ...rule.need]);
    return byKey;
  };
  const valueNames = [...new Set([...Object.keys(a.required), ...Object.keys(b.required)])];
  for (const value of valueNames) {
    const old = (Object.hasOwn(a.required, value) ? a.required[value] : undefined) ?? empty;
    const now = (Object.hasOwn(b.required, value) ? b.required[value] : undefined) ?? empty;
    setDiff(`shape.required.${value}.always`, old.always, now.always);
    const oldWhen = needs(old.when);
    const nowWhen = needs(now.when);
    setDiff(`shape.required.${value}.when の条件`, [...oldWhen.keys()], [...nowWhen.keys()]);
    for (const key of new Set([...oldWhen.keys(), ...nowWhen.keys()])) {
      setDiff(`shape.required.${value}.when の条件 ${key} の need`, oldWhen.get(key) ?? [], nowWhen.get(key) ?? []);
    }
  }
  setDiff("shape.material", Object.keys(a.material), Object.keys(b.material));
  for (const key of Object.keys(b.material)) {
    if (Object.hasOwn(a.material, key) && JSON.stringify(a.material[key]) !== JSON.stringify(b.material[key])) {
      lines.push(`diff: shape.material.${key} が変わった: ${JSON.stringify(a.material[key])} から ${JSON.stringify(b.material[key])}`);
    }
  }
  return lines;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

/** 要約の Markdown。行（`checked:`・`skip:`・知らせ・差分）、固定の点と先端の食い違いの表を並べる */
export function renderSummary(fixed: ContractFinding[], tip: ContractFinding[] | null, notes: string[]): string {
  const out = ["## NDF の契約の照合", ""];
  for (const note of notes) out.push(`- ${cell(note)}`);
  if (tip === null) out.push("- 先端は照らさなかった（既定の枝の先端の契約を読めなかった）");
  out.push("");
  const rows = [
    ...fixed.map((f) => ({ where: "固定の点", f })),
    ...(tip ?? []).map((f) => ({ where: "先端", f })),
  ];
  if (rows.length === 0) {
    out.push("食い違いの行は無い。", "");
    return out.join("\n");
  }
  out.push("| 照らした先 | # | 契約のファイル | 見本の id | 食い違い |", "| --- | --- | --- | --- | --- |");
  for (const { where, f } of rows) {
    out.push(`| ${where} | ${f.check} | ${cell(f.path)} | ${cell(f.id ?? "")} | ${cell(f.detail)} |`);
  }
  out.push("");
  return out.join("\n");
}

function isContractUse(value: unknown): value is NdfContractUse {
  if (value === null || typeof value !== "object") return false;
  const use = value as Record<string, unknown>;
  const report = use.report as Record<string, unknown> | null | undefined;
  return (
    Array.isArray(use.acceptedVersions) &&
    Array.isArray(use.entrypoints) &&
    Array.isArray(use.env) &&
    typeof use.envSetBy === "object" &&
    use.envSetBy !== null &&
    Array.isArray(use.files) &&
    typeof report === "object" &&
    report !== null &&
    Array.isArray(report.values) &&
    Array.isArray(report.items) &&
    typeof report.required === "object" &&
    typeof report.material === "object" &&
    typeof use.judgeCall === "function" &&
    typeof use.readReport === "function"
  );
}

/** 書き出しのパッケージの名前（`@nd-factory/contracts`） */
const CONTRACT_USE_PACKAGE = CONTRACT_USE_EXPORT.split("/").slice(0, 2).join("/");

function isInside(realRoot: string, path: string): boolean {
  const inside = relative(realRoot, path);
  return !(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside));
}

/**
 * 作業の木（`--root`）から使い方の書き出しを解決して読む。固定の点と同じ作業の木の書き出しを照らすため、
 * このスクリプトの置き場からは解決しない。
 * 先にパッケージ本体を Node と同じ探し方（`node_modules` を上へ辿る）で引き、作業の木の内側にあることを確かめる。
 * 引けない・作業の木の外なら例外。そのパッケージ自身が書き出しを持たないときだけ null を返す
 * （書き出しの読み込みの中から出た例外はそのまま投げ、書き出しが無い扱いにしない）
 */
export function contractUseLoaderFrom(root: string): () => Promise<unknown> {
  return async () => {
    const realRoot = await realpath(root);
    const require = createRequire(join(realRoot, "package.json"));
    let packageDir: string | undefined;
    for (const dir of require.resolve.paths(CONTRACT_USE_PACKAGE) ?? []) {
      try {
        packageDir = await realpath(join(dir, CONTRACT_USE_PACKAGE));
        break;
      } catch {
        // この node_modules には無い。上へ辿る
      }
    }
    if (packageDir === undefined) {
      throw new Error(`作業の木 ${realRoot} から ${CONTRACT_USE_PACKAGE} を引けない`);
    }
    if (!isInside(realRoot, packageDir)) {
      throw new Error(`${CONTRACT_USE_PACKAGE} が作業の木 ${realRoot} の外へ解決された: ${packageDir}`);
    }
    const manifest: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    const name = (manifest as { name?: unknown } | null)?.name;
    if (name !== CONTRACT_USE_PACKAGE) {
      throw new Error(`${packageDir} の package.json の name が ${CONTRACT_USE_PACKAGE} でない: ${String(name)}`);
    }
    // 本体の package.json から自分の名前で引き（自己参照）、上で確かめたパッケージの書き出しだけを解決する。
    // 解決はコードを動かさないため、ここで出る ERR_PACKAGE_PATH_NOT_EXPORTED はこのパッケージ自身に書き出しが無いことを指す
    let target: string;
    try {
      target = createRequire(join(packageDir, "package.json")).resolve(CONTRACT_USE_EXPORT);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return null;
      throw error;
    }
    const resolved = await realpath(target);
    if (!isInside(realRoot, resolved)) {
      throw new Error(`${CONTRACT_USE_EXPORT} が作業の木 ${realRoot} の外へ解決された: ${resolved}`);
    }
    return import(pathToFileURL(resolved).href);
  };
}

/**
 * NDF の契約の使い方の書き出しを読む。`load` が null を返せば（パッケージに書き出しが無い）null、
 * パッケージ自体を引けない・読み込みが失敗する・形が違えば例外
 */
export async function loadContractUse(load: () => Promise<unknown>): Promise<NdfContractUse | null> {
  const mod = await load();
  if (mod === null) return null;
  const use = (mod as { ndfContractUse?: unknown } | null)?.ndfContractUse;
  if (!isContractUse(use)) {
    throw new Error(`${CONTRACT_USE_EXPORT} の ndfContractUse が NDF の契約の使い方の形でない`);
  }
  return use;
}

/** 作業の木の `ndf-pin.json` から固定の点のコミットを読む */
async function readPinnedCommit(root: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(join(root, PIN_FILE), "utf8"));
  const commit = (parsed as Record<string, unknown> | null)?.[PIN_KEY];
  if (typeof commit !== "string") throw new Error(`${PIN_FILE} に固定の点のキーの文字列が無い`);
  return commit;
}

function formatFinding(where: "fixed" | "tip", f: ContractFinding): string {
  return `mismatch: ${where} ${f.check} ${f.path}${f.id === undefined ? "" : ` ${f.id}`}: ${f.detail}`;
}

/** テストが差し替える依存。省けば本物の NDF のリポジトリ・書き出し・定数を使う */
export type MainOptions = {
  repoUrl?: string;
  /** 作業の木を受けて使い方を読む。省けば作業の木から書き出しを解決する */
  loadUse?: (root: string) => Promise<NdfContractUse | null>;
  required?: boolean;
};

/** 取得・照らし・要約・終了コードをつなぐ */
export async function mainNdfContractCheck(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: MainOptions = {},
): Promise<number> {
  let rootArg: string | undefined;
  let summaryPath: string | undefined;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { root: { type: "string" }, summary: { type: "string" } },
      strict: true,
    });
    rootArg = values.root;
    summaryPath = values.summary;
  } catch (error) {
    process.stderr.write(`usage: ndf-contract [--root <作業の木>] [--summary <要約のファイル>]: ${(error as Error).message}\n`);
    return 2;
  }
  const root = resolve(rootArg ?? process.cwd());
  const repoUrl = options.repoUrl ?? NDF_REPO_URL;

  let pinned: string;
  try {
    pinned = await readPinnedCommit(root);
  } catch (error) {
    process.stderr.write(`error: 固定の点を読めない: ${(error as Error).message}: ${root}\n`);
    return 2;
  }

  let use: NdfContractUse | null;
  try {
    use = await (options.loadUse ?? ((dir: string) => loadContractUse(contractUseLoaderFrom(dir))))(root);
  } catch (error) {
    process.stderr.write(`error: NDF の契約の使い方の書き出しを読めない: ${(error as Error).message}\n`);
    return 2;
  }

  const work = await mkdtemp(join(env.RUNNER_TEMP ?? tmpdir(), "ndf-contract-"));
  try {
    let fixed: ContractFiles;
    try {
      fixed = await fetchContract({ kind: "fixed", commit: pinned }, repoUrl, join(work, "fixed"));
    } catch (error) {
      if (!(error instanceof ContractFetchError)) throw error;
      process.stderr.write(`error: 固定の点 ${pinned} の契約を読めない: ${error.message}\n`);
      return 2;
    }
    let tip: ContractFiles | null = null;
    try {
      tip = await fetchContract({ kind: "tip" }, repoUrl, join(work, "tip"));
    } catch (error) {
      if (!(error instanceof ContractFetchError)) throw error;
      process.stderr.write(`warning: 既定の枝の先端の契約を読めず、先端は照らさなかった: ${error.message}\n`);
    }

    const required = options.required ?? CONTRACT_USE_REQUIRED;
    // 読めたコミットを先に出す（使い方が無く 1〜6 を照らさないときも、どのコミットの契約を読んだかを残す）
    const lines = [`read: fixed ${fixed.commit}`, ...(tip === null ? [] : [`read: tip ${tip.commit}`])];
    let code = 0;
    let fixedFindings: ContractFinding[] = [];
    let tipFindings: ContractFinding[] | null = tip === null ? null : [];
    if (use === null) {
      lines.push(`${required ? "fail" : "skip"}: no-contract-use ${fixed.commit}`);
      if (required) code = 1;
    } else {
      fixedFindings = compareContract(fixed, use);
      lines.push(`checked: fixed ${fixed.commit} 1-6`);
      if (tip !== null) {
        tipFindings = compareContract(tip, use);
        lines.push(`checked: tip ${tip.commit} 1-6`);
      }
      if (fixedFindings.length > 0) code = 1;
    }
    lines.push(...contractNotices(fixed));
    if (tip !== null) lines.push(...contractNotices(tip), ...reportShapeDiff(fixed, tip));

    const output = [
      ...lines,
      ...fixedFindings.map((f) => formatFinding("fixed", f)),
      ...(tipFindings ?? []).map((f) => formatFinding("tip", f)),
    ];
    process.stdout.write(`${output.join("\n")}\n`);
    if (summaryPath !== undefined) {
      try {
        await appendFile(summaryPath, renderSummary(fixedFindings, tipFindings, lines));
      } catch (error) {
        process.stderr.write(`error: 要約のファイルに書けない: ${(error as Error).message}\n`);
        return 2;
      }
    }
    if (fixedFindings.length > 0) {
      process.stderr.write(`固定の点 ${fixed.commit} の NDF の契約と形の正本が ${fixedFindings.length} 件食い違う\n`);
    } else if (code === 1) {
      process.stderr.write("NDF の契約の使い方の書き出しが要るが、無い\n");
    }
    return code;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** 固定の点の契約を取得し、使い方の生成のファイルを書き直す */
export async function mainNdfContractSync(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: { repoUrl?: string } = {},
): Promise<number> {
  let rootArg: string | undefined;
  try {
    const { values } = parseArgs({ args: argv, options: { root: { type: "string" } }, strict: true });
    rootArg = values.root;
  } catch (error) {
    process.stderr.write(`usage: ndf-contract sync [--root <作業の木>]: ${(error as Error).message}\n`);
    return 2;
  }
  const root = resolve(rootArg ?? process.cwd());

  let pinned: string;
  let ids: readonly string[];
  try {
    pinned = await readPinnedCommit(root);
    // 手で書くデータは形だけを確かめる。生成のファイルと合わせて組み立てる書き出しは読み込まない（食い違っていても直せるように）
    const data = ndfContractUseData.safeParse(JSON.parse(await readFile(join(root, USE_DATA_PATH), "utf8")));
    if (!data.success) throw new Error(`${USE_DATA_PATH} の形が違う: ${z.prettifyError(data.error)}`);
    ids = data.data.entrypoints;
  } catch (error) {
    process.stderr.write(`error: 固定の点か使い方のデータを読めない: ${(error as Error).message}: ${root}\n`);
    return 2;
  }

  const work = await mkdtemp(join(env.RUNNER_TEMP ?? tmpdir(), "ndf-contract-sync-"));
  try {
    let fixed: ContractFiles;
    try {
      fixed = await fetchContract({ kind: "fixed", commit: pinned }, options.repoUrl ?? NDF_REPO_URL, join(work, "fixed"));
    } catch (error) {
      if (!(error instanceof ContractFetchError)) throw error;
      process.stderr.write(`error: 固定の点 ${pinned} の契約を読めない: ${error.message}\n`);
      return 2;
    }
    let generated: NdfContractUseGenerated;
    try {
      generated = generateContractUse(fixed, ids);
    } catch (error) {
      if (!(error instanceof ContractUseSyncError)) throw error;
      process.stderr.write(`error: 生成できない: ${error.message}\n`);
      return 1;
    }
    try {
      await writeFile(join(root, GENERATED_PATH), `${JSON.stringify(generated, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`error: 生成のファイルに書けない: ${(error as Error).message}\n`);
      return 2;
    }
    process.stdout.write(`wrote: ${GENERATED_PATH} ${pinned}\n`);
    return 0;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  process.exitCode =
    args[0] === "sync" ? await mainNdfContractSync(args.slice(1), process.env) : await mainNdfContractCheck(args, process.env);
}
