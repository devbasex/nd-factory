/**
 * NDF の契約の使い方の生成のコマンド（#136 の決定 5）。
 *
 *     node tools/checks/src/ndf-contract-check.ts sync [--root <作業の木>]
 *
 * 固定の点の契約から使い方の生成のファイル（`GENERATED_PATH`）を書き直す。
 * 終了コード: 0 書いた、1 手で書く id が契約に無いなど生成できない、2 引数の誤り・読めない・取得できない・書けない。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

import {
  ndfContractUseData,
  ndfContractUseGenerated,
  type NdfContractUseGenerated,
  type NdfEntrypointRow,
} from "@nd-factory/contracts/ndf-contract-use-schema";

import {
  CONTRACT_DIR,
  ContractFetchError,
  NDF_REPO_URL,
  SCHEMAS,
  fetchContract,
  list,
  missing,
  readPinnedCommit,
  type ContractFiles,
  type ContractPath,
  type Parsed,
} from "./ndf-contract-fetch.ts";

/** 使い方の生成のファイル（作業の木の根からの相対パス）。生成のコマンドだけが書く */
export const GENERATED_PATH = "packages/contracts/data/ndf-contract-use.generated.json";

/** 使い方の手で書くデータ（作業の木の根からの相対パス） */
export const USE_DATA_PATH = "packages/contracts/data/ndf-contract-use.json";

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
