import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTRACT_DIR,
  ContractFetchError,
  ContractUseSyncError,
  GENERATED_PATH,
  PIN_KEY,
  USE_DATA_PATH,
  generateContractUse,
  mainNdfContractSync,
  compareContract,
  contractNotices,
  contractUseLoaderFrom,
  fetchContract,
  loadContractUse,
  mainNdfContractCheck,
  renderSummary,
  reportShapeDiff,
} from "../checks/src/ndf-contract-check.ts";
import type { ContractFiles, ContractFinding, NdfContractUse } from "../checks/src/ndf-contract-check.ts";
import { ndfContractUse } from "@nd-factory/contracts/ndf-contract-use";
import type { NdfEntrypointRow, ReportError, ReportReading } from "@nd-factory/contracts/ndf-contract-use-schema";

// 版を読む語は、このファイル自身が参照の検査の版の比べに当たらないよう組み立てる
const READ_WORD = ["NDF", "VERSION"].join("_");
const SHA_OLD = "a".repeat(64);
const SHA_NEW = "b".repeat(64);

type Json = Record<string, unknown>;
type Rows = { rows: Json[] };

/** 作り物の NDF の契約（形だけを本物に合わせた小さなもの）。照らすこと 1〜6 がすべて通る */
function fakeContract(): Record<string, Json> {
  return {
    "version.json": {
      history: [
        { version: 1, sha256: SHA_OLD },
        { version: 2, sha256: SHA_NEW },
      ],
    },
    "domains/entrypoints.json": {
      rows: [
        {
          id: "skill-workflow",
          kind: "skill",
          target: "development-workflow",
          args: ["#[1-9][0-9]*"],
          env: ["NDF_FACTORY_RUN", READ_WORD, "NDF_PROGRESS_DB", "GH_TOKEN"],
        },
        { id: "report-unattended", kind: "report", target: "結果", args: ["判断が要る", "完了", "できなかった"], env: ["NDF_FACTORY_RUN"] },
        { id: "file-journals", kind: "file", target: "mvv-state", env: ["NDF_MVV_STATE_DIR"], files: ["ask-journal"] },
      ],
    },
    "domains/entrypoint-cases.json": {
      rows: [
        { id: "new", entrypoint: "skill-workflow", call: "#12", env: ["NDF_FACTORY_RUN"], valid: true },
        { id: "unknown-flag", entrypoint: "skill-workflow", call: "--resume 12", env: ["NDF_FACTORY_RUN"], valid: false },
        { id: "terminal-env", entrypoint: "skill-workflow", call: "#12", env: ["NDF_FACTORY_RUN", "TERM_RELAY"], valid: false },
        { id: "report-done", entrypoint: "report-unattended", call: "完了", env: ["NDF_FACTORY_RUN"], valid: true },
      ],
    },
    "domains/env.json": {
      rows: [
        { id: "NDF_FACTORY_RUN", set_by: "service" },
        { id: READ_WORD, set_by: "service" },
        { id: "NDF_PROGRESS_DB", set_by: "service" },
        { id: "NDF_MVV_STATE_DIR", set_by: "service" },
        { id: "GH_TOKEN", set_by: "user" },
      ],
    },
    "domains/ndf-files.json": {
      rows: [
        { id: "plan-progress", path: "<sprint>/<n>-<plan>-state/progress.jsonl", reader: "service", fields: ["step", "attention"] },
        { id: "ask-journal", path: "ask.jsonl", reader: "service" },
        { id: "loop-record", path: "<loop>/loop.json", reader: "service" },
      ],
    },
    "hooks/unattended-report.json": {
      shape: {
        values: { 判断が要る: "止まった", 完了: "通した", できなかった: "続けられない" },
        items: ["結果", "課題", "質問", "材料", "理由"],
        material: { item: "材料", body: "本文", heading: "## 判断の材料", url_prefix: "https://" },
        required: {
          判断が要る: {
            always: ["区分", "質問", "材料"],
            when: [
              { item: "区分", prefix: "ndf-gate:", need: ["承認ゲート"] },
              { item: "承認ゲート", equals: "設計 Pull Request のマージ", need: ["Pull Request"] },
            ],
          },
          完了: { always: [], when: [] },
          できなかった: { always: ["理由"], when: [] },
        },
      },
      cases: [
        { text: "## 区間の報告\n\n- 結果: 完了\n- 課題: #1\n", result: "完了", errors: [] },
        { text: "## 区間の報告\n\n- 結果: 保留\n", result: "保留", errors: ["結果の値が違う"] },
        { text: "## 確認したいこと\n\n続けてよいか。\n", result: "", errors: ["結果の行が無い"] },
      ],
    },
  };
}

