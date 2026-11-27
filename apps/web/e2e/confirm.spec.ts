import { expect, type Page, test } from "@playwright/test";
import { smallTargets } from "./support/measure.ts";

// 確定待ち（I4）と、つながっていないときの 3 つの区分を、画面から通して確かめる。送り先はダミーで、外へは何も送らない

const PAGE = "http://localhost:4174/p/prj_example";
const banner = (page: Page) => page.getByRole("status").first();
const action = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const sent = (page: Page) => page.evaluate(() => JSON.parse(document.documentElement.dataset["ndSent"] ?? "[]") as string[]);

async function open(page: Page, query = "") {
  await page.goto(`${PAGE}${query}`);
  await expect(action(page, "チームを作る")).toBeVisible();
}

test("確定待ちは、つながっていない間は確定せず、つながった後に今の状態と合うものだけ確定する", async ({ page, context }) => {
  await open(page);
  await context.setOffline(true);
  await expect(page.getByText("つながっていません")).toBeVisible();
  for (const name of ["承認する（受付中）", "承認する（受付終了）", "承認する（資料が変わった）"]) {
    await action(page, name).click();
  }
  await expect(page.getByText("確定待ち 3 件")).toBeVisible();
  await expect(page.getByText("つながってから確定")).toHaveCount(3);
  await expect(page.getByText("確定しました")).toHaveCount(0);
  expect(await sent(page)).toEqual([]);
  expect(await smallTargets(page)).toEqual([]);

  await context.setOffline(false);
  await expect(page.getByText("確定しました")).toHaveCount(1);
  await expect(page.getByText("食い違いがあり、確定していません")).toHaveCount(2);
  await expect(page.getByText("状態が変わりました")).toBeVisible();
  await expect(page.getByText("ほかで先に変わりました")).toBeVisible();
  await expect(page.getByText("つながってから確定")).toHaveCount(0);
  expect(await sent(page)).toEqual(["apr_example-open", "apr_example-closed", "apr_example-changed"]);

  // 拒まれた件は、再読み込みの後も入力した文を読め、確認の後に破棄できる
  await page.reload();
  await expect(banner(page)).toContainText("送れなかった操作が 2 件あります");
  await action(page, "内容を確認する").click();
  const dialog = page.getByRole("dialog", { name: "送れなかった操作" });
  await expect(dialog.getByText("作り物のコメント")).toHaveCount(2);
  expect(await smallTargets(page)).toEqual([]);
  await dialog.getByRole("button", { name: "破棄する" }).first().click();
  await page.getByRole("dialog", { name: "この操作を破棄しますか" }).getByRole("button", { name: "破棄する" }).click();
  await expect(banner(page)).toContainText("送れなかった操作が 1 件あります");
});

test("つながっていないとき、つながってから押す操作は押せず、キャッシュして送る操作は溜めた順に送る", async ({
  page,
  context,
}) => {
  await open(page);
  await context.setOffline(true);
  await expect(action(page, "チームを作る")).toBeDisabled();
  await expect(page.getByText("つながると使えます")).toBeVisible();
  await action(page, "通知 2 を既読にする").click();
  await action(page, "通知 1 を既読にする").click();
  expect(await sent(page)).toEqual([]);

  await context.setOffline(false);
  await expect(action(page, "チームを作る")).toBeEnabled();
  await expect.poll(() => sent(page)).toEqual(["ntc_example-2", "ntc_example-1"]);
});

test("connection=pending は確定待ちが 1 件ある状態で、取り下げると消える", async ({ page }) => {
  await open(page, "?connection=pending");
  await expect(page.getByText("確定待ち 1 件")).toBeVisible();
  await action(page, "取り下げる").click();
  await expect(page.getByText("確定待ち 1 件")).toHaveCount(0);
  await expect(action(page, "承認する（受付中）")).toBeVisible();
});

test("connection=offline で押した確定待ちは、開き直しても残る", async ({ page }) => {
  await open(page, "?connection=offline");
  await action(page, "承認する（受付中）").click();
  await expect(page.getByText("確定待ち 1 件")).toBeVisible();
  await page.reload();
  await expect(page.getByText("確定待ち 1 件")).toBeVisible();
});
