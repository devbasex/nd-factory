import { expect, test } from "@playwright/test";

// ダミーの mode の scenario と connection で、画面の状態が変わる

const LIST = "http://localhost:4174/p/prj_1";
const main = "main [data-state]";

for (const [scenario, state] of [
  ["normal", "rows"],
  ["empty", "empty"],
  ["error", "error"],
  ["notFound", "notFound"],
] as const) {
  test(`scenario=${scenario} は ${state} の状態を出す`, async ({ page }) => {
    await page.goto(`${LIST}?scenario=${scenario}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("スプリントの一覧");
    await expect(page.locator(main).first()).toHaveAttribute("data-state", state);
  });
}

test("scenario=slow は読み込み中の後に行を出す", async ({ page }) => {
  await page.goto(`${LIST}?scenario=slow`);
  await expect(page.locator(main).first()).toHaveAttribute("data-state", "loading");
  await expect(page.locator(main).first()).toHaveAttribute("data-state", "rows");
});

test("connection=offline は帯を出し、保存しない画面は「つながると読めます」", async ({ page }) => {
  await page.goto("http://localhost:4174/p/prj_1/start?connection=offline");
  await expect(page.getByRole("status").filter({ hasText: "つながっていません" })).toBeVisible();
  await expect(page.getByText("つながると読めます")).toBeVisible();
});

test("connection=pending は確定待ちの数を帯に出す", async ({ page }) => {
  await page.goto(`${LIST}?connection=pending`);
  await expect(page.getByText("確定待ち 1 件")).toBeVisible();
});
