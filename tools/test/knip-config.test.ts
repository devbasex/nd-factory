import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

type WorkspaceConfig = { entry?: string[]; ignoreDependencies?: string[]; includeEntryExports?: boolean };
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

/** 設定の入口と除外に合わせた木を組む。入口のファイルを置き、除外する依存を package.json に載せる */
function buildTree({ config, manifest = (_d, m) => m, files = {} }: Tree): string {
  const root = mkdtempSync(join(tmpdir(), "knip-config-"));
  trees.push(root);
  write(root, "package.json", JSON.stringify({ name: "acme-root", private: true, type: "module", workspaces: ["packages/*", "apps/*", "infra", "tools"], scripts: ROOT_SCRIPTS }));
  for (const ws of WORKSPACES) {
    const wsConfig = config.workspaces[ws.dir] ?? {};
    const ignored = Object.fromEntries((wsConfig.ignoreDependencies ?? []).map((d) => [d, "0.0.0"]));
    const base: Record<string, unknown> = { name: `@nd-factory/${ws.dir.split("/").at(-1)}`, private: true, type: "module", ...ws.manifest };
    const withIgnored = { ...base, devDependencies: { ...(base.devDependencies as object | undefined), ...ignored } };
    write(root, join(ws.dir, "package.json"), JSON.stringify(manifest(ws.dir, withIgnored)));
    for (const entry of wsConfig.entry ?? []) {
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
function runKnip(root: string): KnipRun {
  const reportPath = join(root, ".knip-report.json");
  const run = spawnSync(process.execPath, [KNIP_BIN, "--no-progress", "--reporter", "symbols", "--reporter", "json", "--output-file", `json=${reportPath}`], {
    cwd: root,
    encoding: "utf8",
  });
  const output = `${run.stdout}\n${run.stderr}`;
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { issues: (KnipIssue & { files?: { name: string }[] })[] };
  const files = report.issues.filter((i) => (i.files ?? []).length > 0).map((i) => i.file);
  return { status: run.status, files, issues: report.issues, output };
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
      const ignoring = Object.entries(config.workspaces).filter(([, ws]) => (ws.ignoreDependencies ?? []).length > 0);
      expect(ignoring.length).toBeGreaterThan(0);
      for (const [dir] of ignoring) {
        // 除外する依存を package.json から消すと、除外の行が使われなくなる
        const run = runKnip(buildTree({ config, manifest: (d, m) => (d === dir ? { ...m, devDependencies: {} } : m) }));
        expect(run.status, dir).toBe(1);
        expect(run.output, dir).toMatch(/Configuration hints/);
      }
    },
    KNIP_TIMEOUT,
  );

  it(
    "設定の入口を外すと、その入口のファイルがどこからも読まれないファイルとして当たる",
    () => {
      const withEntry = Object.entries(config.workspaces).filter(([, ws]) => (ws.entry ?? []).length > 0);
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
});
