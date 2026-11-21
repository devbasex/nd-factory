import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESLint, type Linter } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// eslint.config.js の置き場ごとの塊が、違反の文字列を置き場のパスで lint すると落とすことを確かめる（#1 の決定 1・9）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** eslint.config.js の書き出しのうち、このテストが使うもの */
type LintConfigModule = {
  buildConfig: (options: { planNames: readonly string[] | null }) => Linter.Config[];
  loadPlanNames: (load: () => Promise<unknown>, required: boolean) => Promise<readonly string[] | null>;
};

// 作り物の料金プランの名前（#29 の書き出しの代わり）
const FAKE_PLAN_NAMES = ["Acme Free", "Acme Pro"];

let configModule: LintConfigModule;
let repoLint: ESLint;
let planLint: ESLint | undefined;

beforeAll(async () => {
  // 式で組んだ指定子の import は型を持たないので、このテストが読む形で受ける
  configModule = (await import(pathToFileURL(join(ROOT, "eslint.config.js")).href)) as LintConfigModule;
  repoLint = new ESLint({ cwd: ROOT });
});

/** 作り物の料金プランの名前を渡して組んだ設定で lint する ESLint */
function planLinter(): ESLint {
  planLint ??= new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: configModule.buildConfig({ planNames: FAKE_PLAN_NAMES }),
  });
  return planLint;
}

type Finding = { ruleId: string | null; message: string };

async function lint(code: string, filePath: string, eslint: ESLint = repoLint): Promise<Finding[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath) });
  if (result === undefined) throw new Error(`lint の結果が無い: ${filePath}`);
  return result.messages.map((m) => ({ ruleId: m.ruleId, message: m.message }));
}

async function ruleHits(code: string, filePath: string, ruleId: string, eslint?: ESLint): Promise<number> {
  return (await lint(code, filePath, eslint)).filter((f) => f.ruleId === ruleId).length;
}

// `apps/*` の実行時のコード（src の下）。画面は *.ts と *.tsx の両方
const APP_PATHS = [
  "apps/api/src/sample.ts",
  "apps/web/src/sample.ts",
  "apps/web/src/sample.tsx",
  "apps/runner/src/sample.ts",
  "apps/nd-runtime/src/sample.ts",
  "apps/db-prep/src/sample.ts",
];
// 横断の部品の規則を掛けない置き場
const NON_APP_PATHS = [
  "packages/core/src/sample.ts",
  "infra/lib/sample.ts",
  "tools/checks/src/sample.ts",
  "apps/api/test/sample.test.ts",
  "apps/web/e2e/sample.spec.ts",
];

