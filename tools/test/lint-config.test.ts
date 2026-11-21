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
      name: "crypto（node: を付けない表記）の randomUUID",
      code: 'import { randomUUID } from "crypto";\nexport const id = randomUUID();\n',
      ruleId: "@typescript-eslint/no-restricted-imports",
    },
    {
      name: "crypto（node: を付けない表記）の randomBytes",
      code: 'import { randomBytes } from "crypto";\nexport const b = randomBytes(4);\n',
      ruleId: "@typescript-eslint/no-restricted-imports",
    },
    {
      name: "node:crypto の randomUUID",
      code: 'import { randomUUID } from "node:crypto";\nexport const id = randomUUID();\n',
      ruleId: "@typescript-eslint/no-restricted-imports",
    },
    {
      name: "node:crypto の randomBytes",
      code: 'import { randomBytes } from "node:crypto";\nexport const b = randomBytes(4);\n',
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
    ...["node:crypto", "crypto"].flatMap((source) => [
      {
        name: `${source} の動的な import の randomUUID の直の参照`,
        code: `export const id = (await import("${source}")).randomUUID();\n`,
        ruleId: "no-restricted-syntax",
      },
      {
        name: `${source} の動的な import の randomBytes の直の参照（計算した鍵・テンプレートの文字列）`,
        code: `export const b = (await import(\`${source}\`))["randomBytes"](4);\n`,
        ruleId: "no-restricted-syntax",
      },
      {
        name: `${source} の動的な import からの randomUUID の分割代入`,
        code: `const { randomUUID } = await import("${source}");\nexport const id = randomUUID();\n`,
        ruleId: "no-restricted-syntax",
      },
      {
        name: `${source} の動的な import からの randomBytes の分割代入（代入の式）`,
        code: `let r;\n({ randomBytes: r } = await import("${source}"));\nexport const b = r;\n`,
        ruleId: "no-restricted-syntax",
      },
    ]),
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

  it("型だけの @aws-sdk/* の import と new Date(0) と node:crypto の他の名前と、ほかの指定子の動的な import は落とさない", async () => {
    const code = [
      'import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";',
      'import { createHash } from "node:crypto";',
      "export type C = DynamoDBClient;",
      "export const d = new Date(0);",
      'export const h = createHash("sha256");',
      'export const z = await import("zod");',
      'export const h2 = (await import("node:crypto")).createHash("sha256");',
      'const { createHash: ch } = await import("crypto");',
      "export const h3 = ch;",
      'const { randomUUID: ru } = await import("zod");',
      "export const z2 = ru;",
      "",
    ].join("\n");
    for (const path of APP_PATHS) {
      expect(await lint(code, path), path).toEqual([]);
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
