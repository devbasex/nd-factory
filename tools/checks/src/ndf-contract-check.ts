/**
 * NDF の契約の照合（F23。#1 の決定 6・7、#136 の決定 4・5・6）。
 *
 * NDF のリポジトリから、`ndf-pin.json` の固定の点と既定の枝の先端の 2 つのコミットの契約のファイルを取り、
 * 形の正本の NDF の契約の使い方（`@nd-factory/contracts/ndf-contract-use`。呼び出しの判定・区間の報告の読み取り・
 * 使い方のデータ）と照らす。照らす 6 項目は docs/design/execution.md の「契約の照合の定期の検査」の表にある。
 *
 *     node tools/checks/src/ndf-contract-check.ts [--root <作業の木>] [--summary <要約のファイル>]
 *     node tools/checks/src/ndf-contract-check.ts sync [--root <作業の木>]
 *
 * `sync` は、固定の点の契約から使い方の生成のファイル（`GENERATED_PATH`）を書き直す（#136 の決定 5）。
 * 生成のコマンドは `ndf-contract-sync.ts`、取得と形は照合と共有の `ndf-contract-fetch.ts` にある。
 * 終了コード: 0 書いた、1 手で書く id が契約に無いなど生成できない、2 引数の誤り・読めない・取得できない・書けない。
 *
 * 終了コード: 0 固定の点で食い違いが無い（先端の食い違いは要約に並べるだけ）、1 固定の点で食い違う・
 * 使い方の書き出しが無い（契約を取得せずに終える）、2 引数の誤り・固定の点の契約を読めない・使い方の書き出しの形が違う。
 */

