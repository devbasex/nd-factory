import { readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

// モック専用の Chrome でモックを開くオリジン。`*.localhost` はどの端末でも自分を指すので、名前の登録が要らない
export const MOCK_ORIGIN = "http://ndf-mock.localhost";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export type MockResponse = {
  status: 200 | 404;
  contentType: string;
  body: Buffer;
};

const NOT_FOUND: MockResponse = {
  status: 404,
  contentType: "text/plain; charset=utf-8",
  body: Buffer.from("not found"),
};

// モックのオリジンへの URL を、root の下のファイルの中身にする。オリジンが違えば undefined（ブラウザにそのまま流させる）。
// root の外を指すパス・無いファイル・ディレクトリは 404 にする
export function readMockFile(root: string, url: string): MockResponse | undefined {
  const parsed = new URL(url);
  if (parsed.origin !== MOCK_ORIGIN) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return NOT_FOUND;
  }
  if (path === "/") path = "/viewer.html";
  const base = resolve(root);
  const target = resolve(base, `.${path}`);
  if (!target.startsWith(base + sep)) return NOT_FOUND;
  try {
    if (!statSync(target).isFile()) return NOT_FOUND;
    const contentType = CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    return { status: 200, contentType, body: readFileSync(target) };
  } catch {
    return NOT_FOUND;
  }
}
