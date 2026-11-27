import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";
import { SW_MODULE_LIST } from "./check-dummy-free.ts";
import { moduleListPlugin } from "./module-list-plugin.ts";

// 事前に保存する一覧と版を作り、埋め込んだ Service Worker を dist/sw.js に出す（#12 の決定 2）

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = resolve(ROOT, "dist");

type ViteManifest = Record<string, { file: string; css?: string[]; assets?: string[] }>;

export async function precacheList(distDir: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(distDir, ".vite/manifest.json"), "utf8")) as ViteManifest;
  const paths = new Set(["/index.html", "/manifest.webmanifest"]);
  for (const entry of Object.values(manifest)) {
    for (const file of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) paths.add(`/${file}`);
  }
  // 名前の決まったファイルが直に参照する、公開のファイル
  const html = await readFile(join(distDir, "index.html"), "utf8");
  for (const [, path] of html.matchAll(/(?:href|src)="(\/[^"/][^"]*)"/g)) paths.add(path!);
  const app = JSON.parse(await readFile(join(distDir, "manifest.webmanifest"), "utf8")) as { icons?: { src: string }[] };
  for (const icon of app.icons ?? []) paths.add(icon.src);

  for (const path of paths) {
    await stat(join(distDir, path)).catch(() => {
      throw new Error(`事前に保存するファイルが成果物に無い: ${path}`);
    });
  }
  return [...paths].sort();
}

export function shellVersion(files: readonly { path: string; bytes: Uint8Array }[], swCode: string): string {
  const hash = createHash("sha256");
  for (const { path, bytes } of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${path}\0${bytes.length}\0`).update(bytes);
  }
  return hash.update(swCode).digest("hex").slice(0, 16);
}

async function bundle(define: Record<string, string>, write: boolean): Promise<string> {
  const result = (await build({
    configFile: false,
    root: ROOT,
    logLevel: "warn",
    publicDir: false,
    plugins: write ? [moduleListPlugin(SW_MODULE_LIST)] : [],
    define: { "process.env.NODE_ENV": '"production"', ...define },
    build: {
      outDir: DIST,
      emptyOutDir: false,
      write,
      lib: { entry: resolve(ROOT, "src/sw/service-worker.ts"), formats: ["iife"], name: "ndServiceWorker", fileName: () => "sw.js" },
    },
  })) as Rollup.RollupOutput[];
  return result.flatMap((r) => r.output.map((o) => (o.type === "chunk" ? o.code : ""))).join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const paths = await precacheList(DIST);
    // ビルドの一覧は配らない
    await rm(join(DIST, ".vite"), { recursive: true, force: true });
    const files = await Promise.all(paths.map(async (path) => ({ path, bytes: await readFile(join(DIST, path)) })));
    // 版には、一覧と版を埋め込む前の Service Worker のコードも入れる
    const version = shellVersion(files, await bundle({}, false));
    await bundle({ __PRECACHE__: JSON.stringify(paths), __VERSION__: JSON.stringify(version) }, true);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