// 作り物の使い方の判定の表（#2 の書き出しの代わり）。契約のファイルを読まず、自分の表で判定する
const JUDGE_TABLE: Record<string, { args: RegExp[]; env: string[] }> = {
  "skill-workflow": { args: [/^#[1-9][0-9]*$/], env: ["NDF_FACTORY_RUN", READ_WORD, "NDF_PROGRESS_DB", "GH_TOKEN"] },
  "report-unattended": { args: [/^(判断が要る|完了|できなかった)$/], env: ["NDF_FACTORY_RUN"] },
};
const REPORT_VALUES = ["判断が要る", "完了", "できなかった"];

/** 作り物の固定の点（`asFiles` の既定のコミット） */
const FAKE_PIN = "c".repeat(40);

/** 読み取りの誤りの作り物 */
const ERR = { code: "item_missing", item: "理由" } as const;

/** 作り物の読み取りの戻り値 */
function reading(result: string, errors: readonly ReportError[] = []): ReportReading {
  return { result, errors, items: {}, material: { kind: "none" } };
}

/** 契約の `entrypoints.json` から、使い方が持つ列（id と 6 つの列）で行を写す */
function rowsFrom(contract: Record<string, Json>, ids: readonly string[]): NdfEntrypointRow[] {
  return ids.map((id) => {
    const row = rowById(contract, "domains/entrypoints.json", id);
    const pick = Object.fromEntries(["id", "kind", "target", "lead", "args", "env", "files"].filter((k) => k in row).map((k) => [k, row[k]]));
    return pick as NdfEntrypointRow;
  });
}

/** 作り物の NDF の契約の使い方。`fakeContract` と照らして食い違いが無い */
function fakeUse(): NdfContractUse {
  const shape = reportShape(fakeContract());
  return {
    acceptedVersions: [{ version: 2, sha256: SHA_NEW }],
    pinnedCommit: FAKE_PIN,
    skillPrefix: "ndf:",
    entrypoints: rowsFrom(fakeContract(), ["skill-workflow", "report-unattended", "file-journals"]),
    env: [
      { entrypoint: "skill-workflow", site: "hosted", names: ["NDF_FACTORY_RUN", READ_WORD, "NDF_PROGRESS_DB", "GH_TOKEN"] },
      { entrypoint: "skill-workflow", site: "local", names: ["NDF_FACTORY_RUN", READ_WORD, "GH_TOKEN"] },
    ],
    envSetBy: { GH_TOKEN: "user" },
    files: [
      { id: "plan-progress", path: "<sprint>/<n>-<plan>-state/progress.jsonl", fields: ["step", "attention"] },
      { id: "ask-journal", path: "ask.jsonl", fields: [] },
    ],
    reportItems: ["結果", "質問", "材料", "理由"],
    report: {
      values: Object.keys(shape.values),
      required: shape.required,
      material: { item: "材料", body: "本文", heading: "## 判断の材料", url_prefix: "https://" },
    },
    judgeCall: ({ entrypoint, call, env }) => {
      const rule = JUDGE_TABLE[entrypoint];
      if (rule === undefined) return false;
      return rule.args.some((re) => re.test(call)) && env.every((name) => rule.env.includes(name));
    },
    readReport: (text) => {
      const lines = text.split("\n").filter((line) => line.startsWith("- 結果:"));
      const last = lines.at(-1);
      if (last === undefined) return reading("", [{ code: "result_line_missing", item: "結果" }]);
      const result = last.slice("- 結果:".length).trim();
      return reading(result, REPORT_VALUES.includes(result) ? [] : [{ code: "result_value_unknown", item: "結果" }]);
    },
  };
}

/** 照らすこと 1〜6 を作り物の固定の点で照らす */
function compare(files: ContractFiles, use: NdfContractUse): ContractFinding[] {
  return compareContract(files, use, FAKE_PIN);
}

function asFiles(json: Record<string, Json>, commit = "c".repeat(40)): ContractFiles {
  return { commit, json };
}

function rowsOf(contract: Record<string, Json>, path: string): Json[] {
  return (contract[path] as Rows).rows;
}

function rowById(contract: Record<string, Json>, path: string, id: string): Json {
  const row = rowsOf(contract, path).find((r) => r.id === id);
  if (row === undefined) throw new Error(`行が無い: ${path} ${id}`);
  return row;
}

type WhenRule = Json & { item: string; need: string[] };
type Shape = { items: string[]; values: Json; required: Record<string, { always: string[]; when: WhenRule[] }> };

function reportShape(contract: Record<string, Json>): Shape {
  return (contract["hooks/unattended-report.json"] as { shape: Shape }).shape;
}

/**
 * 固定の点（8d22be7）の `entrypoints.json`・`env.json`・`ndf-files.json` を必要な列で写したもの
 * （説明の文の列は写さない。参照の検査に当たる語を持ち込まないため）
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PINNED_DIR = join(REPO_ROOT, "tools", "test", "fixtures", "ndf-contract-8d22be7");
/** 同じ固定の点のサンプルと区間の報告の写し（スキーマの正本の単体テストと共有する） */
const PINNED_CONTRACTS_DIR = join(REPO_ROOT, "packages", "contracts", "test", "fixtures", "ndf-contract-8d22be7");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Json;
const readPinned = (name: string) => readJson(join(PINNED_DIR, `${name}.json`)) as Rows;
/** 作業の木の固定の点（ndf-pin.json） */
const PINNED_COMMIT = String(readJson(join(REPO_ROOT, "ndf-pin.json"))[PIN_KEY]);

/** 固定の点の契約のうち、照合と生成が読む 6 つのファイルを写しから組み立てる */
function fullPinnedContract(): Record<string, Json> {
  return {
    "version.json": { history: [{ version: 16, sha256: "c50ef840a72ab71a15023a46a37d050c36ec3aae6d1be6092b7f9dc7f3c0a726" }] },
    "domains/entrypoints.json": readPinned("entrypoints"),
    "domains/env.json": readPinned("env"),
    "domains/ndf-files.json": readPinned("ndf-files"),
    "domains/entrypoint-cases.json": readJson(join(PINNED_CONTRACTS_DIR, "entrypoint-cases.json")),
    "hooks/unattended-report.json": readJson(join(PINNED_CONTRACTS_DIR, "unattended-report.json")),
  };
}

/** 作業の木の手で書くデータと生成のデータ */
const USE_DATA = readJson(join(REPO_ROOT, USE_DATA_PATH)) as { entrypoints: string[] } & Json;
const GENERATED = readJson(join(REPO_ROOT, GENERATED_PATH));

function pinnedContract(): Record<string, Json> {
  const contract = fakeContract();
  const read = readPinned;
  contract["domains/env.json"] = read("env");
  // 口の表は作り物の行（見本と使い方が指す口）を保ち、skill-workflow の行だけを固定の点の行に替える
  const pinned = read("entrypoints").rows;
  const fake = contract["domains/entrypoints.json"] as Rows;
  const ids = new Set(pinned.map((row) => row.id));
  contract["domains/entrypoints.json"] = { ...fake, rows: [...fake.rows.filter((row) => !ids.has(row.id)), ...pinned] };
  return contract;
}

/** 実行の設計（docs/design/execution.md の「渡す環境変数」）でランナーが手元のマシンへ渡す名前 */
const RUNNER_LOCAL_NAMES = [
  "NDF_FACTORY_RUN",
  READ_WORD,
  "NDF_STATE_HOME",
  "NDF_MVV_STATE_DIR",
  "NDF_ISSUE_REQUEST_FILE",
  "GH_TOKEN",
];
/** 同じくホステッドへ渡す名前（手元のマシンの名前と NDF_PROGRESS_DB） */
const RUNNER_HOSTED_NAMES = [...RUNNER_LOCAL_NAMES, "NDF_PROGRESS_DB"];

/** 固定の点のデータで照らす使い方。実行の設計どおりのホステッド・手元のマシンの一覧と、user の 2 つの名前の envSetBy */
function pinnedUse(envSetBy: Record<string, string> = { GH_TOKEN: "user", NDF_STATE_HOME: "user" }): NdfContractUse {
  return {
    ...fakeUse(),
    entrypoints: rowsFrom(pinnedContract(), ["skill-workflow", "report-unattended", "file-journals"]),
    env: [
      { entrypoint: "skill-workflow", site: "hosted", names: RUNNER_HOSTED_NAMES },
      { entrypoint: "skill-workflow", site: "local", names: RUNNER_LOCAL_NAMES },
    ],
    envSetBy,
  };
}

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "acme",
  GIT_AUTHOR_EMAIL: "ops@example.com",
  GIT_COMMITTER_NAME: "acme",
  GIT_COMMITTER_EMAIL: "ops@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

function writeContract(repo: string, contract: Record<string, Json>): void {
  for (const [path, body] of Object.entries(contract)) {
    const file = join(repo, CONTRACT_DIR, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  }
}

type Upstream = { url: string; fixed: string; tip: string; repo: string };

/**
 * NDF のリポジトリの代わりの git のリポジトリを作る。固定の点のコミットを作り、その後に既定の枝（main）を
 * 先端のコミットへ進める
 */
function makeUpstream(fixed: Record<string, Json>, tip: Record<string, Json>): Upstream {
  const repo = tempDir("ndf-upstream-");
  git(repo, ["init", "-q", "-b", "main"]);
  writeContract(repo, fixed);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixed"]);
  const fixedCommit = git(repo, ["rev-parse", "HEAD"]);
  rmSync(join(repo, CONTRACT_DIR), { recursive: true, force: true });
  writeContract(repo, tip);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "tip"]);
  return { url: `file://${repo}`, fixed: fixedCommit, tip: git(repo, ["rev-parse", "HEAD"]), repo };
}

/** `ndf-pin.json` だけを持つ作業の木を作る */
function makeRoot(commit: string): string {
  const root = tempDir("ndf-root-");
  writeFileSync(join(root, "ndf-pin.json"), `${JSON.stringify({ [PIN_KEY]: commit })}\n`);
  return root;
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

function checksOf(findings: ContractFinding[]): number[] {
  return [...new Set(findings.map((f) => f.check))];
}

describe("compareContract", () => {
  it("作り物の契約と使い方で食い違いが 0 件", () => {
    expect(compare(asFiles(fakeContract()), fakeUse())).toEqual([]);
    expect(contractNotices(asFiles(fakeContract()))).toEqual([]);
  });

  it("ask-journal が fields を持つと知らせの行を出し、食い違いにしない", () => {
    const contract = fakeContract();
    rowById(contract, "domains/ndf-files.json", "ask-journal").fields = ["id", "question"];
    expect(compare(asFiles(contract), fakeUse())).toEqual([]);
    const notes = contractNotices(asFiles(contract));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("ask-journal");
    expect(notes[0]).toContain("id, question");
  });

  it("1: 見本の valid を判定と逆にすると、見本の id つきで 1 の食い違い", () => {
    const contract = fakeContract();
    rowById(contract, "domains/entrypoint-cases.json", "unknown-flag").valid = true;
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([1]);
    expect(findings[0]).toMatchObject({ check: 1, id: "unknown-flag", path: `${CONTRACT_DIR}/domains/entrypoint-cases.json` });
  });

  it("1: 見本が口の表に無い口を指すと 1 の食い違い", () => {
    const contract = fakeContract();
    rowById(contract, "domains/entrypoint-cases.json", "new").entrypoint = "skill-gone";
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([1]);
    expect(findings.map((f) => f.id)).toContain("new");
  });

  it("2: version.json の最後の行の sha256 が受ける組に無いと 2 の食い違い", () => {
    const contract = fakeContract();
    (contract["version.json"] as { history: Json[] }).history.push({ version: 3, sha256: "d".repeat(64) });
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([2]);
    expect(findings[0]?.path).toBe(`${CONTRACT_DIR}/version.json`);
  });

  it("3: 口の env 列から渡す名前を消すと 3 の食い違い（生成した行の env 列とも違うので 6 も）", () => {
    const contract = fakeContract();
    const row = rowById(contract, "domains/entrypoints.json", "skill-workflow");
    row.env = (row.env as string[]).filter((name) => name !== "GH_TOKEN");
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([3, 6]);
    expect(findings.filter((f) => f.check === 3).map((f) => f.id)).toEqual(["skill-workflow/hosted", "skill-workflow/local"]);
    expect(findings.filter((f) => f.check === 6)).toEqual([
      { check: 6, path: `${CONTRACT_DIR}/domains/entrypoints.json`, id: "skill-workflow", detail: "env が契約と違う" },
    ]);
  });

  it("3: env.json から渡す名前の行を消すと 3 の食い違い", () => {
    const contract = fakeContract();
    const env = contract["domains/env.json"] as Rows;
    env.rows = env.rows.filter((r) => r.id !== "NDF_PROGRESS_DB");
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([3]);
    expect(findings.map((f) => f.id)).toEqual(["skill-workflow/hosted"]);
  });

  it("3: 固定の点の env.json と口の表で、実行の設計どおりのホステッド・手元のマシンの名前が通る（GH_TOKEN・NDF_STATE_HOME は envSetBy の user）", () => {
    expect(compare(asFiles(pinnedContract()), pinnedUse())).toEqual([]);
  });

  it("3: 固定の点のデータで、GH_TOKEN を envSetBy に載せないと 3 の食い違い", () => {
    const findings = compare(asFiles(pinnedContract()), pinnedUse({ NDF_STATE_HOME: "user" }));
    expect(checksOf(findings)).toEqual([3]);
    expect(findings.map((f) => f.id)).toEqual(["skill-workflow/hosted", "skill-workflow/local"]);
    expect(findings[0]?.detail).toContain("GH_TOKEN（set_by: user）");
  });

  it("3: 固定の点のデータで、NDF_STATE_HOME を envSetBy に載せないと 3 の食い違い", () => {
    const findings = compare(asFiles(pinnedContract()), pinnedUse({ GH_TOKEN: "user" }));
    expect(checksOf(findings)).toEqual([3]);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.detail).toContain("NDF_STATE_HOME（set_by: user）");
  });

  it("3: サービスが入れる名前の set_by が user へ移ると 3 の食い違い", () => {
    const contract = pinnedContract();
    rowById(contract, "domains/env.json", "NDF_PROGRESS_DB").set_by = "user";
    const findings = compare(asFiles(contract), pinnedUse());
    expect(checksOf(findings)).toEqual([3]);
    expect(findings.map((f) => f.id)).toEqual(["skill-workflow/hosted"]);
    expect(findings[0]?.detail).toContain("NDF_PROGRESS_DB（set_by: user）");
  });

  it("3: envSetBy に user で載せた名前の契約の set_by が service へ変わると 3 の食い違い", () => {
    const contract = pinnedContract();
    rowById(contract, "domains/env.json", "GH_TOKEN").set_by = "service";
    const findings = compare(asFiles(contract), pinnedUse());
    expect(checksOf(findings)).toEqual([3]);
    expect(findings[0]?.detail).toContain("GH_TOKEN（set_by: service。使い方は user）");
  });

  it("3: envSetBy に載せた名前の set_by が別の値へ変わると 3 の食い違い", () => {
    const contract = fakeContract();
    rowById(contract, "domains/env.json", "GH_TOKEN").set_by = "ndf";
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([3]);
    expect(findings[0]?.detail).toContain("使い方は user");
  });

  it("4: 読むファイルの fields から翻訳が読む項目を消すと 4 の食い違い", () => {
    const contract = fakeContract();
    rowById(contract, "domains/ndf-files.json", "plan-progress").fields = ["step"];
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([4]);
    expect(findings[0]).toMatchObject({ id: "plan-progress", path: `${CONTRACT_DIR}/domains/ndf-files.json` });
  });

  it("4: 読むファイルの行が reader: service でないと 4 の食い違い", () => {
    const contract = fakeContract();
    delete rowById(contract, "domains/ndf-files.json", "ask-journal").reader;
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([4]);
  });

  it("5: shape.items からランナーが読む項目を消すと 5 の食い違い", () => {
    const contract = fakeContract();
    const shape = reportShape(contract);
    shape.items = shape.items.filter((item) => item !== "理由");
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([5]);
    expect(findings[0]?.path).toBe(`${CONTRACT_DIR}/hooks/unattended-report.json`);
  });

  it("5: 区間の報告の見本の result を読み取りと違えると、配列の位置つきで 5 の食い違い", () => {
    const contract = fakeContract();
    const cases = (contract["hooks/unattended-report.json"] as { cases: Json[] }).cases;
    if (cases[0] === undefined) throw new Error("見本が無い");
    cases[0].result = "判断が要る";
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([5]);
    expect(findings[0]?.id).toBe("0");
  });

  it("5: 要る項目から外すと 5 の食い違い", () => {
    const contract = fakeContract();
    const shape = (contract["hooks/unattended-report.json"] as { shape: { required: Record<string, Json> } }).shape;
    shape.required.判断が要る = { always: ["材料"], when: [] };
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([5]);
  });

  it("5: 条件つきで要る項目の条件だけを変えると 5 の食い違い", () => {
    const contract = fakeContract();
    const rule = reportShape(contract).required.判断が要る?.when[1];
    if (rule === undefined) throw new Error("条件の行が無い");
    rule.equals = "実装 Pull Request のマージ";
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([5]);
    expect(findings[0]?.detail).toBe("shape.required が生成の値と違う");
  });

  it("5: 無条件に要る項目を条件つきへ移すと 5 の食い違い", () => {
    const contract = fakeContract();
    const rule = reportShape(contract).required.判断が要る;
    if (rule === undefined) throw new Error("値が無い");
    rule.always = rule.always.filter((item) => item !== "質問");
    rule.when.push({ item: "区分", prefix: "ndf-ask:", need: ["質問"] });
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([5]);
    expect(findings[0]?.detail).toBe("shape.required が生成の値と違う");
  });

  it("5: 条件つきで要る項目が無条件へ移っても、生成の値と違うので 5 の食い違い", () => {
    const contract = fakeContract();
    const rule = reportShape(contract).required.判断が要る;
    if (rule === undefined) throw new Error("値が無い");
    rule.always.push("Pull Request");
    rule.when = rule.when.slice(0, 1);
    expect(compare(asFiles(contract), fakeUse())).toEqual([
      { check: 5, path: `${CONTRACT_DIR}/hooks/unattended-report.json`, detail: "shape.required が生成の値と違う" },
    ]);
  });

  it("5: required のキーの順だけが違っても食い違わない", () => {
    const contract = fakeContract();
    const shape = reportShape(contract);
    shape.required = Object.fromEntries(Object.entries(shape.required).reverse());
    expect(compare(asFiles(contract), fakeUse())).toEqual([]);
  });

  it("5: shape.values のキーの並び・material の値が生成の値と違うと 5 の食い違い", () => {
    const contract = fakeContract();
    const shape = reportShape(contract) as Shape & { material: Json };
    shape.values = Object.fromEntries(Object.entries(shape.values).reverse());
    shape.material.url_prefix = "http://";
    expect(compare(asFiles(contract), fakeUse()).map((f) => f.detail)).toEqual([
      "shape.values が生成の値と違う",
      "shape.material が生成の値と違う",
    ]);
  });

  it("6: 使う口を口の表から消すと 6 の食い違い", () => {
    const contract = fakeContract();
    rowById(contract, "domains/entrypoints.json", "file-journals").id = "file-journal";
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([6]);
    expect(findings[0]?.id).toBe("file-journals");
  });

  it("契約のファイルの形が読めないと、そのファイルを読む番号の食い違いにする（例外にしない）", () => {
    const contract = fakeContract();
    contract["domains/ndf-files.json"] = { rows: "x" };
    const findings = compare(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([4]);
  });
});

describe("compareContract の 5: 区間の報告の見本の照合", () => {
  const REPORT_PATH = `${CONTRACT_DIR}/hooks/unattended-report.json`;
  type Case = { text: string; result: string; errors: string[] };

  function casesOf(contract: Record<string, Json>): Case[] {
    return (contract["hooks/unattended-report.json"] as { cases: Case[] }).cases;
  }

  function withReadReport(readReport: NdfContractUse["readReport"]): NdfContractUse {
    return { ...fakeUse(), readReport };
  }

  it("見本の text を配列の順に 1 回ずつ読み取りへ渡す", () => {
    const contract = fakeContract();
    const texts: string[] = [];
    const base = fakeUse();
    const use = withReadReport((text) => {
      texts.push(text);
      return base.readReport(text);
    });
    expect(compare(asFiles(contract), use)).toEqual([]);
    expect(texts).toEqual(casesOf(contract).map((c) => c.text));
  });

  it("見本が 0 件なら読み取りを呼ばず、食い違いも出さない", () => {
    const contract = fakeContract();
    (contract["hooks/unattended-report.json"] as { cases: Case[] }).cases = [];
    const readReport = vi.fn(() => reading("x"));
    expect(compare(asFiles(contract), withReadReport(readReport))).toEqual([]);
    expect(readReport).not.toHaveBeenCalled();
  });

  it("result が違うと、配列の位置の id と両方の result・errors の件数を書いた食い違い", () => {
    const contract = fakeContract();
    const first = casesOf(contract)[0];
    if (first === undefined) throw new Error("見本が無い");
    first.result = "判断が要る";
    expect(compare(asFiles(contract), fakeUse())).toEqual([
      {
        check: 5,
        path: REPORT_PATH,
        id: "0",
        detail: '読み取りが result "完了"・errors 0 件で、見本の result "判断が要る"・errors 0 件と違う',
      },
    ]);
  });

  it("errors は件数でなく有無だけを比べる（件数が違っても有無が同じなら通す）", () => {
    const contract = fakeContract();
    const base = fakeUse();
    const use = withReadReport((text) => {
      const got = base.readReport(text);
      return got.errors.length > 0 ? { ...got, errors: [ERR, ERR, ERR] } : got;
    });
    expect(compare(asFiles(contract), use)).toEqual([]);
  });

  it("result が同じでも errors の有無が違うと食い違い（見本は errors 無し・読み取りは有り）", () => {
    const contract = fakeContract();
    const base = fakeUse();
    const use = withReadReport((text) => {
      const got = base.readReport(text);
      return got.result === "完了" ? { ...got, errors: [ERR] } : got;
    });
    expect(compare(asFiles(contract), use)).toEqual([
      {
        check: 5,
        path: REPORT_PATH,
        id: "0",
        detail: '読み取りが result "完了"・errors 1 件で、見本の result "完了"・errors 0 件と違う',
      },
    ]);
  });

  it("result が同じでも errors の有無が違うと食い違い（見本は errors 有り・読み取りは無し）", () => {
    const contract = fakeContract();
    const base = fakeUse();
    const use = withReadReport((text) => {
      const got = base.readReport(text);
      return got.result === "保留" ? { ...got, errors: [] } : got;
    });
    expect(compare(asFiles(contract), use)).toEqual([
      {
        check: 5,
        path: REPORT_PATH,
        id: "1",
        detail: '読み取りが result "保留"・errors 0 件で、見本の result "保留"・errors 1 件と違う',
      },
    ]);
  });

  it("読み取りが例外を投げると、その見本の位置の食い違いにして残りの見本も照らす", () => {
    const contract = fakeContract();
    const base = fakeUse();
    const use = withReadReport((text) => {
      if (text.includes("保留")) throw new Error("読めない");
      const got = base.readReport(text);
      return got.result === "" ? { ...got, result: "違う" } : got;
    });
    expect(compare(asFiles(contract), use)).toEqual([
      { check: 5, path: REPORT_PATH, id: "1", detail: "区間の報告の読み取りが例外を投げた: 読めない" },
      {
        check: 5,
        path: REPORT_PATH,
        id: "2",
        detail: '読み取りが result "違う"・errors 1 件で、見本の result ""・errors 1 件と違う',
      },
    ]);
  });

  it("読み取りが Error でない値を投げると、message を undefined として書く", () => {
    const contract = fakeContract();
    (contract["hooks/unattended-report.json"] as { cases: Case[] }).cases = casesOf(contract).slice(0, 1);
    const use = withReadReport(() => {
      throw "文字列";
    });
    expect(compare(asFiles(contract), use)).toEqual([
      { check: 5, path: REPORT_PATH, id: "0", detail: "区間の報告の読み取りが例外を投げた: undefined" },
    ]);
  });

  it("見本ごとに 1 件ずつ、配列の順に食い違いを出す", () => {
    const contract = fakeContract();
    for (const sample of casesOf(contract)) sample.result = "ずれ";
    const findings = compare(asFiles(contract), fakeUse());
    expect(findings.map((f) => [f.check, f.id])).toEqual([
      [5, "0"],
      [5, "1"],
      [5, "2"],
    ]);
  });

  it("shape の食い違いは見本の食い違いより前に並び、shape の食い違いは id を持たない", () => {
    const contract = fakeContract();
    const shape = reportShape(contract);
    shape.items = shape.items.filter((item) => item !== "理由");
    const first = casesOf(contract)[0];
    if (first === undefined) throw new Error("見本が無い");
    first.result = "ずれ";
    const findings = compare(asFiles(contract), fakeUse());
    expect(findings).toEqual([
      { check: 5, path: REPORT_PATH, detail: "shape.items に無い項目: 理由" },
      {
        check: 5,
        path: REPORT_PATH,
        id: "0",
        detail: '読み取りが result "完了"・errors 0 件で、見本の result "ずれ"・errors 0 件と違う',
      },
    ]);
    expect(Object.hasOwn(findings[0] ?? {}, "id")).toBe(false);
  });

  it("区間の報告のファイルの形が読めないと 5 の食い違い 1 件だけで、読み取りを呼ばない", () => {
    const contract = fakeContract();
    contract["hooks/unattended-report.json"] = { shape: "x", cases: [] };
    const readReport = vi.fn(() => reading(""));
    const findings = compare(asFiles(contract), withReadReport(readReport));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 5, path: REPORT_PATH });
    expect(findings[0]?.detail).toMatch(/^契約のファイルの形が読めない/);
    expect(readReport).not.toHaveBeenCalled();
  });
});