describe("受け入れ条件 1・6: apps/* の横断の部品の外での直の利用（決定 1）", () => {
  const cases: { name: string; code: string; ruleId: string }[] = [
    { name: "Date.now", code: "export const t = Date.now();\n", ruleId: "no-restricted-properties" },
    { name: "Math.random", code: "export const r = Math.random();\n", ruleId: "no-restricted-properties" },
    { name: "crypto.randomUUID", code: "export const id = crypto.randomUUID();\n", ruleId: "no-restricted-properties" },
    {
      name: "crypto.getRandomValues",
      code: "export const b = crypto.getRandomValues(new Uint8Array(4));\n",
      ruleId: "no-restricted-properties",
    },
    { name: "引数なしの new Date()", code: "export const d = new Date();\n", ruleId: "no-restricted-syntax" },
    {
      name: "鍵 ConditionExpression を持つオブジェクト",
      code: 'export const input = { ConditionExpression: "attribute_not_exists(pk)" };\n',
      ruleId: "no-restricted-syntax",
    },
    {
      name: "文字列の鍵 ConditionExpression を持つオブジェクト",
      code: 'export const input = { "ConditionExpression": "attribute_not_exists(pk)" };\n',
      ruleId: "no-restricted-syntax",
    },
    { name: "console", code: 'console.log("x");\n', ruleId: "no-restricted-globals" },
    { name: "fetch", code: 'export const p = fetch("https://example.com");\n', ruleId: "no-restricted-globals" },
    { name: "globalThis.fetch（checkGlobalObject）", code: 'export const p = globalThis.fetch("https://example.com");\n', ruleId: "no-restricted-globals" },
    {
      name: "@aws-sdk/* の値の import",
      code: 'import { DynamoDBClient } from "@aws-sdk/client-dynamodb";\nexport const c = new DynamoDBClient({});\n',
      ruleId: "@typescript-eslint/no-restricted-imports",
    },
    {
      name: "node:http",
      code: 'import { request } from "node:http";\nexport const r = request;\n',
      ruleId: "@typescript-eslint/no-restricted-imports",
    },
    {
      name: "node:https",
      code: 'import { request } from "node:https";\nexport const r = request;\n',
      ruleId: "@typescript-eslint/no-restricted-imports",
    },
    {
      name: "http（node: を付けない表記）",
      code: 'import { request } from "http";\nexport const r = request;\n',
      ruleId: "@typescript-eslint/no-restricted-imports",
    },
    {
      name: "https（node: を付けない表記）",
      code: 'import { request } from "https";\nexport const r = request;\n',
      ruleId: "@typescript-eslint/no-restricted-imports",
    },
    {
      name: "uuid",
      code: 'import { v4 } from "uuid";\nexport const id = v4();\n',
      ruleId: "@typescript-eslint/no-restricted-imports",
    },
    {
      name: "globalThis から分割代入した console",
      code: 'const { console: c } = globalThis;\nc.log("x");\n',
      ruleId: "no-restricted-syntax",
    },
    {
      name: "globalThis から分割代入した fetch（代入の式）",
      code: 'let f;\n({ fetch: f } = globalThis);\nexport const g = f;\n',
      ruleId: "no-restricted-syntax",
    },
    {
      name: "node:console の import",
      code: 'import { log } from "node:console";\nlog("x");\n',
      ruleId: "@typescript-eslint/no-restricted-imports",
    },
    {
      name: "console の import",
      code: 'import { log } from "console";\nlog("x");\n',
      ruleId: "@typescript-eslint/no-restricted-imports",
    },
    {
      name: "@aws-sdk/* の動的な import",
      code: 'export const m = await import("@aws-sdk/client-dynamodb");\n',
      ruleId: "no-restricted-syntax",
    },
    {
      name: "@aws-sdk/* のテンプレートの文字列での動的な import",
      code: "export const m = await import(`@aws-sdk/client-dynamodb`);\n",
      ruleId: "no-restricted-syntax",
    },
    { name: "node:https の動的な import", code: 'export const m = await import("node:https");\n', ruleId: "no-restricted-syntax" },
    { name: "node:http の動的な import", code: 'export const m = await import("node:http");\n', ruleId: "no-restricted-syntax" },
    { name: "https の動的な import", code: 'export const m = await import("https");\n', ruleId: "no-restricted-syntax" },
    { name: "http の動的な import", code: 'export const m = await import("http");\n', ruleId: "no-restricted-syntax" },
    { name: "uuid の動的な import", code: 'export const m = await import("uuid");\n', ruleId: "no-restricted-syntax" },
    { name: "node:console の動的な import", code: 'export const m = await import("node:console");\n', ruleId: "no-restricted-syntax" },
  ];

  for (const c of cases) {
    it(`${c.name} を apps/* の src で落とす`, async () => {
      for (const path of APP_PATHS) {
        expect(await ruleHits(c.code, path, c.ruleId), path).toBeGreaterThan(0);
      }
    });

    it(`${c.name} を apps/* の外とテストでは落とさない`, async () => {
      for (const path of NON_APP_PATHS) {
        expect(await ruleHits(c.code, path, c.ruleId), path).toBe(0);
      }
    });
  }

  it("画面の src で window.fetch・self.fetch・window.console を落とす（checkGlobalObject）", async () => {
    for (const path of ["apps/web/src/sample.ts", "apps/web/src/sample.tsx"]) {
      for (const code of ['export const p = window.fetch("https://example.com");\n', 'export const p = self.fetch("https://example.com");\n', 'window.console.log("x");\n']) {
        expect(await ruleHits(code, path, "no-restricted-globals"), `${path}: ${code}`).toBe(1);
      }
    }
  });

  it("Node.js の apps/* の src で global.console・global.fetch を落とす（globalObjects）", async () => {
    for (const path of APP_PATHS.filter((p) => !p.startsWith("apps/web/"))) {
      for (const code of ['global.console.log("x");\n', 'export const p = global.fetch("https://example.com");\n']) {
        expect(await ruleHits(code, path, "no-restricted-globals"), `${path}: ${code}`).toBe(1);
      }
    }
  });

  it("大域のオブジェクトからのほかの名前の分割代入は落とさない", async () => {
    for (const path of APP_PATHS) {
      expect(await lint("const { Promise: P } = globalThis;\nexport const p = P;\n", path), path).toEqual([]);
    }
  });

  it("型だけの @aws-sdk/* の import と new Date(0) と、ほかの指定子の動的な import は落とさない", async () => {
    const code = [
      'import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";',
      "export type C = DynamoDBClient;",
      "export const d = new Date(0);",
      'export const z = await import("zod");',
      "",
    ].join("\n");
    for (const path of APP_PATHS) {
      expect(await lint(code, path), path).toEqual([]);
    }
  });
});

