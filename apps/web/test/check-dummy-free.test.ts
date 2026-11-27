// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { findDummyLeaks, type ModuleEntry } from "../scripts/check-dummy-free.ts";
import { moduleListPlugin } from "../scripts/module-list-plugin.ts";
import { DUMMY_MARK } from "../src/dummy/dummy-client.ts";

const SRC = resolve(import.meta.dirname, "../src");
const CLIENT = resolve(import.meta.dirname, "../../../packages/contracts/src/client.ts");

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

// 1 つの起点を最適化して本番の形で束ね、検査に渡す 2 つの入力を返す
async function bundle(source: string): Promise<string[]> {
  dir = await mkdtemp(join(tmpdir(), "dummy-free-"));
  const entry = join(dir, "entry.ts");
  const list = join(dir, "modules.json");
  await writeFile(entry, source);
  const result = await build({
    configFile: false,
    root: dir,
    logLevel: "silent",
    mode: "production",
    plugins: [moduleListPlugin(list)],
    build: { write: false, rollupOptions: { input: entry } },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ("output" in r ? r.output : []));
  const files = outputs.map((o) => ({ path: o.fileName, text: o.type === "chunk" ? o.code : String(o.source) }));
  return findDummyLeaks(JSON.parse(await readFile(list, "utf8")) as ModuleEntry[], files);
}

describe("findDummyLeaks", () => {
  it("違反が無ければ 0 件で、翻訳の文に connection があっても通る", () => {
    const modules = [{ id: "/repo/apps/web/src/main.tsx", renderedExports: [] }];
    expect(findDummyLeaks(modules, [{ path: "a.js", text: '"Check your connection"' }])).toEqual([]);
  });

  it("モジュールの一覧が空なら違反にする", () => {
    expect(findDummyLeaks([], [])).toHaveLength(1);
  });

  it("生成したダミーのデータが入れば違反にする", () => {
    const modules = [{ id: "/repo/packages/contracts/generated/dummy/users.get.json", renderedExports: [] }];
    expect(findDummyLeaks(modules, [])).toHaveLength(1);
  });

  it("本番の経路がダミーのクライアントを静的に読んで組むと、モジュールの一覧と目印で落ちる", { timeout: 30_000 }, async () => {
    const leaks = await bundle(
      `import { createDummyApp } from ${JSON.stringify(join(SRC, "dummy/dummy-client.ts"))};\ncreateDummyApp(new URL(location.href));\n`,
    );
    expect(leaks.some((l) => l.includes("dummy-client.ts"))).toBe(true);
    expect(leaks.some((l) => l.includes(DUMMY_MARK))).toBe(true);
  });

  it("本番の経路が createDummyTransport を直に呼ぶと、残った書き出しで落ちる", { timeout: 30_000 }, async () => {
    const leaks = await bundle(
      `import { createDummyTransport } from ${JSON.stringify(CLIENT)};\nObject.assign(window, { t: createDummyTransport });\n`,
    );
    expect(leaks).toEqual([expect.stringContaining("createDummyTransport")]);
  });
});
