import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

// 画面の文書の「画面一覧」の表から、ルートごとの操作の名前の生成物を作る（正本は表の 1 か所）

export const SCREENS_DOC = resolve(fileURLToPath(new URL("../../../docs/design/screens.md", import.meta.url)));
const GENERATED = resolve(fileURLToPath(new URL("../src/routes/route-operations.generated.ts", import.meta.url)));

const HEADING = "画面一覧";
const ROUTE_COLUMN = "HTTP のルート";
const OPERATION_COLUMN = "読む・書く API の操作";
const OPERATION_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const ROUTE_IDS = Array.from({ length: 16 }, (_, i) => `R${i + 1}`);

type Node = { type: string; value?: string; depth?: number; children?: Node[] };

const textOf = (node: Node): string => node.value ?? (node.children ?? []).map(textOf).join("");
const codesOf = (node: Node): string[] =>
  node.type === "inlineCode" ? [node.value ?? ""] : (node.children ?? []).flatMap(codesOf);

export function parseScreensTable(markdown: string): Map<string, string[]> {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as Node;
  const blocks = tree.children ?? [];
  const start = blocks.findIndex((n) => n.type === "heading" && n.depth === 2 && textOf(n) === HEADING);
  const table = start < 0 ? undefined : blocks.slice(start + 1).find((n) => n.type === "table");
  if (!table) throw new Error(`見出し「## ${HEADING}」の後に表が無い`);
  const [header, ...body] = table.children ?? [];
  const titles = (header?.children ?? []).map(textOf);
  const column = (title: string) => {
    const index = titles.indexOf(title);
    if (index < 0) throw new Error(`表に列「${title}」が無い`);
    return index;
  };
  const routeAt = column(ROUTE_COLUMN);
  const operationAt = column(OPERATION_COLUMN);
  const map = new Map<string, string[]>();
  for (const row of body) {
    const cells = row.children ?? [];
    const id = /^R\d+/.exec(textOf(cells[routeAt] ?? { type: "text" }))?.[0];
    if (id === undefined) continue;
    const cell = cells[operationAt];
    map.set(id, cell ? [...new Set(codesOf(cell).filter((c) => OPERATION_NAME.test(c)))] : []);
  }
  const missing = ROUTE_IDS.filter((id) => !map.has(id));
  if (missing.length > 0 || map.size !== ROUTE_IDS.length) {
    throw new Error(`表のルートが R1〜R16 とそろわない: ${missing.join(", ")}`);
  }
  return map;
}

export function renderRouteOperations(map: Map<string, string[]>): string {
  const lines = [...map].map(([id, ops]) => `  ${id}: [${ops.map((o) => JSON.stringify(o)).join(", ")}],`);
  return [
    "// 画面の文書の「画面一覧」の表から scripts/build-route-operations.ts が作る。手で直さない",
    "",
    "export const ROUTE_OPERATIONS = {",
    ...lines,
    "} as const;",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const next = renderRouteOperations(parseScreensTable(await readFile(SCREENS_DOC, "utf8")));
    if (process.argv[2] !== "check") await writeFile(GENERATED, next);
    else if ((await readFile(GENERATED, "utf8").catch(() => "")) !== next) {
      throw new Error(`生成物が古い: ${GENERATED}（npm run generate で直す）`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