describe("受け入れ条件 1・6: apps/* の node:crypto（crypto）の ID と冪等の鍵の生成（決定 1）", () => {
  // 名前空間・既定の import と動的な import と export *（export * as）は丸ごと、名前つきの import と名前つきの再書き出しは
  // 名前に random を含む関数・getRandomValues・generatePrime・generatePrimeSync・webcrypto だけを落とす（subtle は乱数の関数を持たないので落とさない）
  const CRYPTO_PATHS = ["apps/api/src/sample.ts", "apps/web/src/sample.ts"];
  const IMPORTS_RULE = "@typescript-eslint/no-restricted-imports";
  const banned: { name: string; code: string; ruleId: string }[] = [
    { name: "名前空間の import", code: 'import * as c from "node:crypto";\nexport const h = c.createHash("sha256");\n', ruleId: IMPORTS_RULE },
    { name: "既定の import", code: 'import c from "node:crypto";\nexport const h = c.createHash("sha256");\n', ruleId: IMPORTS_RULE },
    { name: "動的な import", code: 'export const h = (await import("node:crypto")).createHash("sha256");\n', ruleId: "no-restricted-syntax" },
    { name: "名前つきの再書き出し", code: 'export { randomUUID } from "node:crypto";\n', ruleId: IMPORTS_RULE },
    { name: "webcrypto の名前つきの import", code: 'import { webcrypto } from "node:crypto";\nexport const id = webcrypto.randomUUID();\n', ruleId: IMPORTS_RULE },
    { name: "getRandomValues の名前つきの import", code: 'import { getRandomValues } from "node:crypto";\nexport const b = getRandomValues(new Uint8Array(4));\n', ruleId: IMPORTS_RULE },
    { name: "node: を付けない crypto の webcrypto の名前つきの import", code: 'import { webcrypto } from "crypto";\nexport const id = webcrypto.randomUUID();\n', ruleId: IMPORTS_RULE },
    { name: "node: を付けない crypto の getRandomValues の名前つきの import", code: 'import { getRandomValues } from "crypto";\nexport const b = getRandomValues(new Uint8Array(4));\n', ruleId: IMPORTS_RULE },
    { name: "webcrypto の名前つきの再書き出し", code: 'export { webcrypto } from "node:crypto";\n', ruleId: IMPORTS_RULE },
    { name: "getRandomValues の名前つきの再書き出し", code: 'export { getRandomValues } from "crypto";\n', ruleId: IMPORTS_RULE },
    { name: "randomFillSync の名前つきの import", code: 'import { randomFillSync } from "node:crypto";\nexport const id = randomFillSync(Buffer.alloc(16)).toString("hex");\n', ruleId: IMPORTS_RULE },
    { name: "randomFill の名前つきの import", code: 'import { randomFill } from "node:crypto";\nrandomFill(Buffer.alloc(16), () => undefined);\n', ruleId: IMPORTS_RULE },
    { name: "node: を付けない crypto の randomFillSync の名前つきの import", code: 'import { randomFillSync } from "crypto";\nexport const id = randomFillSync(Buffer.alloc(16)).toString("hex");\n', ruleId: IMPORTS_RULE },
    { name: "node: を付けない crypto の randomFill の名前つきの import", code: 'import { randomFill } from "crypto";\nrandomFill(Buffer.alloc(16), () => undefined);\n', ruleId: IMPORTS_RULE },
    { name: "randomFillSync の名前つきの再書き出し", code: 'export { randomFillSync } from "node:crypto";\n', ruleId: IMPORTS_RULE },
    { name: "randomFill の名前つきの再書き出し", code: 'export { randomFill } from "crypto";\n', ruleId: IMPORTS_RULE },
    { name: "randomInt の名前つきの import", code: 'import { randomInt } from "node:crypto";\nexport const id = randomInt(1_000_000).toString();\n', ruleId: IMPORTS_RULE },
    { name: "node: を付けない crypto の randomInt の名前つきの import", code: 'import { randomInt } from "crypto";\nexport const id = randomInt(1_000_000).toString();\n', ruleId: IMPORTS_RULE },
    { name: "randomInt の名前つきの再書き出し", code: 'export { randomInt } from "node:crypto";\n', ruleId: IMPORTS_RULE },
    { name: "export * の再書き出し", code: 'export * from "node:crypto";\n', ruleId: IMPORTS_RULE },
    { name: "export * as の再書き出し", code: 'export * as c from "node:crypto";\n', ruleId: IMPORTS_RULE },
    { name: "node: を付けない crypto の名前空間の import", code: 'import * as c from "crypto";\nexport const h = c.createHash("sha256");\n', ruleId: IMPORTS_RULE },
  ];

  for (const c of banned) {
    it(`${c.name}を apps/api と apps/web の src で落とす`, async () => {
      for (const path of CRYPTO_PATHS) {
        expect(await ruleHits(c.code, path, c.ruleId), path).toBeGreaterThan(0);
      }
    });
  }

  it("名前つきの randomUUID と randomBytes の import をそれぞれ 1 件ずつ落とす", async () => {
    const code = 'import { randomUUID, randomBytes } from "node:crypto";\nexport const id = randomUUID() + randomBytes(4).toString("hex");\n';
    for (const path of CRYPTO_PATHS) {
      expect(await ruleHits(code, path, IMPORTS_RULE), path).toBe(2);
    }
  });

  it("実行中の Node.js の node:crypto が書き出す乱数の関数と、それを持つ書き出しの名前つきの import をすべて落とす", async () => {
    // Node.js の版が上がって乱数の関数が増えたら、ここが落ちて importNames への追加を求める
    const crypto = await import("node:crypto");
    const names = Object.keys(crypto).filter((name) => /random|webcrypto|generatePrime/i.test(name));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      for (const path of CRYPTO_PATHS) {
        const code = `import { ${name} } from "node:crypto";\nexport const v = ${name};\n`;
        expect(await ruleHits(code, path, IMPORTS_RULE), `${name} ${path}`).toBe(1);
      }
    }
  });

  it("名前つきの subtle の import は落とさない", async () => {
    const code = 'import { subtle } from "node:crypto";\nexport const d = await subtle.digest("SHA-256", new Uint8Array(4));\n';
    for (const path of CRYPTO_PATHS) {
      expect(await lint(code, path), path).toEqual([]);
    }
  });

  it("名前つきの createHash の import は落とさない", async () => {
    for (const path of CRYPTO_PATHS) {
      expect(await lint('import { createHash } from "node:crypto";\nexport const h = createHash("sha256");\n', path), path).toEqual([]);
    }
  });

  it("名前つきの createHash の再書き出しは落とさない", async () => {
    for (const path of CRYPTO_PATHS) {
      expect(await lint('export { createHash } from "node:crypto";\n', path), path).toEqual([]);
      expect(await lint('export { createHash } from "crypto";\n', path), path).toEqual([]);
    }
  });

  it("型だけの import は落とさない", async () => {
    const code = [
      'import type * as C from "node:crypto";',
      'import type { randomUUID } from "crypto";',
      "export type T = typeof C.randomBytes | typeof randomUUID;",
      "",
    ].join("\n");
    for (const path of CRYPTO_PATHS) {
      expect(await lint(code, path), path).toEqual([]);
    }
  });

  it("apps/* の外（tools/）では落とさない", async () => {
    for (const c of banned) {
      expect(await lint(c.code, "tools/checks/src/sample.ts"), c.name).toEqual([]);
    }
  });
});

