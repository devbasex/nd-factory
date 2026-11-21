import js from "@eslint/js";
import tseslint from "typescript-eslint";

// 置き場ごとの塊の中身は issues/issue-1-design-detail.md の「ESLint の設定」の表にある（#1 の決定 1・9）

/**
 * #29 が料金プランの名前の書き出しを置いたら真にする。偽の間は書き出しが読めなければ名前の選び方を作らず、
 * 真になった後は読めないと設定の読み込みが失敗する
 */
export const PLAN_EXPORT_REQUIRED = false;

/** 料金プランの名前の書き出し（#29 が置く）。書き出しの `planNames` は名前の文字列の配列 */
const PLAN_EXPORT = "@nd-factory/contracts/plans";

/**
 * 料金プランの名前を読む。`required` が偽なら読めないときに null を返し、真なら例外を投げる。
 * 読めたのに形が文字列の配列でなければ、`required` によらず例外を投げる
 */
export async function loadPlanNames(load = () => import(PLAN_EXPORT), required = PLAN_EXPORT_REQUIRED) {
  let mod;
  try {
    mod = await load();
  } catch (error) {
    if (required) throw new Error(`料金プランの名前の書き出し ${PLAN_EXPORT} を読めない`, { cause: error });
    return null;
  }
  const names = mod?.planNames;
  if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === "string" && n.length > 0)) {
    throw new Error(`料金プランの名前の書き出し ${PLAN_EXPORT} の planNames が空でない文字列の配列でない`);
  }
  return names;
}

// 実行時のコードの置き場（`apps/*` の src）。テストのディレクトリと e2e を含まない
const APP_DIRS = ["api", "web", "runner", "nd-runtime", "db-prep"];
const WEB_SRC = ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"];
const API_SRC = ["apps/api/src/**/*.ts", "apps/api/src/**/*.tsx"];
const OTHER_APP_SRC = APP_DIRS.filter((d) => d !== "api" && d !== "web").flatMap((d) => [
  `apps/${d}/src/**/*.ts`,
  `apps/${d}/src/**/*.tsx`,
]);
const INFRA_LIB = ["infra/lib/**/*.ts", "infra/lib/**/*.tsx"];

const BOUNDARY = "は横断の部品だけが使う（#1 の決定 1・プラットフォームの決定 91）";

/** `node:crypto`（`crypto`）のうち、ID と冪等の鍵の生成に当たる関数 */
const CRYPTO_ID_FUNCTIONS = new Set(["randomUUID", "randomBytes"]);
const CRYPTO_SOURCE = /^(node:)?crypto$/;
const CRYPTO_MESSAGE = `ID と冪等の鍵の生成${BOUNDARY}`;

/** 文字列の値（文字列の Literal か、式を持たないテンプレートの文字列）。ほかは null */
function staticString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/** 性質の参照・分割代入の鍵の名前（計算した鍵は文字列の値のときだけ）。ほかは null */
function keyName(key, computed) {
  if (!computed && key.type === "Identifier") return key.name;
  return staticString(key);
}

/** 型だけの import・export の宣言か指定子 */
const typeOnly = (node) => node.importKind === "type" || node.exportKind === "type";

/**
 * `node:crypto`（`crypto`）の `randomUUID`・`randomBytes` を、どの書き方で取り出しても落とす規則。
 * `no-restricted-imports` の `importNames` は名前空間の import を丸ごと落とし、既定の import と動的な import
 * からの取り出しを見ないので、モジュールの値を束縛まで追って、対象の関数を取り出したところだけを落とす。
 * 見るのは名前つきの import・名前空間と既定の import の束縛・動的な import（`await` と `.then` の引数）・
 * 再書き出しで、モジュールの値（とその `.default`）の性質の参照・分割代入・別の名前への代入を追う
 */
