import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ICruiseOptions, type ICruiseResult, cruise } from "dependency-cruiser";
import extractDepcruiseOptions from "dependency-cruiser/config-utl/extract-depcruise-options";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// .dependency-cruiser.cjs の規則が、置き場の間の依存の向きに反する import を落とすことを確かめる（#1 の決定 2）。
// 一時の木に作り物のワークスペースを組み、設定のファイルのまま dependency-cruiser の API で照らす
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = join(ROOT, ".dependency-cruiser.cjs");
const CRUISE_DIRS = ["packages", "apps", "infra", "tools"];
// 一時の木を照らす 1 回は数秒かかるので、規則を 1 つずつ外して照らすテストに長めの時間を渡す
const CRUISE_TIMEOUT = 120_000;

/** 作り物のワークスペース（名前・置き場・package.json の exports） */
const WORKSPACES: { name: string; dir: string; exports: Record<string, string> }[] = [
  { name: "contracts", dir: "packages/contracts", exports: { "./schema": "./src/schema.ts", "./plans": "./src/plans.ts" } },
  { name: "core", dir: "packages/core", exports: { "./*": "./src/*.ts" } },
  { name: "api", dir: "apps/api", exports: { "./handler": "./src/handler.ts" } },
  { name: "web", dir: "apps/web", exports: {} },
  { name: "infra", dir: "infra", exports: { "./stack": "./lib/stack.ts" } },
  { name: "tools", dir: "tools", exports: {} },
];

/** 作り物の npm のパッケージ（中身は使わない。解決した先が node_modules の下になることだけを使う） */
const NPM_PACKAGES = ["zod", "react", "react-dom", "@vitejs/plugin-react", "left-pad"];

/** 規則に当たらないファイル。違反の import の行き先と、許された依存の見本を兼ねる */
const ALLOWED_FILES: Record<string, string> = {
  "packages/contracts/src/schema.ts": 'import { z } from "zod";\nexport const schema = z;\n',
  "packages/contracts/src/plans.ts": 'import data from "../data/plans.json" with { type: "json" };\nexport const plans = data;\nexport type Plan = { name: string };\n',
  "packages/contracts/data/plans.json": '[{ "name": "acme-free" }]\n',
  "packages/core/src/clock.ts": "export const now = () => 0;\nexport type Now = () => number;\n",
  "packages/core/src/ids.ts": "export const id = () => \"id\";\n",
  "packages/core/src/redact.ts": "export const redact = (v: string) => v;\n",
  "packages/core/src/log.ts": "export const log = () => undefined;\n",
  "packages/core/src/store.ts": 'import { schema } from "@nd-factory/contracts/schema";\nexport const store = schema;\nexport type Store = typeof schema;\n',
  "packages/core/src/usage-limit.ts": 'import { plans } from "@nd-factory/contracts/plans";\nimport type { Plan } from "../../contracts/src/plans.ts";\nexport const limit: unknown = plans;\nexport type P = Plan;\n',
  "apps/api/src/handler.ts": 'import { store } from "@nd-factory/core/store";\nexport const handler = store;\nexport type Handler = typeof store;\n',
  "apps/web/src/main.ts": [
    'import { now } from "@nd-factory/core/clock";',
    'import { id } from "../../../packages/core/src/ids.ts";',
    'import { redact } from "@nd-factory/core/redact";',
    'import { log } from "@nd-factory/core/log";',
    'import { schema } from "@nd-factory/contracts/schema";',
    'import { useState } from "react";',
    'import { createRoot } from "react-dom";',
    "export const app = [now, id, redact, log, schema, useState, createRoot];",
    "",
  ].join("\n"),
  "apps/web/vite.config.ts": 'import react from "@vitejs/plugin-react";\nexport default react;\n',
  "infra/lib/stack.ts": 'import { schema } from "@nd-factory/contracts/schema";\nexport const stack = schema;\nexport type Stack = typeof schema;\n',
  "tools/checks/src/check.ts": 'import { schema } from "@nd-factory/contracts/schema";\nexport const check = schema;\nexport type Check = typeof schema;\n',
};