describe("受け入れ条件 1・5: 画面・apps/api・infra/lib での HTTP の経路の直書き（I14）", () => {
  const ROUTE_PATHS = ["apps/web/src/sample.ts", "apps/web/src/sample.tsx", "apps/api/src/sample.ts", "infra/lib/sample.ts"];
  const cases = [
    { name: "文字列", code: 'export const path = "/v1/users";\n' },
    { name: "テンプレートの文字列", code: "export const id = 1;\nexport const path = `/v1/users/${id}`;\n" },
  ];

  for (const c of cases) {
    it(`${c.name}の /v1/ を落とす`, async () => {
      for (const path of ROUTE_PATHS) {
        expect(await ruleHits(c.code, path, "no-restricted-syntax"), path).toBeGreaterThan(0);
      }
    });
  }

  it("/v1/ を含まない文字列と、経路の規則を掛けない置き場では落とさない", async () => {
    for (const path of ROUTE_PATHS) {
      expect(await lint('export const path = "/health";\n', path), path).toEqual([]);
    }
    for (const path of ["infra/bin/sample.ts", "infra/setup/sample.ts", "apps/runner/src/sample.ts", "packages/core/src/sample.ts", "tools/checks/src/sample.ts", "apps/web/test/sample.test.ts"]) {
      expect(await ruleHits(cases[0]!.code, path, "no-restricted-syntax"), path).toBe(0);
    }
  });
});

