import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EXIT_CODES } from "../src/exit-codes.ts";
import { type Settings, settingsSchema } from "../src/settings.ts";

// 形の正本から 3 つの生成物を作る。手で直すと次の check で差が出るため、直すのは正本の側だけにする

export const SCHEMA_PATH = "packages/contracts/schema/settings.schema.json";
export const EXAMPLE_PATH = "infra/settings.example.json";
export const SETUP_DOC_PATH = "docs/operations/setup.md";

export const EXIT_BEGIN = "<!-- exit-codes:begin -->";
export const EXIT_END = "<!-- exit-codes:end -->";

// 見本は作り物の値だけにする。client_id は人が秘密の器へ値を入れた後に足すキーなので、見本に入れない
const EXAMPLE: Settings = { prefix: "acme", environment: "test", login: { google: {} } };

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

export async function generateArtifacts(root: string, mode: Mode): Promise<string[]> {
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
  ];

  if (mode === "check") {
    const differ: string[] = [];
    for (const [rel, text] of wanted) {
      const current = rel === SETUP_DOC_PATH ? currentSetup : await readOrNull(join(root, rel));
      if (text === null || current !== text) differ.push(rel);
    }
    return differ;
  }

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
