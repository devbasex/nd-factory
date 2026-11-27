// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { precacheList, shellVersion } from "../../scripts/build-sw.ts";

const made: string[] = [];
afterEach(async () => void (await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));

async function dist(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nd-sw-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

const FILES = {
  ".vite/manifest.json": JSON.stringify({
    "index.html": { file: "assets/index-a.js", css: ["assets/index-a.css"], assets: ["assets/logo-a.svg"] },
  }),
  "index.html": '<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg">',
  "manifest.webmanifest": JSON.stringify({ icons: [{ src: "/icon-app.svg" }] }),
  "assets/index-a.js": "js",
  "assets/index-a.css": "css",
  "assets/logo-a.svg": "svg",
  "icon.svg": "icon",
  "icon-app.svg": "icon",
};

describe("事前に保存する一覧", () => {
  it("ビルドの一覧と、index.html・manifest と直に参照するアイコンを載せる", async () => {
    expect(await precacheList(await dist(FILES))).toEqual([
      "/assets/index-a.css",
      "/assets/index-a.js",
      "/assets/logo-a.svg",
      "/icon-app.svg",
      "/icon.svg",
      "/index.html",
      "/manifest.webmanifest",
    ]);
  });

  it("参照するファイルが無ければ止める", async () => {
    const { "icon.svg": _icon, ...rest } = FILES;
    await expect(precacheList(await dist(rest))).rejects.toThrow("/icon.svg");
  });

  it("index.html だけ・Service Worker のコードだけの違いでも版が変わる", () => {
    const files = (html: string) => [{ path: "/index.html", bytes: new TextEncoder().encode(html) }];
    const base = shellVersion(files("a"), "code");
    expect(shellVersion(files("a"), "code")).toBe(base);
    expect(shellVersion(files("b"), "code")).not.toBe(base);
    expect(shellVersion(files("a"), "code2")).not.toBe(base);
  });
});
