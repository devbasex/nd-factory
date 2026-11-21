// 置き場の間の依存の向き（#1 の決定 2）。規則の表は issues/issue-1-design-detail.md の「dependency-cruiser の設定」にある。
// 依存は解決した先のファイルの置き場で照らす。workspaces の名前（`@nd-factory/*`）も相対のパスも、型だけの import も同じに数える

/** このリポジトリの置き場のファイル（`node_modules` の外） */
const REPO_FILE = "^(packages|apps|infra|tools)/";

/** 画面の外で使わない React の部品。解決したファイル（型の `@types/*` を含む）と、解決できない名前の両方で照らす */
const REACT_PACKAGES = "(react|react-dom|@vitejs/plugin-react|@types/react|@types/react-dom)";

/**
 * 料金プランの値のデータと、それを読む書き出しのファイル（#29 が置く。#1 の設計の「#29 へ渡す欠け」）。名前は
 * `eslint.config.js` の `PLAN_EXPORT`（`@nd-factory/contracts/plans`）と、事実と方針のデータの置き場
 * `packages/contracts/data/` に合わせる。`packages/contracts` の名前に `plan` を含むファイルがここに合わないと
 * `tools/test/deps-config.test.ts` が落ちる
 */
const PLAN_VALUE_FILES = "^packages/contracts/(data/plans\\.json|src/plans\\.ts)$";

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "contracts-depends-on-zod-only",
      comment: "形の正本は zod だけに依存する（全体の設計の依存の表）",
      severity: "error",
      from: { path: "^packages/contracts/src/" },
      to: { pathNot: ["^packages/contracts/", "^node_modules/zod/"] },
    },
    {
      name: "core-depends-on-contracts-only",
      comment: "横断の部品はこのリポジトリのうち形の正本だけに依存する",
      severity: "error",
      from: { path: "^packages/core/src/" },
      to: { path: REPO_FILE, pathNot: "^packages/(contracts|core)/" },
    },
    {
      name: "apps-do-not-import-each-other",
      comment: "apps/* どうしは import しない。共有するものは packages/ に置く",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "apps-do-not-import-infra-or-tools",
      comment: "apps/* は infra と tools を import しない",
      severity: "error",
      from: { path: "^apps/" },
      to: { path: "^(infra|tools)/" },
    },
    {
      name: "web-uses-browser-core-only",
      comment: "画面が使う横断の部品は、ブラウザーで動く clock・ids・redact・log だけ",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^packages/core/src/", pathNot: "^packages/core/src/(clock|ids|redact|log)([./]|$)" },
    },
    {
      name: "infra-depends-on-contracts-only",
      comment: "infra はこのリポジトリのうち形の正本だけを import する。apps/* の起点はパスの文字列で渡す（全体の設計の依存の表）",
      severity: "error",
      from: { path: "^infra/" },
      to: { path: "^(packages/core|apps|tools)/" },
    },
    {
      name: "tools-depends-on-contracts-only",
      comment: "tools はこのリポジトリのうち形の正本だけを import し、ほかの置き場は文字として読む",
      severity: "error",
      from: { path: "^tools/" },
      to: { path: "^(packages/core|apps|infra)/" },
    },
    {
      name: "react-only-in-web",
      comment: "React は画面（apps/web）の外で使わない（プラットフォームの決定 140）",
      severity: "error",
      from: { pathNot: "^apps/web/" },
      to: { path: [`(^|/)node_modules/${REACT_PACKAGES}/`, `^${REACT_PACKAGES}(/|$)`] },
    },
    {
      name: "plan-values-only-in-usage-limit",
      comment: "料金プランの値は使える量の判定（packages/core の usage-limit）だけが読む（I8）",
      severity: "error",
      from: { pathNot: ["^packages/core/src/usage-limit", "^packages/contracts/"] },
      to: { path: PLAN_VALUE_FILES },
    },
  ],
  options: {
    // 型だけの import も依存として数える
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    doNotFollow: { path: "node_modules" },
    // workspaces の名前の部分のパス（`@nd-factory/contracts/settings`）を package.json の exports で解決する
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["types", "import", "node", "default"],
    },
  },
};