describe("受け入れ条件 1・5: 生成した画面の呼び出しは経路を形の正本の経路の登録から読む（K2-2・K2-3）", () => {
  // 生成先（K2-2）。画面の src の規則がそのまま掛かる
  const GENERATED_PATH = "apps/web/src/generated/calls.ts";
  const generatedCall = (path: string) =>
    [
      'import { httpRoutes } from "@nd-factory/contracts/routes";',
      "",
      "/** 自分の利用者を読む */",
      "export async function usersSelf(apiUrl: string, token: string, body: unknown, fetchFn: typeof fetch): Promise<Response> {",
      '  const route = httpRoutes["users.self"];',
      `  return fetchFn(\`\${apiUrl.replace(/\\/+$/, "")}${path}\`, {`,
      "    method: route.method,",
      '    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },',
      "    body: JSON.stringify(body),",
      "  });",
      "}",
      "",
    ].join("\n");

  it("経路の登録の書き出しから経路を読む生成の見本は、lint の誤りが 0 件", async () => {
    expect(await lint(generatedCall("${route.path}"), GENERATED_PATH)).toEqual([]);
  });

  it("操作の定義の経路を文字のまま書き出す生成は、経路の直書きとして落ちる", async () => {
    expect(await ruleHits(generatedCall("/v1/users/self"), GENERATED_PATH, "no-restricted-syntax")).toBe(1);
  });
});

describe("受け入れ条件 1・4: 画面での料金プランの名前の文字列（I8）", () => {
  it("料金プランの名前と同じ文字列・テンプレートの文字列を画面で落とす", async () => {
    for (const path of ["apps/web/src/sample.ts", "apps/web/src/sample.tsx"]) {
      expect(await ruleHits('export const isPro = (p: string) => p === "Acme Pro";\n', path, "no-restricted-syntax", planLinter()), path).toBe(1);
      expect(await ruleHits("export const p = `Acme Free`;\n", path, "no-restricted-syntax", planLinter()), path).toBe(1);
    }
  });

  it("画面の *.tsx の JSX の属性の値と本文で落とす", async () => {
    const attr = 'export const v = <div title="Acme Pro" />;\n';
    const text = "export const v = <span> Acme Pro </span>;\n";
    expect(await ruleHits(attr, "apps/web/src/sample.tsx", "no-restricted-syntax", planLinter())).toBe(1);
    expect(await ruleHits(text, "apps/web/src/sample.tsx", "no-restricted-syntax", planLinter())).toBe(1);
  });

  it("名前と違う文字列と、画面の外では落とさない", async () => {
    expect(await ruleHits('export const p = "Acme Pro plus";\n', "apps/web/src/sample.ts", "no-restricted-syntax", planLinter())).toBe(0);
    expect(await ruleHits('export const p = "Acme Pro";\n', "apps/api/src/sample.ts", "no-restricted-syntax", planLinter())).toBe(0);
  });

  it("画面の塊は横断の部品と経路の選び方も保つ（同じ規則を 1 つの塊にまとめる）", async () => {
    const code = 'export const d = new Date();\nexport const path = "/v1/users";\nexport const p = "Acme Pro";\n';
    expect(await ruleHits(code, "apps/web/src/sample.ts", "no-restricted-syntax", planLinter())).toBe(3);
  });

  it("全角の記号を含む名前も、文字列と JSX の本文で落とす（UTF-16 の符号単位ごとに逃がす）", async () => {
    const eslint = new ESLint({
      cwd: ROOT,
      overrideConfigFile: true,
      overrideConfig: configModule.buildConfig({ planNames: ["Acme（Pro）", "Acme/Team+", "Acme 🚀 Plus"] }),
    });
    const path = "apps/web/src/sample.tsx";
    for (const name of ["Acme（Pro）", "Acme/Team+", "Acme 🚀 Plus"]) {
      expect(await ruleHits(`export const p = "${name}";\n`, path, "no-restricted-syntax", eslint), name).toBe(1);
      expect(await ruleHits(`export const v = <span> ${name} </span>;\n`, path, "no-restricted-syntax", eslint), name).toBe(1);
    }
    expect(await ruleHits("export const v = <span> Acme（Pro）2 </span>;\n", path, "no-restricted-syntax", eslint)).toBe(0);
  });

  it("名前の書き出しが無い（planNames が null）なら名前の選び方を作らず、required が真なら読めないと失敗する", async () => {
    const missing = () => Promise.reject(new Error("書き出しが無い"));
    await expect(configModule.loadPlanNames(missing, false)).resolves.toBeNull();
    await expect(configModule.loadPlanNames(missing, true)).rejects.toThrow();
    await expect(configModule.loadPlanNames(() => Promise.resolve({ planNames: FAKE_PLAN_NAMES }), true)).resolves.toEqual(FAKE_PLAN_NAMES);
    await expect(configModule.loadPlanNames(() => Promise.resolve({ planNames: [1] }), true)).rejects.toThrow();
    // 名前が無ければ、画面で名前と同じ文字列を書いても選び方が無いので落ちない
    const noPlanLint = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: configModule.buildConfig({ planNames: null }) });
    expect(await ruleHits('export const p = "Acme Pro";\n', "apps/web/src/sample.ts", "no-restricted-syntax", noPlanLint)).toBe(0);
  });
});