const noCryptoIdRule = {
  meta: { type: "problem", schema: [], messages: { banned: CRYPTO_MESSAGE } },
  create(context) {
    const { sourceCode } = context;
    const report = (node) => context.report({ node, messageId: "banned" });
    const seen = new Set();

    function findVariable(node, name) {
      for (let scope = sourceCode.getScope(node); scope !== null; scope = scope.upper) {
        const found = scope.set.get(name);
        if (found !== undefined) return found;
      }
      return null;
    }

    /** モジュールの値を持つ変数の読み出しを、すべてモジュールの値として追う */
    function trackVariable(variable) {
      if (variable === null || seen.has(variable)) return;
      seen.add(variable);
      for (const ref of variable.references) {
        if (ref.isRead()) checkModuleValue(ref.identifier);
      }
    }

    /** モジュールの値を受ける束縛の形（識別子・分割代入・既定の値つき） */
    function checkTarget(target, at) {
      if (target.type === "AssignmentPattern") return checkTarget(target.left, at);
      if (target.type === "Identifier") return trackVariable(findVariable(at, target.name));
      if (target.type === "ObjectPattern") return checkPattern(target, at);
    }

    function checkPattern(pattern, at) {
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") {
          checkTarget(prop.argument, at);
          continue;
        }
        const name = keyName(prop.key, prop.computed);
        if (CRYPTO_ID_FUNCTIONS.has(name)) report(prop);
        else if (name === "default") checkTarget(prop.value, at);
      }
    }

    /** `node` の評価の値がモジュール（かその `.default`）のとき、その使われ方を見る */
    function checkModuleValue(node) {
      const parent = node.parent;
      switch (parent?.type) {
        case "TSAsExpression":
        case "TSNonNullExpression":
        case "TSSatisfiesExpression":
        case "TSTypeAssertion":
        case "ChainExpression":
          return checkModuleValue(parent);
        case "MemberExpression": {
          if (parent.object !== node) return;
          const name = keyName(parent.property, parent.computed);
          if (CRYPTO_ID_FUNCTIONS.has(name)) return report(parent);
          if (name === "default") return checkModuleValue(parent);
          return;
        }
        case "VariableDeclarator":
          if (parent.init === node) checkTarget(parent.id, parent);
          return;
        case "AssignmentExpression":
          if (parent.right === node) checkTarget(parent.left, parent);
          return;
      }
    }

    /** 動的な import の約束の値（`await` か `.then` の関数の最初の引数）を見る */
    function checkImportPromise(node) {
      const parent = node.parent;
      if (parent?.type === "AwaitExpression") return checkModuleValue(parent);
      if (
        parent?.type === "MemberExpression" &&
        parent.object === node &&
        keyName(parent.property, parent.computed) === "then" &&
        parent.parent?.type === "CallExpression" &&
        parent.parent.callee === parent
      ) {
        const callback = parent.parent.arguments[0];
        const param = callback?.params?.[0];
        if (param !== undefined) checkTarget(param, callback.body);
      }
    }

    const isCryptoSource = (source) => CRYPTO_SOURCE.test(staticString(source) ?? "");

    return {
      ImportDeclaration(node) {
        if (!isCryptoSource(node.source) || typeOnly(node)) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            if (!typeOnly(spec) && CRYPTO_ID_FUNCTIONS.has(keyName(spec.imported, false))) report(spec);
            else if (!typeOnly(spec) && keyName(spec.imported, false) === "default") {
              sourceCode.getDeclaredVariables(spec).forEach(trackVariable);
            }
          } else {
            sourceCode.getDeclaredVariables(spec).forEach(trackVariable);
          }
        }
      },
      ImportExpression(node) {
        if (isCryptoSource(node.source)) checkImportPromise(node);
      },
      ExportNamedDeclaration(node) {
        if (node.source === null || node.source === undefined || !isCryptoSource(node.source) || typeOnly(node)) return;
        for (const spec of node.specifiers) {
          const name = keyName(spec.local, false);
          if (!typeOnly(spec) && (CRYPTO_ID_FUNCTIONS.has(name) || name === "default")) report(spec);
        }
      },
      ExportAllDeclaration(node) {
        if (isCryptoSource(node.source) && !typeOnly(node)) report(node);
      },
    };
  },
};

/** このリポジトリの規則（`nd-factory/<名前>`） */
const localPlugin = { rules: { "no-crypto-id": noCryptoIdRule } };