describe("reportShapeDiff", () => {
  it("要る項目の条件だけが変わっても、条件を含めた差分を出す", () => {
    const tip = fakeContract();
    const rule = reportShape(tip).required.判断が要る?.when[1];
    if (rule === undefined) throw new Error("条件の行が無い");
    rule.equals = "実装 Pull Request のマージ";
    const lines = reportShapeDiff(asFiles(fakeContract()), asFiles(tip));
    expect(lines.some((line) => line.includes("設計 Pull Request のマージ") && line.includes("消えた"))).toBe(true);
    expect(lines.some((line) => line.includes("実装 Pull Request のマージ") && line.includes("足された"))).toBe(true);
  });

  it("条件が同じで need だけが変わると、その条件の need の差分を出す", () => {
    const tip = fakeContract();
    reportShape(tip).required.判断が要る?.when[0]?.need.push("期限");
    const lines = reportShapeDiff(asFiles(fakeContract()), asFiles(tip));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ndf-gate:");
    expect(lines[0]).toContain("期限");
  });

  it("条件と need が一緒に変わると、消えた条件と足された条件のそれぞれの need の差分を出す", () => {
    const tip = fakeContract();
    const rule = reportShape(tip).required.判断が要る?.when[1];
    if (rule === undefined) throw new Error("条件の行が無い");
    rule.equals = "実装 Pull Request のマージ";
    rule.need = ["Pull Request", "検証"];
    const lines = reportShapeDiff(asFiles(fakeContract()), asFiles(tip));
    const needLines = lines.filter((line) => line.includes("の need"));
    expect(needLines.some((l) => l.includes("設計 Pull Request のマージ") && l.includes("消えた: Pull Request"))).toBe(true);
    expect(needLines.some((l) => l.includes("実装 Pull Request のマージ") && l.includes("足された: Pull Request, 検証"))).toBe(
      true,
    );
  });

  it("値が足される・消えると、その値の always と条件ごとの need を片側を空として出す", () => {
    const tip = fakeContract();
    const required = reportShape(tip).required;
    delete required.できなかった;
    required.保留 = { always: ["理由"], when: [{ item: "区分", prefix: "ndf-ask:", need: ["質問"] }] };
    const lines = reportShapeDiff(asFiles(fakeContract()), asFiles(tip));
    expect(lines).toContain("diff: shape.required.できなかった.always から消えた: 理由");
    expect(lines).toContain("diff: shape.required.保留.always に足された: 理由");
    expect(lines.some((l) => l.startsWith("diff: shape.required.保留.when の条件 ") && l.includes("足された: 質問"))).toBe(true);
  });

  it("形が同じなら差分を出さない", () => {
    expect(reportShapeDiff(asFiles(fakeContract()), asFiles(fakeContract()))).toEqual([]);
  });
});