type Violation = { rule: string; file: string; code: string; note: string };

/** 規則ごとの違反。どのファイルも、その規則だけに 1 件当たる import を 1 つ持つ */
const VIOLATIONS: Violation[] = [
  ...[
    { file: "packages/contracts/src/bad-core-name.ts", code: 'import { now } from "@nd-factory/core/clock";\nexport const n = now;\n', note: "名前の import" },
    { file: "packages/contracts/src/bad-core-relative.ts", code: 'import { now } from "../../core/src/clock.ts";\nexport const n = now;\n', note: "相対のパスの import" },
    { file: "packages/contracts/src/bad-core-type.ts", code: 'import type { Now } from "@nd-factory/core/clock";\nexport type N = Now;\n', note: "型だけの import" },
    { file: "packages/contracts/src/bad-package.ts", code: 'import pad from "left-pad";\nexport const p = pad;\n', note: "zod の外のパッケージ" },
  ].map((v) => ({ ...v, rule: "contracts-depends-on-zod-only" })),
  ...[
    { file: "packages/core/src/bad-app-name.ts", code: 'import { handler } from "@nd-factory/api/handler";\nexport const h = handler;\n', note: "名前の import" },
    { file: "packages/core/src/bad-app-relative.ts", code: 'import { handler } from "../../../apps/api/src/handler.ts";\nexport const h = handler;\n', note: "相対のパスの import" },
    { file: "packages/core/src/bad-infra-type.ts", code: 'import type { Stack } from "@nd-factory/infra/stack";\nexport type S = Stack;\n', note: "型だけの import" },
  ].map((v) => ({ ...v, rule: "core-depends-on-contracts-only" })),
  ...[
    { file: "apps/web/src/bad-api-name.ts", code: 'import { handler } from "@nd-factory/api/handler";\nexport const h = handler;\n', note: "名前の import" },
    { file: "apps/web/src/bad-api-relative.ts", code: 'import { handler } from "../../api/src/handler.ts";\nexport const h = handler;\n', note: "相対のパスの import" },
    { file: "apps/web/src/bad-api-type.ts", code: 'import type { Handler } from "@nd-factory/api/handler";\nexport type H = Handler;\n', note: "型だけの import" },
  ].map((v) => ({ ...v, rule: "apps-do-not-import-each-other" })),
  ...[
    { file: "apps/api/src/bad-infra-name.ts", code: 'import { stack } from "@nd-factory/infra/stack";\nexport const s = stack;\n', note: "名前の import（infra）" },
    { file: "apps/api/src/bad-tools-relative.ts", code: 'import { check } from "../../../tools/checks/src/check.ts";\nexport const c = check;\n', note: "相対のパスの import（tools）" },
    { file: "apps/api/src/bad-infra-type.ts", code: 'import type { Stack } from "../../../infra/lib/stack.ts";\nexport type S = Stack;\n', note: "型だけの import" },
  ].map((v) => ({ ...v, rule: "apps-do-not-import-infra-or-tools" })),
  ...[
    { file: "apps/web/src/bad-store-name.ts", code: 'import { store } from "@nd-factory/core/store";\nexport const s = store;\n', note: "名前の import" },
    { file: "apps/web/src/bad-store-relative.ts", code: 'import { store } from "../../../packages/core/src/store.ts";\nexport const s = store;\n', note: "相対のパスの import" },
    { file: "apps/web/src/bad-store-type.ts", code: 'import type { Store } from "@nd-factory/core/store";\nexport type S = Store;\n', note: "型だけの import" },
  ].map((v) => ({ ...v, rule: "web-uses-browser-core-only" })),
  ...[
    { file: "infra/lib/bad-api-name.ts", code: 'import { handler } from "@nd-factory/api/handler";\nexport const h = handler;\n', note: "名前の import" },
    { file: "infra/lib/bad-api-relative.ts", code: 'import { handler } from "../../apps/api/src/handler.ts";\nexport const h = handler;\n', note: "相対のパスの import" },
    { file: "infra/lib/bad-api-type.ts", code: 'import type { Handler } from "@nd-factory/api/handler";\nexport type H = Handler;\n', note: "型だけの import" },
  ].map((v) => ({ ...v, rule: "infra-does-not-import-apps" })),
  ...[
    { file: "tools/checks/src/bad-core-name.ts", code: 'import { store } from "@nd-factory/core/store";\nexport const s = store;\n', note: "名前の import（packages/core）" },
    { file: "tools/checks/src/bad-api-relative.ts", code: 'import { handler } from "../../../apps/api/src/handler.ts";\nexport const h = handler;\n', note: "相対のパスの import（apps）" },
    { file: "tools/checks/src/bad-infra-type.ts", code: 'import type { Stack } from "@nd-factory/infra/stack";\nexport type S = Stack;\n', note: "型だけの import（infra）" },
  ].map((v) => ({ ...v, rule: "tools-depends-on-contracts-only" })),
  ...[
    { file: "apps/api/src/bad-react.ts", code: 'import { useState } from "react";\nexport const u = useState;\n', note: "react" },
    { file: "infra/lib/bad-react-type.ts", code: 'import type { FC } from "react";\nexport type F = FC;\n', note: "型だけの import" },
    { file: "packages/core/src/bad-react-dom.ts", code: 'import { createRoot } from "react-dom";\nexport const c = createRoot;\n', note: "react-dom" },
    { file: "tools/checks/src/bad-plugin-react.ts", code: 'import react from "@vitejs/plugin-react";\nexport const r = react;\n', note: "@vitejs/plugin-react" },
  ].map((v) => ({ ...v, rule: "react-only-in-web" })),
  ...[
    { file: "apps/api/src/bad-plans-name.ts", code: 'import { plans } from "@nd-factory/contracts/plans";\nexport const p = plans;\n', note: "名前の import（書き出し）" },
    { file: "packages/core/src/bad-plans-relative.ts", code: 'import { plans } from "../../contracts/src/plans.ts";\nexport const p = plans;\n', note: "相対のパスの import（判定のモジュールの外の core）" },
    { file: "apps/web/src/bad-plans-type.ts", code: 'import type { Plan } from "@nd-factory/contracts/plans";\nexport type P = Plan;\n', note: "型だけの import" },
    {
      file: "infra/lib/bad-plans-data.ts",
      code: 'import data from "../../packages/contracts/data/plans.json" with { type: "json" };\nexport const d = data;\n',
      note: "値のデータの import",
    },
  ].map((v) => ({ ...v, rule: "plan-values-only-in-usage-limit" })),
];

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** 作り物のワークスペースと npm のパッケージを組んだ一時の木を作る */
function buildTree(): string {
  const root = mkdtempSync(join(tmpdir(), "deps-config-"));
  write(root, "tsconfig.base.json", JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", allowImportingTsExtensions: true, resolveJsonModule: true, noEmit: true } }));
  for (const ws of WORKSPACES) {
    write(root, join(ws.dir, "package.json"), JSON.stringify({ name: `@nd-factory/${ws.name}`, type: "module", exports: ws.exports }));
    mkdirSync(join(root, "node_modules", "@nd-factory"), { recursive: true });
    symlinkSync(join(root, ws.dir), join(root, "node_modules", "@nd-factory", ws.name), "dir");
  }
  for (const name of NPM_PACKAGES) {
    const dir = join("node_modules", name);
    write(root, join(dir, "package.json"), JSON.stringify({ name, main: "index.js", types: "index.d.ts" }));
    write(root, join(dir, "index.js"), "module.exports = {};\n");
    write(root, join(dir, "index.d.ts"), "declare const value: unknown;\nexport default value;\nexport declare const z: unknown;\nexport declare const useState: unknown;\nexport declare const createRoot: unknown;\nexport type FC = unknown;\n");
  }
  for (const [path, content] of Object.entries(ALLOWED_FILES)) write(root, path, content);
  for (const v of VIOLATIONS) write(root, v.file, v.code);
  return root;
}

type Options = ICruiseOptions;

/** 設定の禁じる規則の並び */
const forbiddenOf = (opts: Options) => opts.ruleSet?.forbidden ?? [];

let tree: string;
let options: Options;

beforeAll(async () => {
  tree = buildTree();
  options = await extractDepcruiseOptions(CONFIG);
});

afterAll(() => {
  rmSync(tree, { recursive: true, force: true });
});

/** 一時の木を照らし、違反を `from` のファイルごとの規則の名前の並びで返す */
async function cruiseTree(opts: Options): Promise<Map<string, string[]>> {
  const tsConfig = extractTSConfig(join(tree, opts.tsConfig?.fileName ?? "tsconfig.base.json"));
  const { output } = await cruise(CRUISE_DIRS, { ...opts, baseDir: tree, validate: true }, {}, { tsConfig });
  const result = output as ICruiseResult;
  const byFile = new Map<string, string[]>();
  for (const v of result.summary.violations) {
    byFile.set(v.from, [...(byFile.get(v.from) ?? []), v.rule.name]);
  }
  return byFile;
}

const RULE_NAMES = [...new Set(VIOLATIONS.map((v) => v.rule))];

describe("受け入れ条件 1・4・7: .dependency-cruiser.cjs の依存の向き（決定 2）", () => {
  let hits: Map<string, string[]>;

  beforeAll(async () => {
    hits = await cruiseTree(options);
  }, CRUISE_TIMEOUT);

  it("設定のすべての規則に、このテストの違反がある", () => {
    expect(forbiddenOf(options).map((r) => r.name).sort()).toEqual([...RULE_NAMES].sort());
  });

  it("型だけの import を数え、node_modules を辿らない", () => {
    expect(options.tsPreCompilationDeps).toBe(true);
    expect(options.doNotFollow).toEqual({ path: "node_modules" });
  });

  it("許された依存（形の正本から zod・core から形の正本・画面から clock 等と react・判定のモジュールから料金プランの値）には当たらない", () => {
    for (const path of Object.keys(ALLOWED_FILES)) {
      expect(hits.get(path) ?? [], path).toEqual([]);
    }
  });

  for (const v of VIOLATIONS) {
    it(`${v.rule}: ${v.note}（${v.file}）で、その規則の誤りが 1 件だけ出る`, () => {
      expect(hits.get(v.file) ?? [], v.file).toEqual([v.rule]);
    });
  }

  for (const rule of RULE_NAMES) {
    it(
      `${rule} を消した設定では、その違反が出なくなる`,
      async () => {
        const without = await cruiseTree({
          ...options,
          ruleSet: { ...options.ruleSet, forbidden: forbiddenOf(options).filter((r) => r.name !== rule) },
        });
        for (const v of VIOLATIONS.filter((x) => x.rule === rule)) {
          expect(without.get(v.file) ?? [], v.file).toEqual([]);
        }
      },
      CRUISE_TIMEOUT,
    );
  }

  it(
    "型だけの import を数えない設定では、型だけの import の違反が出なくなる",
    async () => {
      const without = await cruiseTree({ ...options, tsPreCompilationDeps: false });
      const typeOnly = VIOLATIONS.filter((v) => v.code.startsWith("import type "));
      expect(typeOnly.length).toBeGreaterThan(0);
      for (const v of typeOnly) {
        expect(without.get(v.file) ?? [], v.file).toEqual([]);
      }
    },
    CRUISE_TIMEOUT,
  );
});