/** `apps/*` の src で、横断の部品の外での直の利用を落とす選び方（`no-restricted-syntax` 以外） */
const boundaryRules = {
  "nd-factory/no-crypto-id": "error",
  "no-restricted-properties": [
    "error",
    { object: "Date", property: "now", message: `時計${BOUNDARY}` },
    { object: "Math", property: "random", message: `ID と冪等の鍵の生成${BOUNDARY}` },
    { object: "crypto", property: "randomUUID", message: `ID と冪等の鍵の生成${BOUNDARY}` },
    { object: "crypto", property: "getRandomValues", message: `ID と冪等の鍵の生成${BOUNDARY}` },
  ],
  "no-restricted-globals": [
    "error",
    {
      globals: [
        { name: "console", message: `ログと伏せ字${BOUNDARY}` },
        { name: "fetch", message: `外部の呼び出し${BOUNDARY}` },
      ],
      checkGlobalObject: true,
      // Node.js の大域のオブジェクト `global` からの参照も落とす（既定は globalThis・self・window）
      globalObjects: ["global"],
    },
  ],
  "@typescript-eslint/no-restricted-imports": [
    "error",
    {
      paths: [
        // Node.js は `node:` を付けない指定子も受け付けるので、両方の表記を落とす
        ...["node:http", "http", "node:https", "https"].map((name) => ({
          name,
          message: `外部の呼び出し${BOUNDARY}`,
          allowTypeImports: true,
        })),
        { name: "uuid", message: `ID と冪等の鍵の生成${BOUNDARY}`, allowTypeImports: true },
        { name: "node:console", message: `ログと伏せ字${BOUNDARY}`, allowTypeImports: true },
        { name: "console", message: `ログと伏せ字${BOUNDARY}`, allowTypeImports: true },
      ],
      patterns: [
        {
          group: ["@aws-sdk/*"],
          message: `外部の呼び出し・条件つきの書き込み・操作の記録の書き手${BOUNDARY}`,
          allowTypeImports: true,
        },
      ],
    },
  ],
};

/**
 * 動的な import（`import("…")`）で丸ごと落とす指定子。静的な import は `no-restricted-imports` が落とすが、
 * 動的な import には掛からないので `no-restricted-syntax` で同じ対象を落とす
 */
const DYNAMIC_IMPORT_BANS = [
  { source: "^@aws-sdk\\x2F", message: `外部の呼び出し・条件つきの書き込み・操作の記録の書き手${BOUNDARY}` },
  { source: "^(node:)?https?$", message: `外部の呼び出し${BOUNDARY}` },
  { source: "^uuid$", message: `ID と冪等の鍵の生成${BOUNDARY}` },
  { source: "^(node:)?console$", message: `ログと伏せ字${BOUNDARY}` },
];
const dynamicImportSyntax = DYNAMIC_IMPORT_BANS.flatMap(({ source, message }) => [
  { selector: `ImportExpression[source.value=/${source}/]`, message },
  { selector: `ImportExpression > TemplateLiteral > TemplateElement[value.cooked=/${source}/]`, message },
]);

/**
 * 大域のオブジェクトからの分割代入（`const { console } = globalThis`）。`no-restricted-globals` の
 * `checkGlobalObject` は性質の参照だけを見るので、分割代入は `no-restricted-syntax` で落とす
 */
const GLOBAL_OBJECT_NAME = "/^(globalThis|global|window|self)$/";
const RESTRICTED_GLOBAL_KEY = ":matches([key.name=/^(console|fetch)$/], [key.value=/^(console|fetch)$/])";
const globalDestructureSyntax = [
  `VariableDeclarator[init.name=${GLOBAL_OBJECT_NAME}] > ObjectPattern > Property${RESTRICTED_GLOBAL_KEY}`,
  `AssignmentExpression[right.name=${GLOBAL_OBJECT_NAME}] > ObjectPattern > Property${RESTRICTED_GLOBAL_KEY}`,
].map((selector) => ({ selector, message: `ログと伏せ字・外部の呼び出し${BOUNDARY}` }));

/** `apps/*` の src で、時計と条件つきの書き込みと動的な import と大域のオブジェクトからの分割代入を落とす `no-restricted-syntax` の選び方 */
const boundarySyntax = [
  ...dynamicImportSyntax,
  ...globalDestructureSyntax,
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: `時計${BOUNDARY}` },
  { selector: "Property[key.name='ConditionExpression']", message: `条件つきの書き込み${BOUNDARY}` },
  { selector: "Property[key.value='ConditionExpression']", message: `条件つきの書き込み${BOUNDARY}` },
];

/** 画面・`apps/api`・`infra/lib` で経路の直書きを落とす選び方（I14・K2-2・K2-3）。`\x2F` は `/` */
const ROUTE_MESSAGE = "HTTP の経路は形の正本の経路の登録の書き出しからだけ読む（I14）";
const routeSyntax = [
  { selector: "Literal[value=/\\x2Fv1\\x2F/]", message: ROUTE_MESSAGE },
  { selector: "TemplateElement[value.raw=/\\x2Fv1\\x2F/]", message: ROUTE_MESSAGE },
];

/** 選び方の文字列の値に置けるよう、`\` と `"` を逃がす */
function selectorString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * 正規表現に置けるよう、記号を UTF-16 の符号単位ごとに `\uXXXX` の形に逃がす（`/` を含めて選び方の区切りに
 * 当たらないようにする。`\x` は 2 桁しか読まないので全角の記号に使えない）
 */