describe("renderSummary", () => {
  const finding: ContractFinding = {
    check: 1,
    path: `${CONTRACT_DIR}/domains/entrypoint-cases.json`,
    id: "unknown-flag",
    detail: "判定 a|b",
  };

  it("行・固定の点と先端の食い違いの表を並べ、表の区切りを逃がす", () => {
    const text = renderSummary([finding], [], ["checked: fixed abc 1-6"]);
    expect(text).toContain("checked: fixed abc 1-6");
    expect(text).toContain("| 固定の点 | 1 |");
    expect(text).toContain("unknown-flag");
    expect(text).toContain("判定 a\\|b");
  });

  it("先端を照らさなかったら、その旨を出す", () => {
    expect(renderSummary([], null, [])).toContain("先端は照らさなかった");
  });
});

describe("fetchContract", () => {
  it("固定の点と既定の枝の先端の契約を読む", async () => {
    const tipContract = fakeContract();
    (tipContract["version.json"] as { history: Json[] }).history.push({ version: 3, sha256: "d".repeat(64) });
    const up = makeUpstream(fakeContract(), tipContract);
    const fixed = await fetchContract({ kind: "fixed", commit: up.fixed }, up.url, tempDir("ndf-work-"));
    const tip = await fetchContract({ kind: "tip" }, up.url, tempDir("ndf-work-"));
    expect(fixed.commit).toBe(up.fixed);
    expect(tip.commit).toBe(up.tip);
    expect(fixed.json["version.json"]).toEqual(fakeContract()["version.json"]);
    expect(tip.json["version.json"]).toEqual(tipContract["version.json"]);
  });

  it("契約のファイルが無いと ContractFetchError", async () => {
    const broken = fakeContract();
    delete broken["domains/env.json"];
    const up = makeUpstream(broken, broken);
    await expect(fetchContract({ kind: "fixed", commit: up.fixed }, up.url, tempDir("ndf-work-"))).rejects.toThrow(
      ContractFetchError,
    );
  });

  it("契約のファイルが JSON でないと ContractFetchError", async () => {
    const up = makeUpstream(fakeContract(), fakeContract());
    writeFileSync(join(up.repo, CONTRACT_DIR, "domains", "env.json"), "{ not json");
    git(up.repo, ["commit", "-q", "-am", "broken"]);
    await expect(fetchContract({ kind: "tip" }, up.url, tempDir("ndf-work-"))).rejects.toThrow("JSON");
  });

  it("コミットの形でない固定の点は取りに行かずに ContractFetchError", async () => {
    const up = makeUpstream(fakeContract(), fakeContract());
    await expect(fetchContract({ kind: "fixed", commit: "--upload-pack=x" }, up.url, tempDir("ndf-work-"))).rejects.toThrow(
      ContractFetchError,
    );
  });
});

