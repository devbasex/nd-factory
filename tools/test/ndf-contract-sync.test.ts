/**
 * 使い方の生成のコマンド（`generateContractUse`・`mainNdfContractSync`・`ContractUseSyncError`）の今の振る舞いを固定する。
 * 生成のコマンドを照合のモジュールから分けても、ここの期待は変えずに通ること（I-003）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTRACT_DIR,
  ContractUseSyncError,
  GENERATED_PATH,
  PIN_KEY,
  USE_DATA_PATH,
  generateContractUse,
  mainNdfContractSync,
} from "../checks/src/ndf-contract-check.ts";
import type { ContractFiles } from "../checks/src/ndf-contract-check.ts";

type Json = Record<string, unknown>;

const COMMIT = "d".repeat(40);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "tools", "checks", "src", "ndf-contract-check.ts");

/** 生成が読む 3 つのファイルだけを持つ小さな契約 */
function contract(): Record<string, Json> {
  return {
    "domains/entrypoints.json": {
      rows: [
        // 列の順を生成の順と違えて置き、説明の列も持たせる
        { files: ["f-b", "f-a"], env: ["E1"], target: "t-alpha", kind: "file", id: "alpha", note: "説明" },
        { id: "beta", kind: "skill", target: "t-beta", lead: "/x", args: ["#[0-9]+"], env: [] },
        { id: "gamma", kind: "file", target: "t-gamma", env: ["E2"], files: ["f-a", "f-c"] },
        // 同じ id の 2 行目は使わない
        { id: "beta", kind: "skill", target: "t-beta-2", env: [] },
      ],
    },
    "domains/ndf-files.json": {
      rows: [
        { id: "f-a", path: "a.json", reader: "service", fields: ["x"] },
        { id: "f-b", path: "b.json" },
        { id: "f-c", path: "c.json" },
        { id: "f-a", path: "a-2.json" },
      ],
    },
    "hooks/unattended-report.json": {
      shape: {
        values: { 完了: "通した", 判断が要る: "止まった" },
        items: ["結果"],
        material: { item: "材料", body: "本文", heading: "## 判断の材料", url_prefix: "https://", extra: "残す" },
        required: {
          判断が要る: { always: ["質問"], when: [{ item: "区分", prefix: "ndf-gate:", need: ["承認ゲート"] }] },
          完了: { always: [], when: [] },
        },
      },
      cases: [],
    },
  };
}

function files(json: Record<string, Json> = contract(), commit = COMMIT): ContractFiles {
  return { commit, json };
}

describe("ContractUseSyncError", () => {
  it("Error の子で、name が ContractUseSyncError", () => {
    const error = new ContractUseSyncError("m");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ContractUseSyncError");
    expect(error.message).toBe("m");
  });
});

