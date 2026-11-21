import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTRACT_DIR,
  ContractFetchError,
  PIN_KEY,
  compareContract,
  contractNotices,
  fetchContract,
  loadContractUse,
  mainNdfContractCheck,
  renderSummary,
} from "../checks/src/ndf-contract-check.ts";
import type { ContractFiles, ContractFinding, NdfContractUse } from "../checks/src/ndf-contract-check.ts";

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
          args: ["#[1-9][0-9]*"],
          env: ["NDF_FACTORY_RUN", READ_WORD, "NDF_PROGRESS_DB", "GH_TOKEN"],
        },
        { id: "report-unattended", kind: "report", args: ["判断が要る", "完了", "できなかった"], env: ["NDF_FACTORY_RUN"] },
        { id: "file-journals", kind: "file", env: ["NDF_MVV_STATE_DIR"], files: ["ask-journal"] },
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
        { id: "plan-progress", reader: "service", fields: ["step", "attention"] },
        { id: "ask-journal", reader: "service" },
        { id: "loop-record", reader: "service" },
      ],
    },
    "hooks/unattended-report.json": {
      shape: {
        values: { 判断が要る: "止まった", 完了: "通した", できなかった: "続けられない" },
        items: ["結果", "課題", "質問", "材料", "理由"],
        material: { item: "材料", body: "本文", heading: "## 判断の材料", url_prefix: "https://" },
        required: {
          判断が要る: { always: ["質問", "材料"], when: [] },
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

/** 作り物の NDF の契約の使い方。`fakeContract` と照らして食い違いが無い */
function fakeUse(): NdfContractUse {
  return {
    acceptedVersions: [{ version: 2, sha256: SHA_NEW }],
    entrypoints: ["skill-workflow", "report-unattended", "file-journals"],
    env: [
      { entrypoint: "skill-workflow", site: "hosted", names: ["NDF_FACTORY_RUN", READ_WORD, "NDF_PROGRESS_DB", "GH_TOKEN"] },
      { entrypoint: "skill-workflow", site: "local", names: ["NDF_FACTORY_RUN", READ_WORD, "GH_TOKEN"] },
    ],
    files: [
      { id: "plan-progress", fields: ["step", "attention"] },
      { id: "ask-journal", fields: [] },
    ],
    report: {
      values: REPORT_VALUES,
      items: ["結果", "質問", "材料", "理由"],
      required: { 判断が要る: ["質問", "材料"], できなかった: ["理由"] },
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
      if (last === undefined) return { result: "", errors: ["結果の行が無い"] };
      const result = last.slice("- 結果:".length).trim();
      return { result, errors: REPORT_VALUES.includes(result) ? [] : [`結果の値が違う: ${result}`] };
    },
  };
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

function reportShape(contract: Record<string, Json>): { items: string[]; values: Json } {
  return (contract["hooks/unattended-report.json"] as { shape: { items: string[]; values: Json } }).shape;
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
    expect(compareContract(asFiles(fakeContract()), fakeUse())).toEqual([]);
    expect(contractNotices(asFiles(fakeContract()))).toEqual([]);
  });

  it("使い方が null なら照らさない（壊した契約でも食い違いを出さない）", () => {
    const contract = fakeContract();
    (contract["version.json"] as { history: Json[] }).history = [];
    expect(compareContract(asFiles(contract), null)).toEqual([]);
  });

  it("ask-journal が fields を持つと知らせの行を出し、食い違いにしない", () => {
    const contract = fakeContract();
    rowById(contract, "domains/ndf-files.json", "ask-journal").fields = ["id", "question"];
    expect(compareContract(asFiles(contract), fakeUse())).toEqual([]);
    const notes = contractNotices(asFiles(contract));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("ask-journal");
    expect(notes[0]).toContain("id, question");
  });

  it("1: 見本の valid を判定と逆にすると、見本の id つきで 1 の食い違い", () => {
    const contract = fakeContract();
    rowById(contract, "domains/entrypoint-cases.json", "unknown-flag").valid = true;
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([1]);
    expect(findings[0]).toMatchObject({ check: 1, id: "unknown-flag", path: `${CONTRACT_DIR}/domains/entrypoint-cases.json` });
  });

  it("1: 見本が口の表に無い口を指すと 1 の食い違い", () => {
    const contract = fakeContract();
    rowById(contract, "domains/entrypoint-cases.json", "new").entrypoint = "skill-gone";
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([1]);
    expect(findings.map((f) => f.id)).toContain("new");
  });

  it("2: version.json の最後の行の sha256 が受ける組に無いと 2 の食い違い", () => {
    const contract = fakeContract();
    (contract["version.json"] as { history: Json[] }).history.push({ version: 3, sha256: "d".repeat(64) });
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([2]);
    expect(findings[0]?.path).toBe(`${CONTRACT_DIR}/version.json`);
  });

  it("3: 口の env 列から渡す名前を消すと 3 の食い違い", () => {
    const contract = fakeContract();
    const row = rowById(contract, "domains/entrypoints.json", "skill-workflow");
    row.env = (row.env as string[]).filter((name) => name !== "GH_TOKEN");
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([3]);
    expect(findings.map((f) => f.id)).toEqual(["skill-workflow/hosted", "skill-workflow/local"]);
  });

  it("3: env.json から渡す名前の行を消すと 3 の食い違い", () => {
    const contract = fakeContract();
    const env = contract["domains/env.json"] as Rows;
    env.rows = env.rows.filter((r) => r.id !== "NDF_PROGRESS_DB");
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([3]);
    expect(findings.map((f) => f.id)).toEqual(["skill-workflow/hosted"]);
  });

  it("4: 読むファイルの fields から翻訳が読む項目を消すと 4 の食い違い", () => {
    const contract = fakeContract();
    rowById(contract, "domains/ndf-files.json", "plan-progress").fields = ["step"];
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([4]);
    expect(findings[0]).toMatchObject({ id: "plan-progress", path: `${CONTRACT_DIR}/domains/ndf-files.json` });
  });

  it("4: 読むファイルの行が reader: service でないと 4 の食い違い", () => {
    const contract = fakeContract();
    delete rowById(contract, "domains/ndf-files.json", "ask-journal").reader;
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([4]);
  });

  it("5: shape.items からランナーが読む項目を消すと 5 の食い違い", () => {
    const contract = fakeContract();
    const shape = reportShape(contract);
    shape.items = shape.items.filter((item) => item !== "理由");
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([5]);
    expect(findings[0]?.path).toBe(`${CONTRACT_DIR}/hooks/unattended-report.json`);
  });

  it("5: 区間の報告の見本の result を読み取りと違えると、配列の位置つきで 5 の食い違い", () => {
    const contract = fakeContract();
    const cases = (contract["hooks/unattended-report.json"] as { cases: Json[] }).cases;
    if (cases[0] === undefined) throw new Error("見本が無い");
    cases[0].result = "判断が要る";
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([5]);
    expect(findings[0]?.id).toBe("0");
  });

  it("5: 要る項目から外すと 5 の食い違い", () => {
    const contract = fakeContract();
    const shape = (contract["hooks/unattended-report.json"] as { shape: { required: Record<string, Json> } }).shape;
    shape.required.判断が要る = { always: ["材料"], when: [] };
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([5]);
  });

  it("6: 使う口を口の表から消すと 6 の食い違い", () => {
    const contract = fakeContract();
    rowById(contract, "domains/entrypoints.json", "file-journals").id = "file-journal";
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([6]);
    expect(findings[0]?.id).toBe("file-journals");
  });

  it("契約のファイルの形が読めないと、そのファイルを読む番号の食い違いにする（例外にしない）", () => {
    const contract = fakeContract();
    contract["domains/ndf-files.json"] = { rows: "x" };
    const findings = compareContract(asFiles(contract), fakeUse());
    expect(checksOf(findings)).toEqual([4]);
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

describe("loadContractUse", () => {
  it("書き出しが無ければ null", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    expect(await loadContractUse(() => Promise.reject(missing))).toBeNull();
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

  async function run(up: Upstream, pin: string, use: NdfContractUse | null, required = false) {
    const root = makeRoot(pin);
    const summary = join(tempDir("ndf-summary-"), "summary.md");
    writeFileSync(summary, "# 前の手順の要約\n");
    const io = capture();
    const code = await mainNdfContractCheck(["--root", root, "--summary", summary], {}, {
      repoUrl: up.url,
      loadUse: () => Promise.resolve(use),
      required,
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

  it("使い方の書き出しが無いと skip: no-contract-use と 0（checked の行を出さない）", async () => {
    const up = makeUpstream(brokenCase(), fakeContract());
    const result = await run(up, up.fixed, null);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`skip: no-contract-use ${up.fixed}`);
    expect(result.out).toContain(`read: tip ${up.tip}`);
    expect(result.out).not.toContain("checked:");
    expect(result.summary).toContain(`skip: no-contract-use ${up.fixed}`);
  });

  it("使い方が要る（CONTRACT_USE_REQUIRED が真）のに書き出しが無いと fail: no-contract-use と 1", async () => {
    const up = makeUpstream(fakeContract(), fakeContract());
    const result = await run(up, up.fixed, null, true);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`fail: no-contract-use ${up.fixed}`);
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

  it("引数が違うと 2", async () => {
    capture();
    expect(await mainNdfContractCheck(["--nope"], {})).toBe(2);
  });
});