describe("contractUseLoaderFrom", () => {
  /** 使い方の書き出しを持つパッケージを node_modules に置いた作業の木を作る */
  function rootWithExport(marker: string, exported = true): string {
    const root = tempDir("ndf-use-root-");
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "root", private: true, type: "module" })}\n`);
    const pkg = join(root, "node_modules", "@nd-factory", "contracts");
    mkdirSync(pkg, { recursive: true });
    const exportsField = exported ? { "./ndf-contract-use": "./use.mjs" } : { "./settings": "./use.mjs" };
    writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@nd-factory/contracts", type: "module", exports: exportsField })}\n`);
    writeFileSync(join(pkg, "use.mjs"), `export const marker = ${JSON.stringify(marker)};\n`);
    return root;
  }

  it("指定した作業の木の書き出しを読む（スクリプトの置き場の書き出しを読まない）", async () => {
    const a = rootWithExport("a");
    const b = rootWithExport("b");
    expect(await contractUseLoaderFrom(a)()).toMatchObject({ marker: "a" });
    expect(await contractUseLoaderFrom(b)()).toMatchObject({ marker: "b" });
  });

  it("作業の木のパッケージに書き出しが無ければ loadContractUse は null", async () => {
    expect(await loadContractUse(contractUseLoaderFrom(rootWithExport("a", false)))).toBeNull();
  });

  it("作業の木でパッケージを引けなければ例外（書き出しが無いとして通さない）", async () => {
    const root = tempDir("ndf-use-empty-");
    writeFileSync(join(root, "package.json"), "{}\n");
    await expect(loadContractUse(contractUseLoaderFrom(root))).rejects.toThrow();
  });

  it("作業の木に無く、上位の node_modules の書き出しを持たない同名パッケージを引くと例外（skip にしない）", async () => {
    const outer = rootWithExport("outer", false);
    const root = join(outer, "work");
    mkdirSync(root);
    writeFileSync(join(root, "package.json"), "{}\n");
    await expect(loadContractUse(contractUseLoaderFrom(root))).rejects.toThrow("作業の木");
  });

  it("書き出しの依存が ERR_PACKAGE_PATH_NOT_EXPORTED を投げても、書き出しが無い扱いにせず例外", async () => {
    const root = rootWithExport("a");
    const dep = join(root, "node_modules", "dep");
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, "package.json"), `${JSON.stringify({ name: "dep", type: "module", exports: { ".": "./i.mjs" } })}\n`);
    writeFileSync(join(dep, "i.mjs"), "export const x = 1;\n");
    writeFileSync(
      join(root, "node_modules", "@nd-factory", "contracts", "use.mjs"),
      'import "dep/hidden";\nexport const ndfContractUse = null;\n',
    );
    await expect(loadContractUse(contractUseLoaderFrom(root))).rejects.toMatchObject({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  });
});

