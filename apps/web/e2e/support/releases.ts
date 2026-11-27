import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";

// 版を差し替えられる配信。本番のビルド（dist）を元に、版の名前とチャンクの名前だけが違う版を作る。
// 反映した版に無いファイルは 404 にするので、前の版のタブがファイルを取れるのは保存先からだけになる

const DIST = resolve(import.meta.dirname, "../../dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export type Release = {
  version: string;
  sw: string;
  // 配信の path から、元の dist の path へ
  files: ReadonlyMap<string, string>;
  // この版で名前を変えた、遅れて読むチャンクの path
  lazyChunk: string;
};

export async function releases(count: number): Promise<Release[]> {
  const sw = await readFile(join(DIST, "sw.js"), "utf8");
  const version = /\b[0-9a-f]{16}\b/.exec(sw)?.[0];
  const paths = [...new Set([...sw.matchAll(/["'`](\/[\w./-]+\.\w+)["'`]/g)].map((m) => m[1]!))].filter(
    (path) => path !== "/config.json" && path !== "/sw.js",
  );
  const lazy = paths.find((path) => /\/assets\/placeholder-[\w-]+\.js$/.test(path));
  if (version === undefined || lazy === undefined) throw new Error("sw.js から版かチャンクを読めない");

  return Array.from({ length: count }, (_, i) => {
    const next = i === 0 ? version : String(i).repeat(16);
    const lazyChunk = i === 0 ? lazy : lazy.replace(/\.js$/, `-r${i}.js`);
    return {
      version: next,
      sw: sw.replaceAll(version, next).replaceAll(lazy, lazyChunk),
      files: new Map(paths.map((path) => [path === lazy ? lazyChunk : path, path])),
      lazyChunk,
    };
  });
}

export type Delivery = {
  url: string;
  deploy(release: Release): void;
  // /config.json の値。null は 503
  config(apiUrl: string | null): void;
  // 次の 1 回だけ値を返し、その後は 503 にする
  configOnce(): void;
  // 接続を切って、つながらない端末にする
  down(): void;
  close(): Promise<void>;
};

export async function serve(first: Release): Promise<Delivery> {
  let release = first;
  let apiUrl: string | null = "https://api.example.com";
  let down = false;
  let once = false;

  const server = createServer((request, response) => {
    if (down) return void request.socket.destroy();
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const send = (status: number, type: string, body: string | Buffer) => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      response.end(body);
    };
    if (path === "/config.json") {
      if (apiUrl === null) return send(503, "text/plain", "unavailable");
      const value = {
        api_url: apiUrl,
        authority: "https://acme-test.auth.example.com",
        client_id: "example-app-client",
        login_ready: false,
      };
      if (once) apiUrl = null;
      return send(200, "application/json", JSON.stringify(value));
    }
    if (path === "/sw.js") return send(200, "text/javascript", release.sw);
    // 画面の path は index.html を返す
    const file = release.files.get(extname(path) === "" ? "/index.html" : path);
    if (file === undefined) return send(404, "text/plain", "not found");
    void readFile(join(DIST, file)).then((body) => send(200, TYPES[extname(file)] ?? "application/octet-stream", body));
  });
  await new Promise<void>((done) => server.listen(0, "localhost", done));

  return {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    deploy: (next) => void (release = next),
    config: (next) => void (apiUrl = next),
    configOnce: () => void (once = true),
    down() {
      down = true;
      server.closeAllConnections();
    },
    close: () => new Promise((done) => (server.closeAllConnections(), server.close(() => done()))),
  };
}
