import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

// knip.jsonc が、使われない書き出し・依存・ファイルと、使われない除外を落とすことを確かめる（#1 の決定 4・8）。
// 一時の木にワークスペースの形を組み、設定のファイルを写して knip を子のプロセスで打つ
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = join(ROOT, "knip.jsonc");
const KNIP_BIN = join(ROOT, "node_modules", "knip", "bin", "knip.js");
// knip の 1 回の実行は数秒かかる
const KNIP_TIMEOUT = 120_000;

type WorkspaceConfig = { entry?: string[]; ignoreDependencies?: string[]; ignoreBinaries?: string[]; includeEntryExports?: boolean };
type KnipConfig = { treatConfigHintsAsErrors?: boolean; tags?: string[]; workspaces: Record<string, WorkspaceConfig> };

/** knip.jsonc を読む（注釈つきの JSON を TypeScript の読み手で解く） */
function readConfig(): KnipConfig {
  const { config, error } = ts.parseConfigFileTextToJson(CONFIG, readFileSync(CONFIG, "utf8"));
  if (error !== undefined) throw new Error(`knip.jsonc を解けない: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
  return config as KnipConfig;
}

/** 作り物のワークスペース（置き場と package.json の追加の鍵） */
const WORKSPACES: { dir: string; manifest: Record<string, unknown> }[] = [
  { dir: "packages/contracts", manifest: { exports: { "./schema": "./src/schema.ts" } } },
  { dir: "apps/api", manifest: { dependencies: { "@nd-factory/contracts": "*" } } },
  { dir: "apps/web", manifest: { exports: { "./main": "./src/main.ts" } } },
  { dir: "infra", manifest: {} },
  { dir: "tools", manifest: {} },
];

/** 生成した画面の呼び出しの置き場（K2-2） */
const GENERATED = "apps/web/src/generated/calls.ts";
const GENERATED_BASE = "export const usedCall = 1;\n/** @screenPending #4 */\nexport const pendingCall = 2;\n";
/**
 * 生成した画面の呼び出しを production の入口にする `apps/web` の `entry` の行（K2-2）。画面から参照の無い生成した
 * ファイルを使われないファイルとして落とさず、`includeEntryExports` で書き出しを照らす。生成先が空だと knip が
 * 当たらない入口として誤りにするので、生成を置く #2 の Pull Request が足す
 */
const GENERATED_ENTRY = "src/generated/**/*.ts!";

/** `apps/web` の `entry` に生成した画面の呼び出しの行を足す（あれば重ねない）・外す */
function withGeneratedEntry(config: KnipConfig, present: boolean): KnipConfig {
  const web = config.workspaces["apps/web"] ?? {};
  const rest = (web.entry ?? []).filter((e) => e !== GENERATED_ENTRY);
  const entry = present ? [...rest, GENERATED_ENTRY] : rest;
  const { entry: _e, ...others } = web;
  return { ...config, workspaces: { ...config.workspaces, "apps/web": entry.length > 0 ? { ...others, entry } : others } };
}

/** 設定の手掛かりに依らない木の中身。ルートのスクリプトが打つファイルと exports が入口になる */
const BASE_FILES: Record<string, string> = {
  // exports の入口から使う書き出し（当たらない）
  "packages/contracts/src/schema.ts": 'import { used } from "./internal.ts";\nexport const schema = used;\n',
  "packages/contracts/src/internal.ts": "export const used = 1;\n",
  // 画面の起点と、生成した画面の呼び出し（K2-2）。画面が呼ぶものと、画面がまだ無いもの（`@screenPending` で外す）
  "apps/web/src/main.ts": 'import { usedCall } from "./generated/calls.ts";\nconsole.log(usedCall);\n',
  [GENERATED]: GENERATED_BASE,
  "infra/setup/nd-setup.ts": "export const setup = 1;\n",
  "tools/ref-check/src/ref-check.ts": "export const refCheck = 1;\n",
};
const ROOT_SCRIPTS = { "nd-setup": "node infra/setup/nd-setup.ts", "ref-check": "node tools/ref-check/src/ref-check.ts" };

type Tree = {
  config: KnipConfig;
  /** 置き場ごとの package.json の差し替え */
  manifest?: (dir: string, manifest: Record<string, unknown>) => Record<string, unknown>;
  files?: Record<string, string>;
};

const trees: string[] = [];

afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** 設定の入口と除外に合わせた木を組む。入口のファイルを置き、除外する依存と、除外する実行ファイルを打つスクリプトを package.json に載せる */
function buildTree({ config, manifest = (_d, m) => m, files = {} }: Tree): string {
  const root = mkdtempSync(join(tmpdir(), "knip-config-"));
  trees.push(root);
  write(root, "package.json", JSON.stringify({ name: "acme-root", private: true, type: "module", workspaces: ["packages/*", "apps/*", "infra", "tools"], scripts: ROOT_SCRIPTS }));
  for (const ws of WORKSPACES) {
    const wsConfig = config.workspaces[ws.dir] ?? {};
    const ignored = Object.fromEntries((wsConfig.ignoreDependencies ?? []).map((d) => [d, "0.0.0"]));
    const base: Record<string, unknown> = { name: `@nd-factory/${ws.dir.split("/").at(-1)}`, private: true, type: "module", ...ws.manifest };
    const binaries = Object.fromEntries((wsConfig.ignoreBinaries ?? []).map((b) => [`uses-${b}`, `${b} --version`]));
    const withIgnored = {
      ...base,
      devDependencies: { ...(base.devDependencies as object | undefined), ...ignored },
      ...(Object.keys(binaries).length > 0 ? { scripts: { ...(base.scripts as object | undefined), ...binaries } } : {}),
    };
    write(root, join(ws.dir, "package.json"), JSON.stringify(manifest(ws.dir, withIgnored)));
    // 生成した画面の呼び出しの入口は、木の生成したファイルが当たる
    for (const entry of (wsConfig.entry ?? []).filter((e) => !(ws.dir === "apps/web" && e === GENERATED_ENTRY))) {
      if (/[*?{}[\]!]/.test(entry)) throw new Error(`入口の glob はこのテストの木に置けない: ${ws.dir} の ${entry}`);
      write(root, join(ws.dir, entry), 'import { schema } from "@nd-factory/contracts/schema";\nexport const entry = schema;\n');
    }
  }
  for (const [path, content] of Object.entries({ ...BASE_FILES, ...files })) write(root, path, content);
  write(root, "knip.jsonc", JSON.stringify(config));
  return root;
}

type KnipIssue = { file: string; dependencies?: { name: string }[]; devDependencies?: { name: string }[]; exports?: { name: string }[] };
type KnipRun = { status: number | null; files: string[]; issues: KnipIssue[]; output: string };

/** 木で knip を打ち、終了コードと当たりを返す。当たりは JSON の報告のファイルで、設定の手掛かりは標準の出力で読む */
function runKnip(root: string, args: string[] = ["--no-progress"]): KnipRun {
  const reportPath = join(root, ".knip-report.json");
  const run = spawnSync(process.execPath, [KNIP_BIN, ...args, "--reporter", "symbols", "--reporter", "json", "--output-file", `json=${reportPath}`], {
    cwd: root,
    encoding: "utf8",
  });
  const output = `${run.stdout}\n${run.stderr}`;
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { issues: (KnipIssue & { files?: { name: string }[] })[] };
  const files = report.issues.filter((i) => (i.files ?? []).length > 0).map((i) => i.file);
  return { status: run.status, files, issues: report.issues, output };
}

/** ルートの package.json のスクリプト `knip` が打つ knip の実行ごとの引数（`&&` でつないだ順） */
function knipScriptRuns(): string[][] {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const script = manifest.scripts.knip;
  if (script === undefined) throw new Error("ルートの package.json にスクリプト knip が無い");
  return script.split("&&").map((command) => {
    const [bin, ...args] = command.trim().split(/\s+/);
    if (bin !== "knip") throw new Error(`スクリプト knip が knip の外を打つ: ${command}`);
    return args;
  });
}

/** スクリプト `knip` のとおりに打ち、どれかが落ちた最初の実行を返す（すべて通れば最後の実行） */
function runKnipScript(root: string, runs = knipScriptRuns()): KnipRun {
  let last: KnipRun | undefined;
  for (const args of runs) {
    last = runKnip(root, args);
    if (last.status !== 0) return last;
  }
  if (last === undefined) throw new Error("スクリプト knip に実行が無い");
  return last;
}

const exportsOf = (run: KnipRun) => run.issues.flatMap((i) => (i.exports ?? []).map((e) => `${i.file}:${e.name}`));
const depsOf = (run: KnipRun) => run.issues.flatMap((i) => [...(i.dependencies ?? []), ...(i.devDependencies ?? [])].map((d) => `${i.file}:${d.name}`));

describe("受け入れ条件 1・5・12: knip.jsonc の使っていないものの検出（決定 4・8）", () => {
  const config = readConfig();

  it("設定の手掛かりを誤りにし、`@screenPending` を外し、画面のワークスペースは入口の書き出しも照らす", () => {
    expect(config.treatConfigHintsAsErrors).toBe(true);
    expect(config.tags).toEqual(["-screenPending"]);
    expect(config.workspaces["apps/web"]?.includeEntryExports).toBe(true);
  });

  const unusedCall = { [GENERATED]: `${GENERATED_BASE}export const unusedCall = 3;\n` };
  const exposeGenerated = (dir: string, m: Record<string, unknown>) =>
    dir === "apps/web" ? { ...m, exports: { ...(m.exports as object), "./generated": "./src/generated/calls.ts" } } : m;

  it(
    "生成した画面の呼び出しで `@screenPending` の無い使われないものは当たる",
    () => {
      const run = runKnip(buildTree({ config, files: unusedCall }));
      expect(run.status).toBe(1);
      expect(exportsOf(run)).toEqual([`${GENERATED}:unusedCall`]);
    },
    KNIP_TIMEOUT,
  );

  it(
    "生成した画面の呼び出しを package.json の exports で公開しても、`@screenPending` の無い使われないものは当たる",
    () => {
      const run = runKnip(buildTree({ config, manifest: exposeGenerated, files: unusedCall }));
      expect(run.status).toBe(1);
      expect(exportsOf(run)).toEqual([`${GENERATED}:unusedCall`]);
    },
    KNIP_TIMEOUT,
  );

  it(
    "入口の書き出しを照らさない設定では、exports で公開した使われない呼び出しが当たらない（includeEntryExports が要る）",
    () => {
      const { includeEntryExports: _ie, ...web } = config.workspaces["apps/web"] ?? {};
      const without = { ...config, workspaces: { ...config.workspaces, "apps/web": web } };
      const run = runKnip(buildTree({ config: without, manifest: exposeGenerated, files: unusedCall }));
      expect(exportsOf(run)).toEqual([]);
    },
    KNIP_TIMEOUT,
  );

  // テストが生成した呼び出しを import していても、画面の入口から呼ばなければ使われない操作として落とす（K2-2）
  const testOf = (call: string) => `import { expect, it } from "vitest";\nimport { ${call} } from "../src/generated/calls.ts";\nit("calls", () => expect(${call}).toBeDefined());\n`;
  const testOnlyCall = {
    ...unusedCall,
    "apps/web/test/calls.test.ts": testOf("unusedCall"),
  };
  const withVitest = (dir: string, m: Record<string, unknown>) =>
    dir === "apps/web" ? { ...m, devDependencies: { ...(m.devDependencies as object), vitest: "0.0.0" } } : m;

  it(
    "スクリプト knip は、テストだけが呼ぶ生成した呼び出しを、画面の入口から使われないものとして落とす",
    () => {
      const run = runKnipScript(buildTree({ config, manifest: withVitest, files: testOnlyCall }));
      expect(run.status).toBe(1);
      expect(exportsOf(run)).toEqual([`${GENERATED}:unusedCall`]);
    },
    KNIP_TIMEOUT,
  );

  it(
    "通常のモードだけでは、テストだけが呼ぶ生成した呼び出しが当たらない（production の実行が要る）",
    () => {
      const tree = buildTree({ config, manifest: withVitest, files: testOnlyCall });
      const run = runKnip(tree);
      expect({ status: run.status, exports: exportsOf(run) }).toEqual({ status: 0, exports: [] });
      const production = knipScriptRuns().filter((args) => args.includes("--production"));
      expect(production).toEqual([["--no-progress", "--production", "--workspace", "apps/web"]]);
    },
    KNIP_TIMEOUT,
  );

  it(
    "スクリプト knip は、揃った木とテストを足した木で当たりが 0 件",
    () => {
      const tree = buildTree({ config, manifest: withVitest, files: { "apps/web/test/calls.test.ts": testOf("usedCall") } });
      const run = runKnipScript(tree);
      expect(run.output).not.toMatch(/Configuration hints/);
      expect({ status: run.status, files: run.files, exports: exportsOf(run), deps: depsOf(run) }).toEqual({ status: 0, files: [], exports: [], deps: [] });
    },
    KNIP_TIMEOUT,
  );

  it(
    "揃った木では当たりが 0 件で、入口から使う書き出しと `@screenPending` の書き出しは当たらない",
    () => {
      const run = runKnip(buildTree({ config }));
      expect(run.output).not.toMatch(/Configuration hints/);
      expect({ status: run.status, files: run.files, exports: exportsOf(run), deps: depsOf(run) }).toEqual({ status: 0, files: [], exports: [], deps: [] });
    },
    KNIP_TIMEOUT,
  );

  it(
    "使われない書き出しを 1 つ足すと当たる",
    () => {
      const run = runKnip(buildTree({ config, files: { "packages/contracts/src/internal.ts": `${BASE_FILES["packages/contracts/src/internal.ts"]}export const unusedCall = 3;\n` } }));
      expect(run.status).toBe(1);
      expect(exportsOf(run)).toEqual(["packages/contracts/src/internal.ts:unusedCall"]);
    },
    KNIP_TIMEOUT,
  );

  it(
    "使われない依存を 1 つ足すと当たる",
    () => {
      const run = runKnip(
        buildTree({
          config,
          manifest: (dir, m) => (dir === "apps/api" ? { ...m, dependencies: { ...(m.dependencies as object), "left-pad": "1.3.0" } } : m),
        }),
      );
      expect(run.status).toBe(1);
      expect(depsOf(run)).toEqual(["apps/api/package.json:left-pad"]);
    },
    KNIP_TIMEOUT,
  );

  it(
    "どこからも読まれないファイルを 1 つ足すと当たる",
    () => {
      const run = runKnip(buildTree({ config, files: { "apps/api/src/orphan.ts": "export const orphan = 1;\n" } }));
      expect(run.status).toBe(1);
      expect(run.files).toEqual(["apps/api/src/orphan.ts"]);
    },
    KNIP_TIMEOUT,
  );

  it(
    "使われない ignoreDependencies の行で誤りになる（設定の手掛かり）",
    () => {
      // 設定が除外の行を持たなくても確かめられるよう、使われない行を足した設定で打つ
      const tree = buildTree({ config });
      const infra = { ...config.workspaces.infra, ignoreDependencies: ["nd-unused-dependency"] };
      write(tree, "knip.jsonc", JSON.stringify({ ...config, workspaces: { ...config.workspaces, infra } }));
      const run = runKnip(tree);
      expect(run.status).toBe(1);
      expect(run.output).toMatch(/Configuration hints/);
    },
    KNIP_TIMEOUT,
  );

  it(
    "設定の入口を外すと、その入口のファイルがどこからも読まれないファイルとして当たる",
    () => {
      const withEntry = Object.entries(withGeneratedEntry(config, false).workspaces).filter(([, ws]) => (ws.entry ?? []).length > 0);
      expect(withEntry.length).toBeGreaterThan(0);
      for (const [dir, ws] of withEntry) {
        const { entry: _entry, ...rest } = ws;
        const tree = buildTree({ config, files: Object.fromEntries((ws.entry ?? []).map((e) => [join(dir, e), "export const entry = 1;\n"])) });
        write(tree, "knip.jsonc", JSON.stringify({ ...config, workspaces: { ...config.workspaces, [dir]: rest } }));
        const run = runKnip(tree);
        expect(run.status, dir).toBe(1);
        expect([...run.files].sort(), dir).toEqual((ws.entry ?? []).map((e) => join(dir, e)).sort());
      }
    },
    KNIP_TIMEOUT,
  );

  // 画面がまだ一つも無い段階や、操作ごとにファイルを生成して画面から参照の無いファイルがある段階（K2-2）
  describe("生成した画面の呼び出しを production の入口にする行（K2-2）", () => {
    const allPending = {
      "apps/web/src/main.ts": 'console.log("no screens");\n',
      [GENERATED]: "/** @screenPending #4 */\nexport const listUsers = 1;\n",
      "apps/web/src/generated/put-user.ts": "/** @screenPending #4 */\nexport const putUser = 2;\n",
    };

    it("リポジトリに生成先があるときだけ、knip.jsonc の apps/web はその行を持つ（空の生成先への行は knip が誤りにする）", () => {
      const hasGenerated = existsSync(join(ROOT, "apps/web/src/generated"));
      expect(config.workspaces["apps/web"]?.entry?.includes(GENERATED_ENTRY) ?? false).toBe(hasGenerated);
    });

    it(
      "すべての操作が保留中で画面から参照が無くても、スクリプト knip は当たりが 0 件",
      () => {
        const run = runKnipScript(buildTree({ config: withGeneratedEntry(config, true), files: allPending }));
        expect(run.output).not.toMatch(/Configuration hints/);
        expect({ status: run.status, files: run.files, exports: exportsOf(run), deps: depsOf(run) }).toEqual({ status: 0, files: [], exports: [], deps: [] });
      },
      KNIP_TIMEOUT,
    );

    it(
      "行の無い設定では、すべて保留中でも画面から参照の無い生成したファイルが使われないファイルとして当たる（行が要る）",
      () => {
        const run = runKnip(buildTree({ config: withGeneratedEntry(config, false), files: allPending }));
        expect(run.status).toBe(1);
        expect([...run.files].sort()).toEqual([GENERATED, "apps/web/src/generated/put-user.ts"].sort());
      },
      KNIP_TIMEOUT,
    );

    it(
      "行があっても、画面から参照の無いファイルの保留中でない書き出しは当たる",
      () => {
        const run = runKnipScript(
          buildTree({ config: withGeneratedEntry(config, true), files: { ...allPending, "apps/web/src/generated/delete-user.ts": "export const deleteUser = 3;\n" } }),
        );
        expect(run.status).toBe(1);
        expect(exportsOf(run)).toEqual(["apps/web/src/generated/delete-user.ts:deleteUser"]);
      },
      KNIP_TIMEOUT,
    );

    it(
      "行があっても、テストだけが呼ぶ生成した呼び出しはスクリプト knip が落とす",
      () => {
        const run = runKnipScript(buildTree({ config: withGeneratedEntry(config, true), manifest: withVitest, files: testOnlyCall }));
        expect(run.status).toBe(1);
        expect(exportsOf(run)).toEqual([`${GENERATED}:unusedCall`]);
      },
      KNIP_TIMEOUT,
    );
  });
});