import { appendFile, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { NdfContractUse, ReportReading } from "@nd-factory/contracts/ndf-contract-use-schema";

import {
  CONTRACT_DIR,
  ContractFetchError,
  NDF_REPO_URL,
  PIN_FILE,
  fetchContract,
  list,
  missing,
  parseContract,
  readPinnedCommit,
  withFixedContract,
  type ContractFiles,
  type ContractPath,
  type Parsed,
} from "./ndf-contract-fetch.ts";
import { GENERATED_PATH, mainNdfContractSync } from "./ndf-contract-sync.ts";

export type { NdfContractUse } from "@nd-factory/contracts/ndf-contract-use-schema";
// 取得と形・生成のコマンドは別のモジュールへ分けた。照合のモジュールから今までどおり引けるよう書き出し直す
export {
  CONTRACT_DIR,
  ContractFetchError,
  NDF_REPO_URL,
  PIN_FILE,
  PIN_KEY,
  fetchContract,
  type ContractFiles,
  type ContractRev,
} from "./ndf-contract-fetch.ts";
export {
  ContractUseSyncError,
  GENERATED_PATH,
  USE_DATA_PATH,
  generateContractUse,
  mainNdfContractSync,
} from "./ndf-contract-sync.ts";

/** NDF の契約の使い方の書き出し（#136）。書き出しの `ndfContractUse` が `NdfContractUse` の形 */
export const CONTRACT_USE_EXPORT = "@nd-factory/contracts/ndf-contract-use";

/** 照らすことの番号（設計の表の 1〜6） */
export type CheckNumber = 1 | 2 | 3 | 4 | 5 | 6;

/** 6 項目目で契約の行と比べる、生成した使うインタフェースの行の列 */
const ENTRYPOINT_COLUMNS = ["kind", "target", "lead", "args", "env", "files"] as const;

/** 食い違い。`path` は NDF のリポジトリの中の契約のファイルのパス、`id` は見本の id か配列の位置 */
export type ContractFinding = { check: CheckNumber; path: string; id?: string; detail: string };

/** 契約のファイルを照合が読む形で読む。読めなければ食い違いを足して null */
function read<P extends ContractPath>(
  files: ContractFiles,
  path: P,
  check: CheckNumber,
  findings: ContractFinding[],
): Parsed<P> | null {
  const result = parseContract(files, path);
  if (result.ok) return result.data;
  findings.push({ check, path: `${CONTRACT_DIR}/${path}`, detail: `契約のファイルの形が読めない（${result.where}）` });
  return null;
}

/**
 * 1: すべての見本の口が口の表にあることを先に確かめ（絞り込みで外れて見落とさないように）、
 * その後で使うインタフェースへの見本だけを呼び出しの判定へ通し、`valid` と同じ判定になる
 */
function checkCases(files: ContractFiles, use: NdfContractUse, findings: ContractFinding[]): void {
  const cases = read(files, "domains/entrypoint-cases.json", 1, findings);
  const entrypoints = read(files, "domains/entrypoints.json", 1, findings);
  if (cases === null || entrypoints === null) return;
  const path = `${CONTRACT_DIR}/domains/entrypoint-cases.json`;
  const ids = new Set(entrypoints.rows.map((row) => row.id));
  const used = new Set(use.entrypoints.map((row) => row.id));
  for (const row of cases.rows) {
    if (!ids.has(row.entrypoint)) {
      findings.push({ check: 1, path, id: row.id, detail: `見本の口 ${row.entrypoint} が口の表に無い` });
      continue;
    }
    if (!used.has(row.entrypoint)) continue;
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
    checkEnvPair(pair, entrypoints, setBy, use.envSetBy, findings);
  }
}

/** 3 の口と実行の場の 1 組ぶん。口の表・口の `env` 列・`env.json` の行と `set_by` を照らす */
function checkEnvPair(
  pair: NdfContractUse["env"][number],
  entrypoints: Parsed<"domains/entrypoints.json">,
  setBy: ReadonlyMap<string, string>,
  envSetBy: NdfContractUse["envSetBy"],
  findings: ContractFinding[],
): void {
  const id = `${pair.entrypoint}/${pair.site}`;
  const row = entrypoints.rows.find((r) => r.id === pair.entrypoint);
  if (row === undefined) {
    findings.push({ check: 3, path: `${CONTRACT_DIR}/domains/entrypoints.json`, id, detail: "口が口の表に無い" });
    return;
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
    const mismatch = setterMismatch(name, actual, envSetBy);
    if (mismatch !== null) otherSetter.push(mismatch);
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

/** 名前の `set_by` が期待と違えば食い違いの説明を返し、同じなら null */
function setterMismatch(name: string, actual: string, envSetBy: NdfContractUse["envSetBy"]): string | null {
  // envSetBy に載せた名前は契約の値との一致を先に照らす（user から service へ変わっても見逃さない）。
  // 載せない名前だけに service を求める
  const declared = Object.hasOwn(envSetBy, name) ? envSetBy[name] : undefined;
  const expected = declared ?? "service";
  if (actual === expected) return null;
  return `${name}（set_by: ${actual}${declared === undefined ? "" : `。使い方は ${declared}`}）`;
}

/** 4: 読むファイルの行が `reader: service` であり、その `fields` が翻訳が読む項目を含み、`path` が生成の値と同じ */
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
    if (row.path !== wanted.path) {
      findings.push({ check: 4, path, id: wanted.id, detail: "path が生成の値と違う" });
    }
    const lacking = missing(wanted.fields, row.fields ?? []);
    if (lacking.length > 0) {
      findings.push({ check: 4, path, id: wanted.id, detail: `fields に無い項目: ${list(lacking)}` });
    }
  }
}

/**
 * 5: 区間の報告の `shape.items` がランナーが読む項目を含み、生成した区間の報告の形が契約の `shape` と同じ
 * （`values` はキーの並び、`required` と `material` は値の全体）。`cases` の見本を区間の報告の読み取りへ通して
 * `result` と `errors` の有無が同じ判定になる
 */
function checkReport(files: ContractFiles, use: NdfContractUse, findings: ContractFinding[]): void {
  const report = read(files, "hooks/unattended-report.json", 5, findings);
  if (report === null) return;
  const path = `${CONTRACT_DIR}/hooks/unattended-report.json`;
  const { shape } = report;
  const shapeFinding = (detail: string) => findings.push({ check: 5, path, detail });
  const items = missing(use.reportItems, shape.items);
  if (items.length > 0) shapeFinding(`shape.items に無い項目: ${list(items)}`);
  const pairs: [string, unknown, unknown][] = [
    ["values", Object.keys(shape.values), use.report.values],
    ["required", shape.required, use.report.required],
    ["material", shape.material, use.report.material],
  ];
  for (const [key, contract, generated] of pairs) {
    if (normalized(contract) !== normalized(generated)) shapeFinding(`shape.${key} が生成の値と違う`);
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
    let got: ReportReading;
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

/** 値を、オブジェクトのキーの順によらない JSON の文字列にする（配列の順は保つ） */
function normalized(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v === null || typeof v !== "object") return v;
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));
    return Object.fromEntries(entries.map(([k, inner]) => [k, sort(inner)]));
  };
  return JSON.stringify(sort(value)) ?? "undefined";
}

/** `when` の行の条件（`need` のほかの鍵）を、鍵の順によらない文字列にする */
function conditionKey(rule: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(rule)
    .filter(([key]) => key !== "need")
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));
  return JSON.stringify(Object.fromEntries(entries));
}

