import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RefCheckError,
  findNdfPins,
  findOldRefs,
  findVersionCompare,
  gitGrep,
  loadMatchTerms,
  mainRefCheck,
} from "../ref-check/src/ref-check.ts";
import type { MatchTerms } from "../ref-check/src/ref-check.ts";

// 照合の語は作り物だけを使う。版を読む語は、このファイル自身が版の比べの検査に当たらないよう組み立てる
const READ_WORD = ["NDF", "VERSION"].join("_");
const PIN_KEY = ["ndf", "ref"].join("_");
const TERMS: MatchTerms = {
  repo: ["old-org/old-app"],
  tables: ["old-app-test-accounts"],
  buckets: ["old-app-test-run-state"],
};
const TERMS_ENV = JSON.stringify(TERMS);

const roots: string[] = [];

/** 渡したファイルを追跡する一時の作業の木を作る */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ref-check-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

function pinFile(): Record<string, string> {
  return { "ndf-pin.json": `{\n  "${PIN_KEY}": "0123456789abcdef0123456789abcdef01234567"\n}\n` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("loadMatchTerms", () => {
  it("3 種類の語があれば値を返す", () => {
    expect(loadMatchTerms({ REF_CHECK_TERMS: TERMS_ENV })).toEqual(TERMS);
  });

  it("環境変数が無いか空なら null", () => {
    expect(loadMatchTerms({})).toBeNull();
    expect(loadMatchTerms({ REF_CHECK_TERMS: "" })).toBeNull();
    expect(loadMatchTerms({ REF_CHECK_TERMS: "  " })).toBeNull();
  });

  it("種類が欠けると RefCheckError で、欠けた種類だけを示し語そのものは出さない", () => {
    const raw = JSON.stringify({ repo: ["old-org/old-app"], tables: [] });
    expect(() => loadMatchTerms({ REF_CHECK_TERMS: raw })).toThrow(RefCheckError);
    try {
      loadMatchTerms({ REF_CHECK_TERMS: raw });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("tables");
      expect(message).toContain("buckets");
      expect(message).not.toContain("old-org/old-app");
    }
  });

  it("JSON でなければ RefCheckError", () => {
    expect(() => loadMatchTerms({ REF_CHECK_TERMS: "not json" })).toThrow(RefCheckError);
  });
});

describe("gitGrep", () => {
  it("当たりをファイルと行と中身に分ける", async () => {
    const root = makeRepo({ "a.txt": "one\ntwo needle\n", "dir/b.md": "needle\n" });
    const hits = await gitGrep(root, ["-F", "-e", "needle"]);
    expect(hits).toEqual([
      { file: "a.txt", line: 2, text: "two needle" },
      { file: "dir/b.md", line: 1, text: "needle" },
    ]);
  });

  it("当たりが無い（終了コード 1）なら空", async () => {
    const root = makeRepo({ "a.txt": "one\n" });
    expect(await gitGrep(root, ["-F", "-e", "needle"])).toEqual([]);
  });

  it("作業の木でない（終了コード 2 以上）なら RefCheckError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ref-check-nogit-"));
    roots.push(dir);
    await expect(gitGrep(dir, ["-F", "-e", "needle"])).rejects.toThrow(RefCheckError);
  });
});

describe("findOldRefs", () => {
  it("当たりが無ければ空", async () => {
    const root = makeRepo({ "README.md": "new app\n" });
    expect(await findOldRefs(root, TERMS)).toEqual([]);
  });

  it("文書にだけ当たりがあれば 1 件で、語の種類とファイルと行を返す", async () => {
    const root = makeRepo({ "docs/a.md": "intro\nsee old-app-test-accounts here\n", "src/a.ts": "ok\n" });
    expect(await findOldRefs(root, TERMS)).toEqual([{ kind: "old-ref:tables", file: "docs/a.md", line: 2 }]);
  });

  it("リポジトリの名前は大文字小文字を問わず当たる", async () => {
    const root = makeRepo({ ".github/workflows/ci.yml": "uses: Old-Org/Old-App/x\n" });
    expect(await findOldRefs(root, TERMS)).toEqual([
      { kind: "old-ref:repo", file: ".github/workflows/ci.yml", line: 1 },
    ]);
  });

  it("作業の木でなければ例外", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ref-check-nogit-"));
    roots.push(dir);
    await expect(findOldRefs(dir, TERMS)).rejects.toThrow(RefCheckError);
  });
});