describe("受け入れ条件 1・7: apps/web の外の *.tsx（決定 140）", () => {
  it("apps/web の外の *.tsx を 1 ファイル 1 件で落とす", async () => {
    const code = "export const a = 1;\nexport const b = 2;\n";
    for (const path of ["packages/core/src/sample.tsx", "apps/api/src/sample.tsx", "infra/lib/sample.tsx", "tools/checks/src/sample.tsx"]) {
      const hits = (await lint(code, path)).filter((f) => f.ruleId === "no-restricted-syntax");
      expect(hits.length, path).toBe(1);
    }
  });

  it("apps/web の外の *.tsx でも、ほかの塊の選び方を保つ", async () => {
    expect(await ruleHits("export const d = new Date();\n", "apps/api/src/sample.tsx", "no-restricted-syntax")).toBe(2);
    expect(await ruleHits('export const path = "/v1/users";\n', "infra/lib/sample.tsx", "no-restricted-syntax")).toBe(2);
  });

  it("apps/web の下の *.tsx は落とさない", async () => {
    for (const path of ["apps/web/src/sample.tsx", "apps/web/test/sample.test.tsx"]) {
      expect(await lint("export const a = 1;\n", path), path).toEqual([]);
    }
  });
});

describe("受け入れ条件 14: 使われなくなった除外の注釈（決定 9）", () => {
  it("違反の行の除外の注釈は効き、違反を直した後に残った注釈は誤りになる", async () => {
    const directive = "// eslint-disable-next-line no-restricted-properties -- #2 が横断の部品へ移す";
    for (const path of APP_PATHS) {
      expect(await lint(`${directive}\nexport const t = Date.now();\n`, path), path).toEqual([]);
      const unused = await lint(`${directive}\nexport const t = 0;\n`, path);
      expect(unused, path).toEqual([{ ruleId: null, message: expect.stringMatching(/Unused eslint-disable directive/) }]);
    }
  });

  it("規則を掛けない置き場に置いた注釈も、使われない注釈の誤りになる", async () => {
    const directive = "// eslint-disable-next-line no-restricted-properties -- #2 が横断の部品へ移す";
    for (const path of ["infra/lib/sample.ts", "tools/checks/src/sample.ts", "packages/core/src/sample.ts"]) {
      const unused = await lint(`${directive}\nexport const t = Date.now();\n`, path);
      expect(unused, path).toEqual([{ ruleId: null, message: expect.stringMatching(/Unused eslint-disable directive/) }]);
    }
  });

  it("使われない注釈は警告でなく誤りとして出る", async () => {
    const [result] = await repoLint.lintText("// eslint-disable-next-line no-console -- #2 が横断の部品へ移す\nexport const t = 0;\n", {
      filePath: join(ROOT, "apps/api/src/sample.ts"),
    });
    expect(result?.errorCount).toBe(1);
  });
});