/**
 * 6: 生成の固定の点が `ndf-pin.json` と同じで、使う口がすべて契約の口の表にあり、生成した行の 6 つの列が契約の行と同じ。
 * 値は出さない（契約の値は公開の情報だが、行が長くなるため）
 */
function checkEntrypoints(files: ContractFiles, use: NdfContractUse, pinned: string, findings: ContractFinding[]): void {
  if (use.pinnedCommit !== pinned) {
    findings.push({
      check: 6,
      path: GENERATED_PATH,
      detail: `生成の固定の点 ${use.pinnedCommit} が ${PIN_FILE} の ${pinned} と違う`,
    });
  }
  const entrypoints = read(files, "domains/entrypoints.json", 6, findings);
  if (entrypoints === null) return;
  const path = `${CONTRACT_DIR}/domains/entrypoints.json`;
  for (const wanted of use.entrypoints) {
    const row = entrypoints.rows.find((r) => r.id === wanted.id);
    if (row === undefined) {
      findings.push({ check: 6, path, id: wanted.id, detail: "使う口が口の表に無い" });
      continue;
    }
    for (const column of ENTRYPOINT_COLUMNS) {
      if (JSON.stringify(row[column]) !== JSON.stringify(wanted[column])) {
        findings.push({ check: 6, path, id: wanted.id, detail: `${column} が契約と違う` });
      }
    }
  }
}

/** 照らすこと 1〜6 を照らし、食い違いを返す。`pinned` は `ndf-pin.json` の固定の点（固定の点も先端も同じ値を渡す） */
export function compareContract(files: ContractFiles, use: NdfContractUse, pinned: string): ContractFinding[] {
  const findings: ContractFinding[] = [];
  checkCases(files, use, findings);
  checkVersion(files, use, findings);
  checkEnv(files, use, findings);
  checkFiles(files, use, findings);
  checkReport(files, use, findings);
  checkEntrypoints(files, use, pinned, findings);
  return findings;
}

/**
 * 食い違いにしない知らせの行。`ask-journal` の行が `fields` を持つようになったら出す（#41 の決定 106 の答えを知るため）。
 * 形が読めないときは何も出さない（食い違いは照らすこと 4 が出す）
 */
export function contractNotices(files: ContractFiles): string[] {
  const parsed = parseContract(files, "domains/ndf-files.json");
  if (!parsed.ok) return [];
  const row = parsed.data.rows.find((r) => r.id === "ask-journal");
  if (row?.fields === undefined) return [];
  return [`notice: ${files.commit} の ask-journal が fields を持つ: ${list(row.fields)}（#41 の決定 106）`];
}

type ReportShape = Parsed<"hooks/unattended-report.json">["shape"];

/** 名前の集まりの足された・消えたの差分の行 */
function setDiffLines(name: string, old: string[], now: string[]): string[] {
  const lines: string[] = [];
  const added = missing(now, old);
  const removed = missing(old, now);
  if (added.length > 0) lines.push(`diff: ${name} に足された: ${list(added)}`);
  if (removed.length > 0) lines.push(`diff: ${name} から消えた: ${list(removed)}`);
  return lines;
}

/** `shape.required` の差分の行。足された・消えた値と条件も、片側を空として always と条件ごとの need の差分を出す */
function requiredShapeDiff(a: ReportShape["required"], b: ReportShape["required"]): string[] {
  const lines = setDiffLines("shape.required", Object.keys(a), Object.keys(b));
  type Rule = ReportShape["required"][string];
  const empty: Rule = { always: [], when: [] };
  const needs = (rules: Rule["when"]) => {
    const byKey = new Map<string, string[]>();
    for (const rule of rules) byKey.set(conditionKey(rule), [...(byKey.get(conditionKey(rule)) ?? []), ...rule.need]);
    return byKey;
  };
  const valueNames = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const value of valueNames) {
    const old = (Object.hasOwn(a, value) ? a[value] : undefined) ?? empty;
    const now = (Object.hasOwn(b, value) ? b[value] : undefined) ?? empty;
    lines.push(...setDiffLines(`shape.required.${value}.always`, old.always, now.always));
    const oldWhen = needs(old.when);
    const nowWhen = needs(now.when);
    lines.push(...setDiffLines(`shape.required.${value}.when の条件`, [...oldWhen.keys()], [...nowWhen.keys()]));
    for (const key of new Set([...oldWhen.keys(), ...nowWhen.keys()])) {
      lines.push(
        ...setDiffLines(`shape.required.${value}.when の条件 ${key} の need`, oldWhen.get(key) ?? [], nowWhen.get(key) ?? []),
      );
    }
  }
  return lines;
}

