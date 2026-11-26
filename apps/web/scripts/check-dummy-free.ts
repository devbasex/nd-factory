import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 本番の成果物にダミーが入っていないことを、モジュールの一覧・残った書き出し・目印の 3 つで検査する

export type ModuleEntry = { id: string; renderedExports: string[] };

const DUMMY_DIRS = ["/apps/web/src/dummy/", "/packages/contracts/generated/dummy/"];
const CLIENT = "/packages/contracts/src/client.ts";
const MARK = "nd-factory:dummy-client";

export const MODULE_LIST = resolve(fileURLToPath(new URL("../../../node_modules/.cache/nd-web/modules.json", import.meta.url)));
// Service Worker は別のビルドなので、モジュールの一覧を分ける
export const SW_MODULE_LIST = resolve(fileURLToPath(new URL("../../../node_modules/.cache/nd-web/sw-modules.json", import.meta.url)));
const DIST = resolve(fileURLToPath(new URL("../dist", import.meta.url)));

export function findDummyLeaks(modules: ModuleEntry[], files: { path: string; text: string }[]): string[] {
  // 一覧が空のときは、プラグインが働いていないので通さない
  if (modules.length === 0) return ["モジュールの一覧が空である"];
  const leaks: string[] = [];
  for (const { id, renderedExports } of modules) {
    const path = id.replaceAll("\\", "/");
    if (DUMMY_DIRS.some((d) => path.includes(d))) leaks.push(`ダミーのモジュールが成果物にある: ${path}`);
    if (path.endsWith(CLIENT) && renderedExports.includes("createDummyTransport")) {
      leaks.push(`createDummyTransport が成果物に残っている: ${path}`);
    }
  }
  for (const file of files) {
    if (file.text.includes(MARK)) leaks.push(`目印 ${MARK} が成果物にある: ${file.path}`);
  }
  return leaks;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const lists = await Promise.all(
      [MODULE_LIST, SW_MODULE_LIST].map(async (path) => JSON.parse(await readFile(path, "utf8")) as ModuleEntry[]),
    );
    // どちらかが空なら、検査の漏れとして扱う
    const modules = lists.some((list) => list.length === 0) ? [] : lists.flat();
    const entries = await readdir(DIST, { recursive: true, withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((e) => e.isFile())
        .map(async (e) => ({ path: join(e.parentPath, e.name), text: await readFile(join(e.parentPath, e.name), "utf8") })),
    );
    const leaks = findDummyLeaks(modules, files);
    if (leaks.length > 0) throw new Error(leaks.join("\n"));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
