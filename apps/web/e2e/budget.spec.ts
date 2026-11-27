import { expect, test } from "@playwright/test";
import { assertBudget, countActions, NETWORK_4G, recordTiming, throttle } from "./support/measure.ts";

// 手数とページの数を数える仕組みと、回線の絞りの記録を仮の画面で確かめる。実際の操作の計測は機能の画面（#28）が書く

const DUMMY = "http://localhost:4174";

test("手数とページの数を数え、上限を超えると失敗する", async ({ page }) => {
  await page.goto(`${DUMMY}/`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("オーガナイザー");
  const counter = countActions(page);
  await counter.tap(page.locator('[data-nav="approvals"]'));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("承認待ちの一覧");
  await counter.tap(page.locator('[data-nav="settings"]'));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("自分の設定");

  const count = counter.result();
  expect(count).toEqual({ actions: 2, pages: 2 });
  expect(() => assertBudget("仮の場面", count, { actions: 2, pages: 2 })).not.toThrow();
  expect(() => assertBudget("仮の場面", count, { actions: 1, pages: 2 })).toThrow("手数 2/1");
  expect(() => assertBudget("仮の場面", count, { actions: 2, pages: 1 })).toThrow("ページ 2/1");
});

test("回線を絞って待ち時間を測り、絞りの設定と一緒に記録する", async ({ page }) => {
  const setting = await throttle(page);
  const start = performance.now();
  await page.goto(`${DUMMY}/`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const ms = performance.now() - start;
  // 絞りが掛かっていれば、往復の遅延より速くは開けない
  expect(ms).toBeGreaterThan(NETWORK_4G.latencyMs);
  await recordTiming("S2 Web アプリを開く（仮の画面）", ms, setting);
  await expect(recordTiming("絞りなし", ms, undefined)).rejects.toThrow("回線の絞り");
});