describe("loadContractUse", () => {
  it("読み手が書き出しが無い（null）と返せば null", async () => {
    expect(await loadContractUse(() => Promise.resolve(null))).toBeNull();
  });

  it("読み手が ERR_PACKAGE_PATH_NOT_EXPORTED で失敗したら例外のまま投げる（書き出しが無い扱いにしない）", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    await expect(loadContractUse(() => Promise.reject(missing))).rejects.toThrow("missing");
  });

  it("書き出しの読み込みがほかの理由で失敗したら例外を投げる", async () => {
    await expect(loadContractUse(() => Promise.reject(new SyntaxError("bad")))).rejects.toThrow("bad");
  });

  it("書き出しの形が違えば例外を投げる", async () => {
    await expect(loadContractUse(() => Promise.resolve({ ndfContractUse: { entrypoints: [] } }))).rejects.toThrow(
      "ndfContractUse",
    );
  });

  it("書き出しの ndfContractUse を返す", async () => {
    const use = fakeUse();
    expect(await loadContractUse(() => Promise.resolve({ ndfContractUse: use }))).toBe(use);
  });
});

describe("mainNdfContractCheck", () => {
  function brokenCase(): Record<string, Json> {
    const contract = fakeContract();
    rowById(contract, "domains/entrypoint-cases.json", "unknown-flag").valid = true;
    return contract;
  }

  /** `use` の生成の固定の点は、`pinned` を省けば作業の木の固定の点（`pin`）に合わせる */
  async function run(up: Upstream | { url: string }, pin: string, use: NdfContractUse | null, pinned = pin) {
    const root = makeRoot(pin);
    const summary = join(tempDir("ndf-summary-"), "summary.md");
    writeFileSync(summary, "# 前の手順の要約\n");
    const io = capture();
    const code = await mainNdfContractCheck(["--root", root, "--summary", summary], {}, {
      repoUrl: up.url,
      loadUse: () => Promise.resolve(use === null ? null : { ...use, pinnedCommit: pinned }),
    });
    return { code, out: io.out.join(""), err: io.err.join(""), summary: readFileSync(summary, "utf8") };
  }

  it("食い違いが無ければ 0 と、固定の点と先端の checked の行", async () => {
    const up = makeUpstream(fakeContract(), fakeContract());
    const result = await run(up, up.fixed, fakeUse());
    expect(result.code).toBe(0);
    expect(result.out).toContain(`checked: fixed ${up.fixed} 1-6`);
    expect(result.out).toContain(`checked: tip ${up.tip} 1-6`);
    expect(result.summary.startsWith("# 前の手順の要約\n")).toBe(true);
    expect(result.summary).toContain(`checked: fixed ${up.fixed} 1-6`);
  });

  it("固定の点だけで食い違うと 1。checked: fixed と食い違いの行が出る", async () => {
    const up = makeUpstream(brokenCase(), fakeContract());
    const result = await run(up, up.fixed, fakeUse());
    expect(result.code).toBe(1);
    expect(result.out).toContain(`checked: fixed ${up.fixed} 1-6`);
    expect(result.out).toContain("unknown-flag");
    expect(result.summary).toContain("| 固定の点 | 1 |");
  });

  it("先端だけで食い違うと 0。要約に見本の id と契約のファイルのパスを並べる", async () => {
    const up = makeUpstream(fakeContract(), brokenCase());
    const result = await run(up, up.fixed, fakeUse());
    expect(result.code).toBe(0);
    expect(result.out).toContain(`checked: fixed ${up.fixed} 1-6`);
    expect(result.out).toContain(`checked: tip ${up.tip} 1-6`);
    expect(result.summary).toContain("| 先端 | 1 |");
    expect(result.summary).toContain("unknown-flag");
    expect(result.summary).toContain(`${CONTRACT_DIR}/domains/entrypoint-cases.json`);
  });

  it("先端の区間の報告の形が固定の点と違えば、通っても差分を要約に並べる", async () => {
    const tip = fakeContract();
    reportShape(tip).items.push("次の手");
    const up = makeUpstream(fakeContract(), tip);
    const result = await run(up, up.fixed, fakeUse());
    expect(result.code).toBe(0);
    expect(result.summary).toContain("shape.items");
    expect(result.summary).toContain("次の手");
  });

  it("使い方の書き出しが無いと、取得できない取得先でも取得を試みずに fail: no-contract-use と 1（skip にしない）", async () => {
    const pin = "d".repeat(40);
    const result = await run({ url: `file://${join(tempDir("ndf-none-"), "missing")}` }, pin, null);
    expect(result.code).toBe(1);
    expect(result.out).toBe(`fail: no-contract-use ${pin}\n`);
    expect(result.out).not.toContain("read:");
    expect(result.out).not.toContain("skip:");
    expect(result.summary).toContain(`fail: no-contract-use ${pin}`);
    expect(result.err).toContain("書き出し");
  });

  it("生成の固定の点が ndf-pin.json と違うと 6 の食い違いで 1", async () => {
    const up = makeUpstream(fakeContract(), fakeContract());
    const result = await run(up, up.fixed, fakeUse(), "e".repeat(40));
    expect(result.code).toBe(1);
    expect(result.out).toContain(`mismatch: fixed 6 ${GENERATED_PATH}: 生成の固定の点 ${"e".repeat(40)} が ndf-pin.json の ${up.fixed} と違う`);
  });

  it("固定の点の ask-journal が fields を持つと notice の行を標準出力と要約に出し、0 のまま", async () => {
    const fixed = fakeContract();
    rowById(fixed, "domains/ndf-files.json", "ask-journal").fields = ["id", "question"];
    const up = makeUpstream(fixed, fakeContract());
    const result = await run(up, up.fixed, fakeUse());
    expect(result.code).toBe(0);
    expect(result.out).toContain(`notice: ${up.fixed} の ask-journal が fields を持つ: id, question`);
    expect(result.summary).toContain(`notice: ${up.fixed} の ask-journal が fields を持つ: id, question`);
    expect(result.out).not.toContain("mismatch:");
  });

  it("固定の点を取れないと 2 と標準エラーの理由", async () => {
    const up = makeUpstream(fakeContract(), fakeContract());
    const result = await run(up, "0".repeat(40), fakeUse());
    expect(result.code).toBe(2);
    expect(result.err).toContain("固定の点");
  });

  it("先端を取れなければ checked: tip を出さず、要約に照らさなかったと出して固定の点の結果で終わる", async () => {
    const up = makeUpstream(fakeContract(), fakeContract());
    // 既定の枝を消し、固定の点はタグから辿れるようにする（HEAD が指す枝が無い）
    git(up.repo, ["tag", "pinned", up.fixed]);
    git(up.repo, ["checkout", "-q", "--detach"]);
    git(up.repo, ["branch", "-q", "-D", "main"]);
    git(up.repo, ["symbolic-ref", "HEAD", "refs/heads/gone"]);
    const result = await run(up, up.fixed, fakeUse());
    expect(result.code).toBe(0);
    expect(result.out).toContain(`checked: fixed ${up.fixed} 1-6`);
    expect(result.out).not.toContain("checked: tip");
    expect(result.summary).toContain("先端は照らさなかった");
  });

  it("使い方の書き出しは --root の作業の木から解決する（そこでパッケージを引けなければ 2）", async () => {
    const up = makeUpstream(fakeContract(), fakeContract());
    const root = makeRoot(up.fixed);
    writeFileSync(join(root, "package.json"), "{}\n");
    const io = capture();
    expect(await mainNdfContractCheck(["--root", root], {}, { repoUrl: up.url })).toBe(2);
    expect(io.err.join("")).toContain("使い方の書き出しを読めない");
  });

  it("引数が違うと 2", async () => {
    capture();
    expect(await mainNdfContractCheck(["--nope"], {})).toBe(2);
  });
});