/** `shape.material` の差分の行。足された・消えた鍵と、両方にある鍵の値の変わりを出す */
function materialShapeDiff(a: ReportShape["material"], b: ReportShape["material"]): string[] {
  const lines = setDiffLines("shape.material", Object.keys(a), Object.keys(b));
  for (const key of Object.keys(b)) {
    if (Object.hasOwn(a, key) && JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      lines.push(`diff: shape.material.${key} が変わった: ${JSON.stringify(a[key])} から ${JSON.stringify(b[key])}`);
    }
  }
  return lines;
}

/** 先端の区間の報告の `shape` を固定の点と比べ、差分の行を返す（通っても並べる） */
export function reportShapeDiff(fixed: ContractFiles, tip: ContractFiles): string[] {
  const before = parseContract(fixed, "hooks/unattended-report.json");
  const after = parseContract(tip, "hooks/unattended-report.json");
  if (!before.ok || !after.ok) return [];
  const a = before.data.shape;
  const b = after.data.shape;
  return [
    ...setDiffLines("shape.values", Object.keys(a.values), Object.keys(b.values)),
    ...setDiffLines("shape.items", a.items, b.items),
    ...requiredShapeDiff(a.required, b.required),
    ...materialShapeDiff(a.material, b.material),
  ];
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

/** 要約の Markdown。行（`checked:`・`fail:`・知らせ・差分）、固定の点と先端の食い違いの表を並べる */
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
  const isObject = (v: unknown) => typeof v === "object" && v !== null;
  return (
    Array.isArray(use.acceptedVersions) &&
    typeof use.pinnedCommit === "string" &&
    typeof use.skillPrefix === "string" &&
    Array.isArray(use.entrypoints) &&
    use.entrypoints.every((row) => isObject(row) && typeof (row as { id?: unknown }).id === "string") &&
    Array.isArray(use.env) &&
    isObject(use.envSetBy) &&
    Array.isArray(use.files) &&
    use.files.every((file) => isObject(file) && typeof (file as { path?: unknown }).path === "string") &&
    Array.isArray(use.reportItems) &&
    isObject(report) &&
    Array.isArray(report?.values) &&
    isObject(report?.required) &&
    isObject(report?.material) &&
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

function formatFinding(where: "fixed" | "tip", f: ContractFinding): string {
  return `mismatch: ${where} ${f.check} ${f.path}${f.id === undefined ? "" : ` ${f.id}`}: ${f.detail}`;
}

/** テストが差し替える依存。省けば本物の NDF のリポジトリと書き出しを使う */
export type MainOptions = {
  repoUrl?: string;
  /** 作業の木を受けて使い方を読む。省けば作業の木から書き出しを解決する */
  loadUse?: (root: string) => Promise<NdfContractUse | null>;
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
  if (use === null) {
    // 書き出しが無ければ、契約を取得せずに落とす（ネットワークにつながらなくても、取得のエラーで欠落を隠さない）
    const line = `fail: no-contract-use ${pinned}`;
    process.stdout.write(`${line}\n`);
    process.stderr.write(`NDF の契約の使い方の書き出し（${CONTRACT_USE_EXPORT}）が作業の木 ${root} に無い\n`);
    if (summaryPath !== undefined) {
      try {
        await appendFile(summaryPath, renderSummary([], [], [line]));
      } catch (error) {
        process.stderr.write(`error: 要約のファイルに書けない: ${(error as Error).message}\n`);
        return 2;
      }
    }
    return 1;
  }

  return withFixedContract(env, "ndf-contract-", pinned, repoUrl, async (fixed, work) => {
    let tip: ContractFiles | null = null;
    try {
      tip = await fetchContract({ kind: "tip" }, repoUrl, join(work, "tip"));
    } catch (error) {
      if (!(error instanceof ContractFetchError)) throw error;
      process.stderr.write(`warning: 既定の枝の先端の契約を読めず、先端は照らさなかった: ${error.message}\n`);
    }

    // 読めたコミットを先に出す
    const lines = [`read: fixed ${fixed.commit}`, ...(tip === null ? [] : [`read: tip ${tip.commit}`])];
    const fixedFindings = compareContract(fixed, use, pinned);
    lines.push(`checked: fixed ${fixed.commit} 1-6`);
    let tipFindings: ContractFinding[] | null = null;
    if (tip !== null) {
      tipFindings = compareContract(tip, use, pinned);
      lines.push(`checked: tip ${tip.commit} 1-6`);
    }
    const code = fixedFindings.length > 0 ? 1 : 0;
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
    }
    return code;
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  process.exitCode =
    args[0] === "sync" ? await mainNdfContractSync(args.slice(1), process.env) : await mainNdfContractCheck(args, process.env);
}
