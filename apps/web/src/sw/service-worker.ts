import { webConfigSchema } from "@nd-factory/contracts/web-config";
import { CACHE_PREFIX, classifyRequest, nextConfigSeq, pickNewestConfig, saveConfig } from "./cache-rules.ts";

// 画面の殻と設定の値だけを保存する Service Worker。skipWaiting と clients.claim を呼ばず、
// 開いているタブには読み込んだ版の 1 揃いを返し続ける（#12 の決定 2）

// ビルドが埋め込む、事前に保存する一覧と版
declare const __PRECACHE__: string[];
declare const __VERSION__: string;

type Waitable = { waitUntil(done: Promise<unknown>): void };
type Scope = {
  location: { origin: string };
  fetch: typeof fetch;
  addEventListener(type: "install" | "activate", listener: (event: Waitable) => void): void;
  addEventListener(type: "fetch", listener: (event: { request: Request; respondWith(r: Promise<Response>): void }) => void): void;
  addEventListener(
    type: "message",
    listener: (event: Waitable & { data: unknown; ports: readonly { postMessage(m: unknown): void }[] }) => void,
  ): void;
};

const sw = self as unknown as Scope;
const CURRENT = `${CACHE_PREFIX}${__VERSION__}`;
const PRECACHE = new Set(__PRECACHE__);
const CONFIG_PATH = "/config.json";

const shellCaches = async () => (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX));

// ネットワークから設定を読み、形が合えば番号を付けて保存する。番号は読み出しを始める前に取る
async function readConfig(): Promise<{ response: Response | null; valid: boolean }> {
  const seq = await nextConfigSeq();
  try {
    const response = await sw.fetch(CONFIG_PATH, { cache: "no-store" });
    if (!response.ok) return { response, valid: false };
    const value: unknown = await response.clone().json();
    await saveConfig(CURRENT, value, seq);
    return { response, valid: webConfigSchema.safeParse(value).success };
  } catch {
    return { response: null, valid: false };
  }
}

async function install(): Promise<void> {
  const cache = await caches.open(CURRENT);
  await cache.addAll(__PRECACHE__.map((path) => new Request(path, { cache: "reload" })));
  if ((await readConfig()).valid) return;
  // 以前はオフラインで開けた端末を、使える設定の値が無いまま新しい版へ切り替えない
  const olds = (await shellCaches()).filter((name) => name !== CURRENT);
  let saved = false;
  for (const name of olds) saved ||= (await (await caches.open(name)).match(CONFIG_PATH)) !== undefined;
  if (saved && (await pickNewestConfig(olds)) === null) throw new Error("設定の値を引き継げない");
}

// 待つ間に旧い版が読み直した値も引き継ぐので、写すのは activate で行う
async function activate(): Promise<void> {
  const names = await shellCaches();
  const best = await pickNewestConfig(names);
  if (best !== null) await saveConfig(CURRENT, await best.response.json(), best.seq === 0 ? null : best.seq);
  for (const name of names) if (name !== CURRENT) await caches.delete(name);
}

async function fromCache(path: string, request: Request): Promise<Response> {
  const saved = await (await caches.open(CURRENT)).match(path);
  return saved ?? sw.fetch(request);
}

async function config(): Promise<Response> {
  const read = await readConfig();
  if (read.valid) return read.response!;
  const saved = await (await caches.open(CURRENT)).match(CONFIG_PATH);
  return saved ?? read.response ?? Response.error();
}

sw.addEventListener("install", (event) => event.waitUntil(install()));
sw.addEventListener("activate", (event) => event.waitUntil(activate()));

sw.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const kind = classifyRequest({ url, mode: request.mode, method: request.method }, PRECACHE, sw.location.origin);
  if (kind === "shell") event.respondWith(fromCache("/index.html", request));
  else if (kind === "asset") event.respondWith(fromCache(url.pathname, request));
  else if (kind === "config") event.respondWith(config());
});

sw.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown; value?: unknown } | null;
  const [port] = event.ports;
  if (data?.type !== "config" || port === undefined) return;
  event.waitUntil(
    (async () => {
      await saveConfig(CURRENT, data.value, null);
      // 保存があることを確かめてから「保存した」と返す
      if ((await (await caches.open(CURRENT)).match(CONFIG_PATH)) !== undefined) port.postMessage("saved");
    })(),
  );
});
