/**
 * 参照の検査。
 *
 * このリポジトリが、作り直す前のリポジトリ（旧い側）を指していないことと、NDF の固定の値の置き方を確かめる。
 *
 * - 照合の語（旧い側のリポジトリの名前・旧い表の名前・旧い状態のバケットの名前）の当たり
 * - NDF の固定の値（JSON のキー）がちょうど 1 か所（`ndf-pin.json`）にあること
 * - NDF の版を読む式と大小の比べが同じ行にあること（版の数字で振る舞いを変えない）
 *
 * 照合の語はリポジトリのファイルに置かない。置いたファイルそのものが当たりになるためである。
 * 環境変数 `REF_CHECK_TERMS`（JSON）から受け、出力には語そのものを出さない。
 *
 *     node tools/ref-check/src/ref-check.ts [--root <作業の木>]
 *
 * 終了コード: 0 当たりなし、1 当たりあり、2 照合の語が要る実行で語が無い・語の形が違う・作業の木を読めない。
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export type MatchTerms = { repo: string[]; tables: string[]; buckets: string[] };
export type Violation = { kind: string; file: string; line: number };
export type GrepHit = { file: string; line: number; text: string };

export class RefCheckError extends Error {
  name = "RefCheckError";
}

const TERM_KINDS = ["repo", "tables", "buckets"] as const;

/** 固定の値を置く唯一のファイル */
export const PIN_FILE = "ndf-pin.json";

// 固定の値のキー。版を読む式の正規表現と同じ行に置かない（この行自身が版の比べに当たらないように）
const PIN_KEY = "ndf_ref";

/** NDF の版を読む式 */
export const VERSION_READ = "ndf_ref|NDF_VERSION|plugin\\.json";

/** 大小の比べ（比べの演算子・版の比べの関数） */
export const VERSION_COMPARE =
  /[<>]=?|semver\.(gt|lt|gte|lte|satisfies)|compareVersions|localeCompare/;

/** 照合の語を環境変数から読む。無いか空なら null */
export function loadMatchTerms(env: NodeJS.ProcessEnv): MatchTerms | null {
  const raw = env.REF_CHECK_TERMS;
  if (raw === undefined || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RefCheckError("照合の語（REF_CHECK_TERMS）が JSON でない");
  }
  const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const missing: string[] = [];
  const terms: MatchTerms = { repo: [], tables: [], buckets: [] };
  for (const kind of TERM_KINDS) {
    const value = record[kind];
    const words = Array.isArray(value)
      ? value.filter((w): w is string => typeof w === "string" && w.trim() !== "")
      : [];
    if (words.length === 0 || !Array.isArray(value) || words.length !== value.length) {
      missing.push(kind);
    } else {
      terms[kind] = words;
    }
  }
  if (missing.length > 0) {
    throw new RefCheckError(`照合の語に欠けた種類がある: ${missing.join(", ")}`);
  }
  return terms;
}

/** `git grep -z -n -I` を打ち、当たりをファイル・行・中身に分ける */
export function gitGrep(root: string, args: string[]): Promise<GrepHit[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", root, "grep", "-z", "-n", "-I", "--no-color", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on("error", (error) => reject(new RefCheckError(`git を起動できない: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 1) return resolvePromise([]);
      if (code !== 0) return reject(new RefCheckError(`git grep が失敗した（終了コード ${code}）`));
      const hits: GrepHit[] = [];
      for (const record of Buffer.concat(chunks).toString("utf8").split("\n")) {
        if (record === "") continue;
        // -z の形: <ファイル>\0<行>\0<中身>
        const first = record.indexOf("\0");
        const second = record.indexOf("\0", first + 1);
        if (first < 0 || second < 0) continue;
        hits.push({
          file: record.slice(0, first),
          line: Number(record.slice(first + 1, second)),
          text: record.slice(second + 1),
        });
      }
      resolvePromise(hits);
    });
  });
}

/** 照合の語の当たりを追跡しているすべてのファイルから集める。語そのものは返さない */
export async function findOldRefs(root: string, terms: MatchTerms): Promise<Violation[]> {
  const found: Violation[] = [];
  for (const kind of TERM_KINDS) {
    for (const term of terms[kind]) {
      for (const hit of await gitGrep(root, ["-F", "-i", "-e", term])) {
        found.push({ kind: `old-ref:${kind}`, file: hit.file, line: hit.line });
      }
    }
  }
  return found;
}

/** NDF の固定の値が、追跡している JSON のファイルでちょうど 1 か所（ndf-pin.json）にあるかを確かめる */
export async function findNdfPins(root: string): Promise<Violation[]> {
  const hits = await gitGrep(root, ["-F", "-e", `"${PIN_KEY}"`, "--", "*.json"]);
  if (hits.length === 1 && hits[0]?.file === PIN_FILE) return [];
  if (hits.length === 0) return [{ kind: "ndf-pin", file: PIN_FILE, line: 0 }];
  const places = hits.map((hit) => `${hit.file}:${hit.line}`).join(",");
  return [{ kind: "ndf-pin", file: places, line: 0 }];
}

/** NDF の版を読む式と大小の比べが同じ行にある行を集める */
export async function findVersionCompare(root: string): Promise<Violation[]> {
  const hits = await gitGrep(root, ["-E", "-e", VERSION_READ]);
  return hits
    .filter((hit) => VERSION_COMPARE.test(hit.text))
    .map((hit) => ({ kind: "version-compare", file: hit.file, line: hit.line }));
}

function formatViolation(v: Violation): string {
  return v.line > 0 ? `${v.kind}\t${v.file}:${v.line}` : `${v.kind}\t${v.file}`;
}

/** 3 つの検査を打ち、当たりを出して終了コードを返す */
export async function mainRefCheck(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let rootArg: string | undefined;
  try {
    const { values } = parseArgs({ args: argv, options: { root: { type: "string" } }, strict: true });
    rootArg = values.root;
  } catch (error) {
    process.stderr.write(`usage: ref-check [--root <作業の木>]: ${(error as Error).message}\n`);
    return 2;
  }
  const root = resolve(rootArg ?? process.cwd());

  let terms: MatchTerms | null;
  try {
    terms = loadMatchTerms(env);
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    return 2;
  }
  if (terms === null && env.REF_CHECK_REQUIRE_TERMS === "1") {
    process.stderr.write("error: この実行は照合の語（REF_CHECK_TERMS）が要るが、渡されていない\n");
    return 2;
  }

  const found: Violation[] = [];
  try {
    if (terms === null) {
      process.stdout.write("skip: 照合の語が無いため、旧い側の名前の照合を飛ばした（固定の値と版の比べは確かめる）\n");
    } else {
      found.push(...(await findOldRefs(root, terms)));
    }
    found.push(...(await findNdfPins(root)));
    found.push(...(await findVersionCompare(root)));
  } catch (error) {
    if (error instanceof RefCheckError) {
      process.stderr.write(`error: ${error.message}: ${root}\n`);
      return 2;
    }
    throw error;
  }

  for (const v of found) process.stdout.write(`${formatViolation(v)}\n`);
  if (found.length > 0) {
    process.stderr.write(`参照の検査の当たりが ${found.length} 件ある（当たった語そのものは出していない）\n`);
    return 1;
  }
  process.stdout.write("ok: 参照の検査の当たりは無い\n");
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await mainRefCheck(process.argv.slice(2), process.env);
}
