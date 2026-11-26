// モック専用の Chrome（専用のプロファイル）に CDP でつなぎ、http://ndf-mock.localhost/ へのリクエストをイメージの中のモックのファイルで返す。
// ルーティング（Playwright はその範囲の HTTP キャッシュも無効にする）は、接続ごとに作る別のコンテキストにだけ入れ、既定のコンテキストを変えない。
// 待ち受けのポートを開かない。Chrome との接続が切れたら、つながるまで待ってつなぎ直し、タブを開き直す。
import { request } from "node:http";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext } from "playwright-core";

import { MOCK_ORIGIN, readMockFile } from "./files.ts";

const CDP_URL = new URL(process.env["CDP_URL"] ?? "http://127.0.0.1:9223");
const MOCK_ROOT = process.env["MOCK_ROOT"] ?? "/srv/mock";
const START_PATH = process.env["MOCK_START"] ?? "/viewer.html#foundation";
const RETRY_MS = 10_000;

// Chrome は Host が localhost か IP のときだけ /json/version に答える。中継越しでも Host を localhost にして読む
function webSocketUrl(): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    const req = request(
      { host: CDP_URL.hostname, port: CDP_URL.port, path: "/json/version", headers: { Host: `localhost:${CDP_URL.port}` }, timeout: 5_000 },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          try {
            const ws = new URL((JSON.parse(body) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
            ws.hostname = CDP_URL.hostname;
            ws.port = CDP_URL.port;
            resolveUrl(ws.toString());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("CDP の応答が 5 秒で返らない")));
    req.on("error", reject);
    req.end();
  });
}

async function serve(context: BrowserContext): Promise<void> {
  await context.route(`${MOCK_ORIGIN}/**`, async (route) => {
    const file = readMockFile(MOCK_ROOT, route.request().url());
    if (file === undefined) return route.continue();
    return route.fulfill({ status: file.status, contentType: file.contentType, body: file.body, headers: { "Cache-Control": "no-store" } });
  });
}

// 接続で作ったコンテキストは、接続が切れると Chrome がタブごと捨てる。そのため、接続のたびに作ってタブを開く
async function connectOnce(): Promise<Browser> {
  // noDefaults: 既定のコンテキストに Playwright の上書き（ダウンロード・フォーカス・メディア）を掛けない
  const browser = await chromium.connectOverCDP(await webSocketUrl(), { headers: { Host: `localhost:${CDP_URL.port}` }, noDefaults: true });
  try {
    const context = await browser.newContext({ viewport: null });
    await serve(context);
    const page = await context.newPage();
    await page.goto(`${MOCK_ORIGIN}${START_PATH}`);
  } catch (error) {
    await browser.close();
    throw error;
  }
  console.log(`配信中: ${MOCK_ORIGIN}/ （Chrome ${CDP_URL.host}）`);
  return browser;
}

async function main(): Promise<void> {
  for (;;) {
    try {
      const browser = await connectOnce();
      await new Promise<void>((done) => browser.on("disconnected", () => done()));
      console.log("Chrome との接続が切れた。つなぎ直す");
    } catch (error) {
      console.log(`Chrome につながらない（${error instanceof Error ? error.message : String(error)}）。${RETRY_MS / 1000} 秒後にやり直す`);
    }
    await new Promise((wait) => setTimeout(wait, RETRY_MS));
  }
}

await main();