describe("findNdfPins", () => {
  it("ndf-pin.json の 1 か所だけなら空", async () => {
    const root = makeRepo(pinFile());
    expect(await findNdfPins(root)).toEqual([]);
  });

  it("0 か所なら 1 件", async () => {
    const root = makeRepo({ "package.json": "{}\n" });
    const found = await findNdfPins(root);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("ndf-pin");
  });

  it("2 か所なら場所を添えて 1 件", async () => {
    const root = makeRepo({ ...pinFile(), "other/config.json": `{ "${PIN_KEY}": "x" }\n` });
    const found = await findNdfPins(root);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("ndf-pin");
    expect(found[0]?.file).toContain("other/config.json");
  });

  it("1 か所でも ndf-pin.json でなければ 1 件", async () => {
    const root = makeRepo({ "other/config.json": `{ "${PIN_KEY}": "x" }\n` });
    expect(await findNdfPins(root)).toHaveLength(1);
  });
});

describe("findVersionCompare", () => {
  it("比べが無ければ空", async () => {
    const root = makeRepo({ "src/a.ts": "const a = 1;\n" });
    expect(await findVersionCompare(root)).toEqual([]);
  });

  it("版を表示するだけの行は空", async () => {
    const root = makeRepo({ "src/a.ts": `console.log(process.env.${READ_WORD});\n` });
    expect(await findVersionCompare(root)).toEqual([]);
  });

  it("版の大小の比べは 1 件", async () => {
    const root = makeRepo({
      "src/a.ts": `const x = 1;\nif (process.env.${READ_WORD} >= "11.0.0") run();\n`,
    });
    expect(await findVersionCompare(root)).toEqual([{ kind: "version-compare", file: "src/a.ts", line: 2 }]);
  });

  it("ワークフローで版を読む式と大小の比べを同じ行に置くと 1 件", async () => {
    const root = makeRepo({
      ".github/workflows/ci.yml": [
        "on: pull_request",
        "jobs:",
        "  check:",
        `    if: \${{ env.${READ_WORD} >= '11.0.0' }}`,
        "    runs-on: ubuntu-24.04",
        "",
      ].join("\n"),
    });
    expect(await findVersionCompare(root)).toEqual([
      { kind: "version-compare", file: ".github/workflows/ci.yml", line: 4 },
    ]);
  });

  it("ワークフローで版を読む式だけの行は空", async () => {
    const root = makeRepo({
      ".github/workflows/ci.yml": `on: pull_request\njobs:\n  check:\n    steps:\n      - run: echo "\${{ env.${READ_WORD} }}"\n`,
    });
    expect(await findVersionCompare(root)).toEqual([]);
  });

  it("版の比べの関数も 1 件", async () => {
    const root = makeRepo({ "src/b.ts": `semver.gte(pin.${PIN_KEY}, "11.0.0");\n` });
    expect(await findVersionCompare(root)).toHaveLength(1);
  });
});

describe("mainRefCheck", () => {
  function captureStdout(): string[] {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    return lines;
  }

  it("当たりが無ければ 0", async () => {
    const root = makeRepo(pinFile());
    captureStdout();
    expect(await mainRefCheck(["--root", root], { REF_CHECK_TERMS: TERMS_ENV })).toBe(0);
  });

  it("語が無く要らない実行なら、飛ばした 1 行を出して残りを打ち 0", async () => {
    const root = makeRepo(pinFile());
    const out = captureStdout();
    expect(await mainRefCheck(["--root", root], {})).toBe(0);
    expect(out.join("")).toContain("skip");
  });

  it("語が無く要らない実行でも、固定の値の検査は打つ", async () => {
    const root = makeRepo({ "a.json": "{}\n" });
    captureStdout();
    expect(await mainRefCheck(["--root", root], {})).toBe(1);
  });

  it("語が無く要る実行なら 2", async () => {
    const root = makeRepo(pinFile());
    captureStdout();
    expect(await mainRefCheck(["--root", root], { REF_CHECK_REQUIRE_TERMS: "1" })).toBe(2);
  });

  it("当たりがあれば 1 で、種類とファイルと行を出し語そのものは出さない", async () => {
    const root = makeRepo({ ...pinFile(), "docs/a.md": "old-org/old-app\n" });
    const out = captureStdout();
    expect(await mainRefCheck(["--root", root], { REF_CHECK_TERMS: TERMS_ENV })).toBe(1);
    const text = out.join("");
    expect(text).toContain("old-ref:repo\tdocs/a.md:1");
    expect(text).not.toContain("old-org/old-app");
  });

  it("語の形が違えば 2", async () => {
    const root = makeRepo(pinFile());
    captureStdout();
    expect(await mainRefCheck(["--root", root], { REF_CHECK_TERMS: "{}" })).toBe(2);
  });

  it("作業の木でなければ 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ref-check-nogit-"));
    roots.push(dir);
    captureStdout();
    expect(await mainRefCheck(["--root", dir], { REF_CHECK_TERMS: TERMS_ENV })).toBe(2);
  });
});