describe("generateContractUse（形の固定）", () => {
  it("行は手で書く id の順、列は id・kind・target・lead・args・env・files の順で、無い列と説明の列を持たない", () => {
    const generated = generateContractUse(files(), ["gamma", "alpha", "beta"]);
    expect(generated).toEqual({
      commit: COMMIT,
      entrypoints: [
        { id: "gamma", kind: "file", target: "t-gamma", env: ["E2"], files: ["f-a", "f-c"] },
        { id: "alpha", kind: "file", target: "t-alpha", env: ["E1"], files: ["f-b", "f-a"] },
        { id: "beta", kind: "skill", target: "t-beta", lead: "/x", args: ["#[0-9]+"], env: [] },
      ],
      files: [
        { id: "f-a", path: "a.json" },
        { id: "f-c", path: "c.json" },
        { id: "f-b", path: "b.json" },
      ],
      report: {
        values: ["完了", "判断が要る"],
        required: {
          判断が要る: { always: ["質問"], when: [{ item: "区分", prefix: "ndf-gate:", need: ["承認ゲート"] }] },
          完了: { always: [], when: [] },
        },
        material: { item: "材料", body: "本文", heading: "## 判断の材料", url_prefix: "https://", extra: "残す" },
      },
    });
    expect(Object.keys(generated.entrypoints[1] ?? {})).toEqual(["id", "kind", "target", "env", "files"]);
    expect(Object.keys(generated.entrypoints[2] ?? {})).toEqual(["id", "kind", "target", "lead", "args", "env"]);
    expect(Object.keys(generated)).toEqual(["commit", "entrypoints", "files", "report"]);
  });

  it("同じ id の行が契約に 2 つあれば最初の行を使う（読むファイルも同じ）", () => {
    const generated = generateContractUse(files(), ["beta", "gamma"]);
    expect(generated.entrypoints[0]?.target).toBe("t-beta");
    expect(generated.files).toEqual([
      { id: "f-a", path: "a.json" },
      { id: "f-c", path: "c.json" },
    ]);
  });

  it("手で書く id が重なると、行も重ねて出す（読むファイルは 1 つにまとめる）", () => {
    const generated = generateContractUse(files(), ["alpha", "alpha"]);
    expect(generated.entrypoints.map((row) => row.id)).toEqual(["alpha", "alpha"]);
    expect(generated.files.map((f) => f.id)).toEqual(["f-b", "f-a"]);
  });

  it("同じ id の 2 行目が持つ列（lead・files）は、最初の行に無くても使わない", () => {
    const json = contract();
    json["domains/entrypoints.json"] = {
      rows: [
        { id: "dup", kind: "file", target: "t-1", env: [] },
        { id: "dup", kind: "skill", target: "t-2", lead: "/y", env: ["E9"], files: ["f-c"] },
      ],
    };
    const generated = generateContractUse(files(json), ["dup"]);
    expect(generated.entrypoints).toEqual([{ id: "dup", kind: "file", target: "t-1", env: [] }]);
    expect(generated.files).toEqual([]);
  });

  it("同じ id の行が 3 つ以上あっても、最初の 1 行だけを出す", () => {
    const json = contract();
    json["domains/entrypoints.json"] = {
      rows: [
        { id: "x", kind: "file", target: "t-other", env: [] },
        { id: "dup", kind: "file", target: "t-1", env: [], files: ["f-b"] },
        { id: "dup", kind: "file", target: "t-2", env: [], files: ["f-a"] },
        { id: "dup", kind: "file", target: "t-3", env: [], files: ["f-c"] },
      ],
    };
    const generated = generateContractUse(files(json), ["dup"]);
    expect(generated.entrypoints.map((row) => row.target)).toEqual(["t-1"]);
    expect(generated.files).toEqual([{ id: "f-b", path: "b.json" }]);
  });

  it("読むファイルの同じ id の行は最初の行の path を使い、空の path でも 2 行目に替えない", () => {
    const json = contract();
    json["domains/ndf-files.json"] = {
      rows: [
        { id: "f-b", path: "b.json" },
        { id: "f-a", path: "" },
        { id: "f-a", path: "a-2.json" },
        { id: "f-b", path: "b-2.json" },
      ],
    };
    const generated = generateContractUse(files(json), ["alpha"]);
    expect(generated.files).toEqual([
      { id: "f-b", path: "b.json" },
      { id: "f-a", path: "" },
    ]);
  });

  it("空の文字列の id も、入口と読むファイルの両方でふつうの id として引く", () => {
    const json = contract();
    json["domains/entrypoints.json"] = { rows: [{ id: "", kind: "file", target: "t-empty", env: [], files: [""] }] };
    json["domains/ndf-files.json"] = { rows: [{ id: "", path: "empty.json" }] };
    const generated = generateContractUse(files(json), [""]);
    expect(generated.entrypoints).toEqual([{ id: "", kind: "file", target: "t-empty", env: [], files: [""] }]);
    expect(generated.files).toEqual([{ id: "", path: "empty.json" }]);
  });

  it("読むファイルの行が重なっていても、無い id があれば ContractUseSyncError", () => {
    const json = contract();
    json["domains/ndf-files.json"] = {
      rows: [
        { id: "f-a", path: "a.json" },
        { id: "f-a", path: "a-2.json" },
      ],
    };
    expect(() => generateContractUse(files(json), ["gamma"])).toThrow(/^契約の ndf-files\.json に無い読むファイル: f-c$/);
  });

  it("手で書く id が空なら行も読むファイルも空で、区間の報告の形は出す", () => {
    const generated = generateContractUse(files(), []);
    expect(generated.entrypoints).toEqual([]);
    expect(generated.files).toEqual([]);
    expect(generated.report.values).toEqual(["完了", "判断が要る"]);
  });

  it("契約に無い id は契約の順でなく手で書く順に、カンマで並べる", () => {
    const run = () => generateContractUse(files(), ["zz", "alpha", "yy"]);
    expect(run).toThrow(ContractUseSyncError);
    expect(run).toThrow(/^契約の entrypoints\.json に無い id: zz, yy$/);
  });

  it("読むファイルの行が無いと、無い id を並べて ContractUseSyncError", () => {
    const json = contract();
    json["domains/ndf-files.json"] = { rows: [{ id: "f-a", path: "a.json" }] };
    const run = () => generateContractUse(files(json), ["alpha", "gamma"]);
    expect(run).toThrow(ContractUseSyncError);
    expect(run).toThrow(/^契約の ndf-files\.json に無い読むファイル: f-b, f-c$/);
  });

  it("契約のファイルの形が読めないと、契約のパスと最初の誤りの位置を書く", () => {
    const json = contract();
    json["domains/ndf-files.json"] = { rows: [{ id: "f-a" }] };
    expect(() => generateContractUse(files(json), ["alpha"])).toThrow(
      `契約のファイルの形が読めない: ${CONTRACT_DIR}/domains/ndf-files.json（rows.0.path）`,
    );
  });

  it("契約のファイルが無いと、位置の空な形の誤り", () => {
    const json = contract();
    delete json["hooks/unattended-report.json"];
    expect(() => generateContractUse(files(json), ["alpha"])).toThrow(
      `契約のファイルの形が読めない: ${CONTRACT_DIR}/hooks/unattended-report.json（）`,
    );
  });

  it("3 つとも読めないときは entrypoints.json → ndf-files.json → unattended-report.json の順で最初の 1 つを出す", () => {
    const json = contract();
    json["domains/entrypoints.json"] = {};
    json["domains/ndf-files.json"] = {};
    json["hooks/unattended-report.json"] = {};
    expect(() => generateContractUse(files(json), [])).toThrow("domains/entrypoints.json");
    json["domains/entrypoints.json"] = contract()["domains/entrypoints.json"] as Json;
    expect(() => generateContractUse(files(json), [])).toThrow("domains/ndf-files.json");
    json["domains/ndf-files.json"] = contract()["domains/ndf-files.json"] as Json;
    expect(() => generateContractUse(files(json), [])).toThrow("hooks/unattended-report.json");
  });

  it("id が無いことは形の誤りより後で照らす（形が読めなければ形の誤り）", () => {
    const json = contract();
    json["hooks/unattended-report.json"] = {};
    expect(() => generateContractUse(files(json), ["zz"])).toThrow("契約のファイルの形が読めない");
  });

  it("コミットが 40 桁の 16 進でないと、生成のデータの形の誤りとして位置を書く", () => {
    const run = () => generateContractUse(files(contract(), "HEAD"), ["alpha"]);
    expect(run).toThrow(ContractUseSyncError);
    expect(run).toThrow(/^生成のデータが形に合わない（commit）$/);
  });

  it("material に読み取りが使うキーが欠けると、生成のデータの形の誤り", () => {
    const json = contract();
    const report = json["hooks/unattended-report.json"] as { shape: { material: Json } };
    delete report.shape.material.heading;
    expect(() => generateContractUse(files(json), [])).toThrow(/^生成のデータが形に合わない（report\.material\.heading）$/);
  });
});

