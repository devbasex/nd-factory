import { expect, test } from "@playwright/test";
import { ROUTES } from "../src/routes/route-table.ts";
import { smallTargets } from "./support/measure.ts";
import { stubNetwork } from "./support/network.ts";

// 画面マップの 16 本のルートと戻り先

const DUMMY = "http://localhost:4174";
const concrete = (path: string) => path.replace(/:\w+/g, "x_1");

const TITLES: Record<string, string> = {
  R1: "サインイン",
  R2: "オーガナイザー",
  R3: "スプリントの一覧",
  R4: "スプリントを始める",
  R5: "スプリントの詳細",
  R6: "承認の詳細",
  R7: "問い",
  R8: "プロジェクトの設定",
  R9: "チーム",
  R10: "プロジェクトを作る",
  R11: "実行の場所",
  R12: "使える量と費用",
  R13: "操作の記録",
  R14: "自分の設定",
  R15: "オーガナイザーの会話",
  R16: "承認待ちの一覧",
};

for (const route of ROUTES) {
  test(`${route.id} ${route.path} を直に開くと画面が出て、押せる要素は 44 px 以上で横にはみ出さない`, async ({ page }) => {
    await page.goto(`${DUMMY}${concrete(route.path)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLES[route.id]!);
    await expect(page.locator('[data-state="loading"]')).toHaveCount(0);
    expect(await smallTargets(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("本番の mode でも、サインインを挟んで 16 本の path がそれぞれの画面を出す", async ({ page }) => {
  await stubNetwork(page, { loginReady: true, finishLogin: true });
  for (const route of ROUTES) {
    await page.goto(concrete(route.path));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLES[route.id]!);
    expect(new URL(page.url()).pathname).toBe(concrete(route.path));
  }
});

test("画面マップに無い path は、履歴を置き換えて / へ移る", async ({ page }) => {
  await page.goto(`${DUMMY}/me`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("自分の設定");
  await page.goto(`${DUMMY}/nowhere`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("オーガナイザー");
  expect(new URL(page.url()).pathname).toBe("/");
  await page.goBack();
  expect(new URL(page.url()).pathname).toBe("/me");
});

for (const path of ["/me/logins/return?code=a&state=b", "/signed-out?code=a&state=b"]) {
  test(`戻り先 ${path} は URL を保ったまま専用の処理へ渡す`, async ({ page, baseURL }) => {
    const rec = await stubNetwork(page, { loginReady: true, finishLogin: false });
    await page.goto(path);
    await expect(page.getByText("戻り先を処理しています")).toBeVisible();
    expect(page.url()).toBe(`${baseURL}${path}`);
    expect(rec.token).toHaveLength(0);
    expect(rec.authorize).toHaveLength(0);
  });
}
