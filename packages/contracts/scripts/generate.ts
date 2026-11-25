import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EXIT_CODES } from "../src/exit-codes.ts";
import type { OperationDef } from "../src/operation.ts";
import { type Settings, settingsSchema } from "../src/settings.ts";

// 形の正本から生成物を作る（設定の 3 つと、操作の表からの generated/*）。手で直すと次の check で差が出るため、直すのは正本の側だけにする

export const SCHEMA_PATH = "packages/contracts/schema/settings.schema.json";
export const EXAMPLE_PATH = "infra/settings.example.json";
export const SETUP_DOC_PATH = "docs/operations/setup.md";

export const GENERATED_DIR = "packages/contracts/generated";
export const DUMMY_DIR = `${GENERATED_DIR}/dummy`;

export const EXIT_BEGIN = "<!-- exit-codes:begin -->";
export const EXIT_END = "<!-- exit-codes:end -->";

// 見本は作り物の値だけにする。client_id は人が秘密の器へ値を入れた後に足すキーなので、見本に入れない
// インフラのキーは既定と同じ値で書き、どのキーを書けるかを見本で示す
const EXAMPLE: Settings = {
  prefix: "acme",
  environment: "test",
  login: { google: {} },
  network: { vpc_cidr: "10.80.0.0/16" },
  progress_db: { max_acu: 2 },
  budget: { monthly_usd: 30, scope: "tags" },
  ops: { notify_emails: [] },
};

export class GenerateError extends Error {
  override name = "GenerateError";
}

type Mode = "write" | "check";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function schemaText(): string {
  return json(z.toJSONSchema(settingsSchema));
}

function exampleText(): string {
  const checked = settingsSchema.safeParse(EXAMPLE);
  if (!checked.success) throw new GenerateError("見本が設定のファイルの形に合わない");
  return json(EXAMPLE);
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function exitTable(): string {
  const rows = EXIT_CODES.map((c) => `| ${c.code} | \`${c.name}\` | ${cell(c.meaning)} | ${cell(c.aws_write)} |`);
  return ["| 終了コード | 名前 | 意味 | AWS へ書いたか |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function minimalSetupDoc(): string {
  return `# 設置の手順\n\n${EXIT_BEGIN}\n${EXIT_END}\n`;
}

// 印の間だけを表へ置き換える。印の外は別の手で書く本文なので触らない
function setupDocText(current: string | null): string {
  const base = current ?? minimalSetupDoc();
  const begin = base.indexOf(EXIT_BEGIN);
  const end = base.indexOf(EXIT_END);
  if (begin < 0 || end < 0 || end < begin) {
    throw new GenerateError(`${SETUP_DOC_PATH} に ${EXIT_BEGIN} と ${EXIT_END} の印が順に無い`);
  }
  const head = base.slice(0, begin + EXIT_BEGIN.length);
  const tail = base.slice(end);
  return `${head}\n${exitTable()}\n${tail}`;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// 見本の問題を表に出す数。残りは件数だけを出す
const SHOWN_PROBLEMS = 10;

// 操作の表からの生成物。見本の照らしで外れれば何も書かずに投げる（終了コード 2）
async function operationFiles(ops: readonly OperationDef[]): Promise<Array<[string, string]>> {
  // 操作の表とデータの読み込みの誤り（印の食い違い）も、ここで投げて終了コード 2 にするため、組む関数は呼ぶときに読む
  const a = await import("./artifacts.ts");
  const problems = a.checkExamples(ops);
  if (problems.length > 0) {
    const shown = problems.slice(0, SHOWN_PROBLEMS).map((p) => `${p.operation} の ${p.scene}[${p.index}]: ${p.problem}`);
    throw new GenerateError(`見本の照らしで ${problems.length} 件の問題がある\n${shown.join("\n")}`);
  }
  const schemas = a.buildOperationSchemas(ops);
  const dummies = ops.map((op) => [op.name, a.buildDummy(op)] as const);
  const index = Object.fromEntries(dummies.map(([name, doc]) => [name, doc === null ? null : `${name}.json`]));
  return [
    [`${GENERATED_DIR}/operations.schema.json`, json(schemas)],
    [`${GENERATED_DIR}/openapi.json`, json(a.buildOpenApi(ops))],
    [`${GENERATED_DIR}/mcp-tools.json`, json(a.buildMcpTools(ops, schemas))],
    [`${GENERATED_DIR}/routes.json`, json(a.buildRoutes(ops))],
    [`${GENERATED_DIR}/reasons.json`, json(a.buildReasons(ops))],
    [`${GENERATED_DIR}/pending.json`, json(a.buildPending(ops))],
    [`${DUMMY_DIR}/index.json`, json(index)],
    ...dummies.flatMap(([name, doc]): Array<[string, string]> => (doc === null ? [] : [[`${DUMMY_DIR}/${name}.json`, json(doc)]])),
  ];
}

// generated/dummy/ の直下の通常のファイルで、名前が .json で終わり、どの操作にも当たらないもの。
// 生成が書くのはこの形だけなので、サブディレクトリや .json でない補助のファイルは対象にせず消さない
async function staleDummies(root: string, wanted: ReadonlySet<string>): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(root, DUMMY_DIR), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((d) => d.isFile() && d.name.endsWith(".json"))
    .map((d) => `${DUMMY_DIR}/${d.name}`)
    .filter((rel) => !wanted.has(rel))
    .sort();
}

export async function generateArtifacts(root: string, mode: Mode): Promise<string[]> {
  const { OPERATIONS } = await import("../src/operations/index.ts");
  return generateArtifactsFor(root, mode, OPERATIONS);
}

// 操作の表を渡して生成する。generateArtifacts は操作の表（OPERATIONS）でこれを呼び、テストは表を変えて呼ぶ
export async function generateArtifactsFor(root: string, mode: Mode, ops: readonly OperationDef[]): Promise<string[]> {
  const currentSetup = await readOrNull(join(root, SETUP_DOC_PATH));
  let setupWanted: string | null;
  try {
    setupWanted = setupDocText(currentSetup);
  } catch (e) {
    // check では印の無い文書も「違う」として返し、write では書き換えずに止める
    if (mode === "check" && e instanceof GenerateError) setupWanted = null;
    else throw e;
  }
  const wanted: Array<[string, string | null]> = [
    [SCHEMA_PATH, schemaText()],
    [EXAMPLE_PATH, exampleText()],
    [SETUP_DOC_PATH, setupWanted],
    ...(await operationFiles(ops)),
  ];
  const stale = await staleDummies(root, new Set(wanted.map(([rel]) => rel)));

  if (mode === "check") {
    const differ: string[] = [];
    for (const [rel, text] of wanted) {
      const current = rel === SETUP_DOC_PATH ? currentSetup : await readOrNull(join(root, rel));
      if (text === null || current !== text) differ.push(rel);
    }
    return [...differ, ...stale];
  }

  for (const rel of stale) await rm(join(root, rel), { force: true });
  for (const [rel, text] of wanted) {
    if (text === null) continue;
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  return [];
}

async function main(argv: string[]): Promise<number> {
  const mode = argv[0];
  if (argv.length !== 1 || (mode !== "write" && mode !== "check")) {
    process.stderr.write("使い方: node packages/contracts/scripts/generate.ts write|check\n");
    return 2;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    const differ = await generateArtifacts(root, mode);
    if (differ.length > 0) {
      for (const p of differ) process.stdout.write(`${p}\n`);
      process.stderr.write("生成物が形の正本と違う。npm run generate を打ってコミットし直す\n");
      return 1;
    }
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