// ---- mainNdfContractSync ----

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

/** 生成が読む契約に、取得が求めるほかの 3 つのファイルを足して 1 つのコミットの上流を作る */
function makeUpstream(json: Record<string, Json> = contract()): { url: string; commit: string } {
  const repo = tempDir("ndf-sync-upstream-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
  const all: Record<string, unknown> = {
    "version.json": { history: [] },
    "domains/entrypoint-cases.json": { rows: [] },
    "domains/env.json": { rows: [] },
    ...json,
  };
  for (const [path, body] of Object.entries(all)) {
    const file = join(repo, CONTRACT_DIR, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(body)}\n`);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "c"], { cwd: repo, env: GIT_ENV });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
  return { url: `file://${repo}`, commit };
}

const USE_DATA = {
  entrypoints: ["alpha", "beta"],
  skillPrefix: "ndf:",
  env: [],
  envSetBy: {},
  files: [],
};

function syncRoot(commit: string | null, data: unknown = USE_DATA): string {
  const root = tempDir("ndf-sync-root-");
  if (commit !== null) writeFileSync(join(root, "ndf-pin.json"), `${JSON.stringify({ [PIN_KEY]: commit })}\n`);
  if (data !== null) {
    const file = join(root, USE_DATA_PATH);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  }
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

describe("mainNdfContractSync（振る舞いの固定）", () => {
  it("書いた中身は 2 つの空白で字下げした JSON と改行で、標準出力は wrote の 1 行だけ・標準エラーは空", async () => {
    const up = makeUpstream();
    const root = syncRoot(up.commit);
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: up.url })).toBe(0);
    const expected = generateContractUse(files(contract(), up.commit), USE_DATA.entrypoints);
    expect(readFileSync(join(root, GENERATED_PATH), "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(io.out).toEqual([`wrote: ${GENERATED_PATH} ${up.commit}\n`]);
    expect(io.err).toEqual([]);
  });

  it("取得の作業の場所は RUNNER_TEMP の下の ndf-contract-sync- に作り、終えたら消す", async () => {
    const up = makeUpstream();
    const root = syncRoot(up.commit);
    const temp = tempDir("ndf-sync-temp-");
    capture();
    expect(await mainNdfContractSync(["--root", root], { RUNNER_TEMP: temp }, { repoUrl: up.url })).toBe(0);
    expect(readdirSync(temp)).toEqual([]);
  });

  it("生成できないときも作業の場所を消す", async () => {
    const up = makeUpstream();
    const root = syncRoot(up.commit, { ...USE_DATA, entrypoints: ["zz"] });
    const temp = tempDir("ndf-sync-temp-");
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], { RUNNER_TEMP: temp }, { repoUrl: up.url })).toBe(1);
    expect(readdirSync(temp)).toEqual([]);
    expect(io.err).toEqual(["error: 生成できない: 契約の entrypoints.json に無い id: zz\n"]);
    expect(io.out).toEqual([]);
    expect(existsSync(join(root, GENERATED_PATH))).toBe(false);
  });

  it("契約のファイルの形が読めないと 1 と、契約のパスつきの理由", async () => {
    const json = contract();
    json["domains/ndf-files.json"] = { rows: "x" };
    const up = makeUpstream(json);
    const root = syncRoot(up.commit);
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: up.url })).toBe(1);
    expect(io.err.join("")).toBe(`error: 生成できない: 契約のファイルの形が読めない: ${CONTRACT_DIR}/domains/ndf-files.json（rows）\n`);
  });

  it("固定の点を取れないと 2 と、固定の点のコミットと取得の理由", async () => {
    const up = makeUpstream();
    const root = syncRoot("0".repeat(40));
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: up.url })).toBe(2);
    expect(io.err.join("")).toMatch(new RegExp(`^error: 固定の点 ${"0".repeat(40)} の契約を読めない: git fetch が失敗した`));
    expect(io.out).toEqual([]);
  });

  it("固定の点がコミットの形でないと、取得に行かずに 2", async () => {
    const root = syncRoot("main");
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: "file:///nonexistent" })).toBe(2);
    expect(io.err.join("")).toBe("error: 固定の点 main の契約を読めない: 固定の点がコミットの形（40 桁の 16 進）でない: main\n");
  });

  it("契約のファイルが無いコミットでも 2（取得の誤り）", async () => {
    const json = contract();
    const up = makeUpstream(json);
    // 取得が求めるファイルを消したコミットを作る
    const repo = up.url.slice("file://".length);
    rmSync(join(repo, CONTRACT_DIR, "domains", "env.json"));
    execFileSync("git", ["commit", "-qam", "rm"], { cwd: repo, env: GIT_ENV });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
    const root = syncRoot(commit);
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: up.url })).toBe(2);
    expect(io.err.join("")).toContain(`契約のファイルが無い: ${CONTRACT_DIR}/domains/env.json`);
  });

  it("ndf-pin.json が無いと、取得に行かずに 2 と作業の木のパス", async () => {
    const root = syncRoot(null);
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: "file:///nonexistent" })).toBe(2);
    const err = io.err.join("");
    expect(err.startsWith("error: 固定の点か使い方のデータを読めない: ")).toBe(true);
    expect(err.endsWith(`: ${root}\n`)).toBe(true);
  });

  it("ndf-pin.json に固定の点のキーの文字列が無いと 2", async () => {
    const root = syncRoot(null);
    writeFileSync(join(root, "ndf-pin.json"), JSON.stringify({ [PIN_KEY]: 1 }));
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: "file:///nonexistent" })).toBe(2);
    expect(io.err.join("")).toContain("ndf-pin.json に固定の点のキーの文字列が無い");
  });

  it("手で書くデータが無い・JSON でないと 2", async () => {
    for (const data of [null, "{"]) {
      const root = syncRoot(COMMIT, data);
      const io = capture();
      expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: "file:///nonexistent" })).toBe(2);
      expect(io.err.join("")).toContain("error: 固定の点か使い方のデータを読めない");
      vi.restoreAllMocks();
    }
  });

  it("手で書くデータに知らない鍵があると、形の誤りとして使い方のデータのパスを書いて 2", async () => {
    const root = syncRoot(COMMIT, { ...USE_DATA, extra: 1 });
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: "file:///nonexistent" })).toBe(2);
    expect(io.err.join("")).toContain(`${USE_DATA_PATH} の形が違う`);
  });

  it("手で書くデータの entrypoints 以外は生成に使わない（書き出しの組み立ては読まない）", async () => {
    const up = makeUpstream();
    const root = syncRoot(up.commit, { ...USE_DATA, files: [{ id: "no-such", fields: [] }], env: [{ entrypoint: "zz", site: "local", names: [] }] });
    capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: up.url })).toBe(0);
    const written = JSON.parse(readFileSync(join(root, GENERATED_PATH), "utf8")) as { entrypoints: Json[] };
    expect(written.entrypoints.map((row) => row.id)).toEqual(["alpha", "beta"]);
  });

  it("生成のファイルに書けないと 2 と理由", async () => {
    const up = makeUpstream();
    const root = syncRoot(up.commit);
    mkdirSync(join(root, GENERATED_PATH));
    const io = capture();
    expect(await mainNdfContractSync(["--root", root], {}, { repoUrl: up.url })).toBe(2);
    expect(io.err.join("")).toMatch(/^error: 生成のファイルに書けない: /);
    expect(io.out).toEqual([]);
  });

  it("--root を省くと今の作業の場所を作業の木にする", async () => {
    const up = makeUpstream();
    const root = syncRoot(up.commit);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    capture();
    expect(await mainNdfContractSync([], {}, { repoUrl: up.url })).toBe(0);
    expect(existsSync(join(root, GENERATED_PATH))).toBe(true);
  });

  it("引数が違うと 2 と使い方の行", async () => {
    const io = capture();
    expect(await mainNdfContractSync(["--summary", "x"], {})).toBe(2);
    expect(io.err.join("")).toMatch(/^usage: ndf-contract sync \[--root <作業の木>\]: /);
  });

  it("位置の引数も誤りとして 2", async () => {
    capture();
    expect(await mainNdfContractSync(["extra"], {})).toBe(2);
  });
});

describe("コマンドの入り口", () => {
  it("最初の引数が sync なら生成のコマンドへ渡す（引数の誤りで sync の使い方の行と 2）", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "sync", "--nope"], { encoding: "utf8", cwd: REPO_ROOT });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^usage: ndf-contract sync \[--root <作業の木>\]: /);
  });

  it("sync でなければ照合のコマンドへ渡す", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8", cwd: REPO_ROOT });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^usage: ndf-contract \[--root <作業の木>\] \[--summary <要約のファイル>\]: /);
  });
});