describe("generateContractUse", () => {
  it("固定の点の契約から、手で書く id の行と path と区間の報告の形を作り、コミットした生成のファイルと同じ", () => {
    const generated = generateContractUse(asFiles(fullPinnedContract(), PINNED_COMMIT), USE_DATA.entrypoints);
    expect(generated).toEqual(GENERATED);
    expect(generated.entrypoints.map((row) => row.id)).toEqual(USE_DATA.entrypoints);
    expect(generated.files).toContainEqual({ id: "plan-progress", path: "<sprint>/<n>-<plan>-state/progress.jsonl" });
    expect(generated.report.values).toEqual(["判断が要る", "完了", "できなかった"]);
  });

  it("使わないインタフェース（file-loop-record・file-organizer など）の行と、その読むファイルが入らない", () => {
    const generated = generateContractUse(asFiles(fullPinnedContract(), PINNED_COMMIT), USE_DATA.entrypoints);
    const ids = generated.entrypoints.map((row) => row.id);
    for (const unused of ["file-loop-record", "file-organizer", "spec-pages", "spec-ndf_settings"]) expect(ids).not.toContain(unused);
    expect(generated.files.map((f) => f.id)).toEqual(["plan-progress", "ask-journal", "gate-rejections", "issue-request"]);
  });

  it("契約に無い id があると ContractUseSyncError で、その id を並べる", () => {
    const run = () => generateContractUse(asFiles(fullPinnedContract(), PINNED_COMMIT), [...USE_DATA.entrypoints, "no-such-entrypoint"]);
    expect(run).toThrow(ContractUseSyncError);
    expect(run).toThrow("no-such-entrypoint");
  });

  it("契約のファイルの形が読めないと ContractUseSyncError", () => {
    const contract = fullPinnedContract();
    contract["domains/ndf-files.json"] = { rows: "x" };
    expect(() => generateContractUse(asFiles(contract, PINNED_COMMIT), USE_DATA.entrypoints)).toThrow(ContractUseSyncError);
  });
});

