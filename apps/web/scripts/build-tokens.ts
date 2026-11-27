import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import StyleDictionary from "style-dictionary";

// 見た目の値の JSON（Design Tokens Format）から CSS の変数を作る。write は書き出し、check はコミットした生成物と比べる

export const TOKENS_DIR = resolve(fileURLToPath(new URL("../src/ui", import.meta.url)));
const OUTPUT = "tokens.generated.css";

async function variables(source: string): Promise<string[]> {
  const dictionary = new StyleDictionary({
    source: [source],
    platforms: {
      css: {
        // 値は JSON に書いた単位と色の字のまま写すので、名前の変換だけを掛ける
        transforms: ["name/kebab"],
        files: [{ destination: OUTPUT, format: "css/variables" }],
      },
    },
    log: { warnings: "error", verbosity: "silent", errors: { brokenReferences: "throw" } },
  });
  const [file] = await dictionary.formatPlatform("css");
  return String(file?.output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("--"));
}

async function render(dir: string): Promise<string> {
  const light = await variables(join(dir, "tokens.json"));
  const dark = await variables(join(dir, "tokens.dark.json"));
  const block = (lines: string[], indent: string) => lines.map((l) => `${indent}${l}`).join("\n");
  return [
    "/* tokens.json と tokens.dark.json から scripts/build-tokens.ts が作る。手で直さない */",
    ":root {",
    block(light, "  "),
    "}",
    "@media (prefers-color-scheme: dark) {",
    "  :root {",
    block(dark, "    "),
    "  }",
    "}",
    "",
  ].join("\n");
}

export async function buildTokens(mode: "write" | "check", dir: string = TOKENS_DIR): Promise<void> {
  const css = await render(dir);
  const path = join(dir, OUTPUT);
  if (mode === "write") {
    await writeFile(path, css);
    return;
  }
  const current = await readFile(path, "utf8").catch(() => "");
  if (current !== css) throw new Error(`生成物が古い: ${path}（npm run generate で直す）`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] === "check" ? "check" : "write";
  try {
    await buildTokens(mode);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
