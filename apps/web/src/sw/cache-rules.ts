import { webConfigSchema } from "@nd-factory/contracts/web-config";
import { openDB } from "idb";

// Service Worker が保存から返すかの規則と、画面の設定の値の保存（#12 の決定 2）。
// 保存するのは画面の殻と設定の値だけで、API のレスポンスは保存しない

export const CACHE_PREFIX = "nd-shell-";
const CONFIG_PATH = "/config.json";
const CONFIG_SEQ_HEADER = "x-nd-config-seq";
// 版をまたいで同じものを開き、サインアウトでも消さない。番号が戻ると新しい値を古いと判定する
const SEQ_DB = "nd-config-seq";

export function classifyRequest(
  req: { url: URL; mode: RequestMode; method: string },
  precache: ReadonlySet<string>,
  origin: string,
): "shell" | "asset" | "config" | "network" {
  const { url, mode, method } = req;
  if (method !== "GET" || url.origin !== origin || url.pathname === "/signed-out") return "network";
  if (url.pathname === CONFIG_PATH) return "config";
  if (mode === "navigate") return "shell";
  return url.search === "" && precache.has(url.pathname) ? "asset" : "network";
}

export async function nextConfigSeq(): Promise<number> {
  const db = await openDB(SEQ_DB, 1, { upgrade: (target) => void target.createObjectStore("seq", { autoIncrement: true }) });
  try {
    const tx = db.transaction("seq", "readwrite");
    const number = (await tx.store.add!({})) as number;
    await tx.store.delete!(number);
    await tx.done;
    return number;
  } finally {
    db.close();
  }
}

async function validConfig(response: Response): Promise<boolean> {
  try {
    return webConfigSchema.safeParse(await response.clone().json()).success;
  } catch {
    return false;
  }
}

const seqOf = (response: Response) => Number(response.headers.get(CONFIG_SEQ_HEADER) ?? 0);

// seq が null の値はページから受けたもので、保存した値が無いときだけ書く
export async function saveConfig(cacheName: string, value: unknown, seq: number | null): Promise<boolean> {
  if (!webConfigSchema.safeParse(value).success) return false;
  return await navigator.locks.request(cacheName, async () => {
    const cache = await caches.open(cacheName);
    const current = await cache.match(CONFIG_PATH);
    if (current !== undefined && (seq === null || seqOf(current) > seq)) return false;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (seq !== null) headers[CONFIG_SEQ_HEADER] = String(seq);
    await cache.put(CONFIG_PATH, new Response(JSON.stringify(value), { headers }));
    return true;
  });
}

export async function pickNewestConfig(cacheNames: string[]): Promise<{ response: Response; seq: number } | null> {
  let best: { response: Response; seq: number } | null = null;
  for (const name of cacheNames) {
    const response = await (await caches.open(name)).match(CONFIG_PATH);
    if (response === undefined || !(await validConfig(response))) continue;
    if (best === null || seqOf(response) > best.seq) best = { response, seq: seqOf(response) };
  }
  return best;
}