describe("mainNdfContractSync", () => {
  /** `ndf-pin.json` と手で書くデータと（あれば）前の生成のファイルを持つ作業の木 */
  function syncRoot(commit: string, data: Json = USE_DATA, previous?: string): string {
    const root = makeRoot(commit);
    const dataFile = join(root, USE_DATA_PATH);
    mkdirSync(dirname(dataFile), { recursive: true });
    writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`);
    if (previous !== undefined) writeFileSync(join(root, GENERATED_PATH), previous);
    return root;
  }

  it("固定の点の契約を取得して生成のファイルを書き、0 と wrote の行", async () => {
    const up = makeUpstream(fullPinnedContract(), fakeContract());
    const root = syncRoot(up.fixed);
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: up.url })).toBe(0);
    const text = readFileSync(join(root, GENERATED_PATH), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ ...GENERATED, commit: up.fixed });
    expect(io.out.join("")).toContain(`wrote: ${GENERATED_PATH} ${up.fixed}`);
  });

  it("手で書く id を 1 件足して生成のファイルと食い違わせた作業の木でも起動し、書き直して 0", async () => {
    const up = makeUpstream(fullPinnedContract(), fakeContract());
    const data = { ...USE_DATA, entrypoints: [...USE_DATA.entrypoints, "file-loop-record"] };
    const root = syncRoot(up.fixed, data, `${JSON.stringify(GENERATED, null, 2)}\n`);
    capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: up.url })).toBe(0);
    const written = JSON.parse(readFileSync(join(root, GENERATED_PATH), "utf8")) as { entrypoints: Json[]; files: Json[] };
    expect(written.entrypoints.map((row) => row.id)).toContain("file-loop-record");
    expect(written.files).toContainEqual({ id: "loop-record", path: "<loop>/loop.json" });
  });

  it("契約に無い id で 1 と生成できない理由を出し、生成のファイルを書き換えない", async () => {
    const up = makeUpstream(fullPinnedContract(), fakeContract());
    const data = { ...USE_DATA, entrypoints: [...USE_DATA.entrypoints, "no-such-entrypoint"] };
    const root = syncRoot(up.fixed, data, "前の生成のファイル\n");
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: up.url })).toBe(1);
    expect(io.err.join("")).toContain("error: 生成できない");
    expect(io.err.join("")).toContain("no-such-entrypoint");
    expect(readFileSync(join(root, GENERATED_PATH), "utf8")).toBe("前の生成のファイル\n");
  });

  it("固定の点を取得できないと 2", async () => {
    const up = makeUpstream(fullPinnedContract(), fakeContract());
    const root = syncRoot("0".repeat(40));
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: up.url })).toBe(2);
    expect(io.err.join("")).toContain("固定の点");
  });

  it("手で書くデータの形が違うと 2", async () => {
    const up = makeUpstream(fullPinnedContract(), fakeContract());
    const root = syncRoot(up.fixed, { entrypoints: "x" });
    capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: up.url })).toBe(2);
  });

  it("引数が違うと 2", async () => {
    capture();
    expect(await mainNdfContractSync(["--nope"], {})).toBe(2);
  });
});

describe("compareContract（固定の点の写しと作業の木の書き出し）", () => {
  const ENTRYPOINTS_PATH = `${CONTRACT_DIR}/domains/entrypoints.json`;
  const compareReal = (contract: Record<string, Json>, use: NdfContractUse = ndfContractUse) =>
    compareContract(asFiles(contract, PINNED_COMMIT), use, PINNED_COMMIT);

  function withRow(id: string, change: (row: NdfEntrypointRow) => NdfEntrypointRow): NdfContractUse {
    return { ...ndfContractUse, entrypoints: ndfContractUse.entrypoints.map((row) => (row.id === id ? change(row) : row)) };
  }

  it("固定の点の契約と書き出しで、6 項目の食い違いが 0 件", () => {
    expect(compareReal(fullPinnedContract())).toEqual([]);
  });

  it("1: block-next への見本の口を口の表に無い id に替えると、その見本の id の 1 の行が出る（口の表の行は消さない）", () => {
    const contract = fullPinnedContract();
    rowById(contract, "domains/entrypoint-cases.json", "resume").entrypoint = "no-such-entrypoint";
    expect(compareReal(contract)).toEqual([
      {
        check: 1,
        path: `${CONTRACT_DIR}/domains/entrypoint-cases.json`,
        id: "resume",
        detail: "見本の口 no-such-entrypoint が口の表に無い",
      },
    ]);
  });

  it("1: 使わないインタフェースの見本の valid を逆にしても食い違わない", () => {
    const contract = fullPinnedContract();
    for (const id of ["loop-record", "organizer-request", "organizer-stray", "spec-page", "spec-ndf_settings"]) {
      const row = rowById(contract, "domains/entrypoint-cases.json", id);
      row.valid = row.valid !== true;
    }
    expect(compareReal(contract)).toEqual([]);
  });

  it("6: 生成の spec-io の target だけを変えると 6 の食い違い", () => {
    const use = withRow("spec-io", (row) => ({ ...row, target: "contracts/schemas/other" }));
    expect(compareReal(fullPinnedContract(), use)).toEqual([
      { check: 6, path: ENTRYPOINTS_PATH, id: "spec-io", detail: "target が契約と違う" },
    ]);
  });

  it.each(["kind", "lead", "args", "env", "files"] as const)("6: 生成の block-next の %s だけを変えると 6 の食い違い", (column) => {
    const use = withRow("block-next", (row) => ({ ...row, [column]: column === "kind" || column === "lead" ? "x" : ["x"] }));
    expect(compareReal(fullPinnedContract(), use)).toContainEqual({
      check: 6,
      path: ENTRYPOINTS_PATH,
      id: "block-next",
      detail: `${column} が契約と違う`,
    });
  });

  it("6: 生成の固定の点だけを変えると 6 の食い違い", () => {
    const use = { ...ndfContractUse, pinnedCommit: "0".repeat(40) };
    expect(compareReal(fullPinnedContract(), use)).toEqual([
      {
        check: 6,
        path: GENERATED_PATH,
        detail: `生成の固定の点 ${"0".repeat(40)} が ndf-pin.json の ${PINNED_COMMIT} と違う`,
      },
    ]);
  });

  it("4: 読むファイルの path だけを変えると 4 の食い違い", () => {
    const use = {
      ...ndfContractUse,
      files: ndfContractUse.files.map((f) => (f.id === "ask-journal" ? { ...f, path: "asks.jsonl" } : f)),
    };
    expect(compareReal(fullPinnedContract(), use)).toEqual([
      { check: 4, path: `${CONTRACT_DIR}/domains/ndf-files.json`, id: "ask-journal", detail: "path が生成の値と違う" },
    ]);
  });

  it("5: required の 判断が要る の always だけを変えると 5 の食い違い", () => {
    const required = structuredClone(ndfContractUse.report.required);
    const rule = required.判断が要る;
    if (rule === undefined) throw new Error("値が無い");
    rule.always = rule.always.filter((item) => item !== "質問");
    const use = { ...ndfContractUse, report: { ...ndfContractUse.report, required } };
    expect(compareReal(fullPinnedContract(), use)).toEqual([
      { check: 5, path: `${CONTRACT_DIR}/hooks/unattended-report.json`, detail: "shape.required が生成の値と違う" },
    ]);
  });

  it("作業の木の書き出しを照合の形として読める", async () => {
    expect(await loadContractUse(contractUseLoaderFrom(REPO_ROOT))).toMatchObject({ pinnedCommit: PINNED_COMMIT });
  });
});

describe("mainNdfContractCheck（固定の点の写しと作業の木の書き出し）", () => {
  async function runReal(use: NdfContractUse) {
    const up = makeUpstream(fullPinnedContract(), fullPinnedContract());
    const io = capture();
    const code = await mainNdfContractCheck(["--root", makeRoot(up.fixed)], {}, {
      repoUrl: up.url,
      loadUse: () => Promise.resolve({ ...use, pinnedCommit: up.fixed }),
    });
    return { up, code, out: io.out.join("") };
  }

  it("食い違いが無ければ 0 と checked の行で、skip の行を出さない", async () => {
    const { up, code, out } = await runReal(ndfContractUse);
    expect(code).toBe(0);
    expect(out).toContain(`checked: fixed ${up.fixed} 1-6`);
    expect(out).toContain(`checked: tip ${up.tip} 1-6`);
    expect(out).not.toContain("skip:");
    expect(out).not.toContain("mismatch:");
  });

  it("生成の spec-io の target だけを変えると、固定の点の 6 の食い違いで 1", async () => {
    const use = {
      ...ndfContractUse,
      entrypoints: ndfContractUse.entrypoints.map((row) => (row.id === "spec-io" ? { ...row, target: "contracts/schemas/other" } : row)),
    };
    const { code, out } = await runReal(use);
    expect(code).toBe(1);
    expect(out).toContain(`mismatch: fixed 6 ${CONTRACT_DIR}/domains/entrypoints.json spec-io: target が契約と違う`);
  });
});