function regexpLiteral(value) {
  return value.replace(/[^\p{L}\p{N} _-]/gu, (c) =>
    Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""),
  );
}

/** 画面で料金プランの名前と同じ文字列を落とす選び方（I8）。JSX の属性の値は Literal、本文は JSXText */
function planSyntax(planNames) {
  const message = "画面は料金プランの名前で分けない。API が返す「使えるか」と理由のコードだけを見る（I8）";
  return planNames.flatMap((name) => [
    { selector: `Literal[value=${selectorString(name)}]`, message },
    { selector: `TemplateElement[value.cooked=${selectorString(name)}]`, message },
    { selector: `JSXText[value=/^\\s*${regexpLiteral(name)}\\s*$/]`, message },
  ]);
}

/** `apps/web` の外の `*.tsx` を 1 ファイル 1 件で落とす選び方（プラットフォームの決定 140） */
const tsxOutsideWebSyntax = [
  { selector: "Program", message: "画面（apps/web）の外は TSX を使わない（プラットフォームの決定 140）" },
];

/** `files` の glob のうち `*.ts` だけ・`*.tsx` だけを取り出す */
const onlyTs = (globs) => globs.filter((g) => g.endsWith(".ts"));
const onlyTsx = (globs) => globs.filter((g) => g.endsWith(".tsx"));

/**
 * 設定を組む。ESLint は同じ規則を後の塊で上書きするので、同じファイルに掛かる `no-restricted-syntax` の
 * 選び方は、置き場が重なる組ごとに 1 つの塊へまとめる。`planNames` が null なら名前の選び方を作らない
 */
export function buildConfig({ planNames }) {
  const plan = planNames === null ? [] : planSyntax(planNames);
  const syntax = (...groups) => ({ "no-restricted-syntax": ["error", ...groups.flat()] });
  return tseslint.config(
    {
      ignores: ["**/node_modules/**", "**/dist/**", "**/cdk.out/**", "**/test-results/**", "**/playwright-report/**"],
    },
    {
      // 除外の注釈が使われなくなったら誤りにする（#1 の決定 9）。files を持たないのですべての塊に掛かる
      linterOptions: { reportUnusedDisableDirectives: "error" },
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ["**/*.ts", "**/*.tsx"],
      rules: {
        "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
        "@typescript-eslint/consistent-type-imports": "error",
      },
    },
    { files: [...WEB_SRC, ...API_SRC, ...OTHER_APP_SRC], plugins: { "nd-factory": localPlugin }, rules: boundaryRules },
    // 画面の大域のオブジェクトを知らせ、`window.fetch` と `self.fetch` も `checkGlobalObject` で落とす
    { files: WEB_SRC, languageOptions: { globals: { window: "readonly", self: "readonly" } } },
    // Node.js の大域のオブジェクトを知らせ、`global.console` と `global.fetch` も `checkGlobalObject` で落とす
    { files: [...API_SRC, ...OTHER_APP_SRC], languageOptions: { globals: { global: "readonly" } } },
    // 画面: 横断の部品・料金プランの名前・経路
    { files: WEB_SRC, rules: syntax(boundarySyntax, plan, routeSyntax) },
    // apps/api: 横断の部品・経路（*.tsx は画面の外の TSX も）
    { files: onlyTs(API_SRC), rules: syntax(boundarySyntax, routeSyntax) },
    { files: onlyTsx(API_SRC), rules: syntax(boundarySyntax, routeSyntax, tsxOutsideWebSyntax) },
    // ほかの apps/*: 横断の部品（*.tsx は画面の外の TSX も）
    { files: onlyTs(OTHER_APP_SRC), rules: syntax(boundarySyntax) },
    { files: onlyTsx(OTHER_APP_SRC), rules: syntax(boundarySyntax, tsxOutsideWebSyntax) },
    // infra/lib: 経路（*.tsx は画面の外の TSX も）
    { files: onlyTs(INFRA_LIB), rules: syntax(routeSyntax) },
    { files: onlyTsx(INFRA_LIB), rules: syntax(routeSyntax, tsxOutsideWebSyntax) },
    // 上のどれにも当たらない、apps/web の外の *.tsx
    {
      files: ["**/*.tsx"],
      ignores: ["apps/web/**", ...onlyTsx(API_SRC), ...onlyTsx(OTHER_APP_SRC), ...onlyTsx(INFRA_LIB)],
      rules: syntax(tsxOutsideWebSyntax),
    },
  );
}

export default buildConfig({ planNames: await loadPlanNames() });
