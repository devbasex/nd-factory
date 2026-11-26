import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";

// 手数・ページの数・回線の絞り・押せる要素の大きさの計測

export type NetworkSetting = { latencyMs: number; downloadBytesPerSec: number; uploadBytesPerSec: number };

export const NETWORK_4G: NetworkSetting = { latencyMs: 150, downloadBytesPerSec: 200_000, uploadBytesPerSec: 93_750 };

const TIMINGS = resolve(import.meta.dirname, "../../test-results/timings.json");
const MIN_TARGET = 44;

export async function throttle(page: Page): Promise<NetworkSetting> {
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: NETWORK_4G.latencyMs,
    downloadThroughput: NETWORK_4G.downloadBytesPerSec,
    uploadThroughput: NETWORK_4G.uploadBytesPerSec,
  });
  return NETWORK_4G;
}

export type Count = { actions: number; pages: number };

// 押した回数と、移った先の path の数を数える
export function countActions(page: Page) {
  let actions = 0;
  const paths: string[] = [];
  let current = new URL(page.url()).pathname;
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const path = new URL(frame.url()).pathname;
    if (path !== current) paths.push(path);
    current = path;
  });
  return {
    async tap(locator: Locator): Promise<void> {
      actions += 1;
      await locator.click();
    },
    result: (): Count => ({ actions, pages: paths.length }),
  };
}

export function assertBudget(scene: string, count: Count, budget: Count): void {
  if (count.actions > budget.actions || count.pages > budget.pages) {
    throw new Error(
      `${scene} が上限を超えた: 手数 ${count.actions}/${budget.actions}・ページ ${count.pages}/${budget.pages}`,
    );
  }
}

// 待ち時間は記録だけに使い、合否には使わない。絞りが決めた値でなければ記録せずに落とす
export async function recordTiming(scene: string, ms: number, setting: NetworkSetting | undefined): Promise<void> {
  if (JSON.stringify(setting) !== JSON.stringify(NETWORK_4G)) {
    throw new Error(`回線の絞りが決めた値と違う: ${JSON.stringify(setting)}`);
  }
  await mkdir(dirname(TIMINGS), { recursive: true });
  const before = await readFile(TIMINGS, "utf8").catch(() => "[]");
  const records = [...(JSON.parse(before) as unknown[]), { scene, ms, setting }];
  await writeFile(TIMINGS, `${JSON.stringify(records, null, 2)}\n`);
}

// 幅か高さが 44 px 未満の押せる要素（文中のリンクと、フォーカスするまで隠すリンクを除く）
export async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate((min) => {
    const selector = 'a[href], button, input, select, textarea, summary, [role="button"]';
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((e) => !e.matches(".nd-inline, .nd-skip:not(:focus)") && e.checkVisibility())
      .map((e) => ({ e, box: e.getBoundingClientRect() }))
      .filter(({ box }) => box.width < min || box.height < min)
      .map(({ e, box }) => `${e.tagName} ${e.textContent?.trim()} ${box.width}x${box.height}`);
  }, MIN_TARGET);
}
