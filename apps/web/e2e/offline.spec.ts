import { expect, type Page, test } from "@playwright/test";
import { stubNetwork } from "./support/network.ts";

// Service Worker は画面の殻と設定の値だけを保存し、オフラインでも画面の URL を直に開ける

test.use({ serviceWorkers: "allow" });

const cached = (page: Page) =>
  page.evaluate(async () => {
    const found: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) found.push(request.url);
    }
    return found;
  });

const shellReady = (page: Page) =>
  expect.poll(async () => (await cached(page)).some((url) => url.endsWith("/config.json"))).toBe(true);

test("Service Worker の保存先には API のレスポンスが無く、殻と設定の値だけがある", async ({ page, baseURL }) => {
  await stubNetwork(page, { loginReady: true, finishLogin: true });
  await page.goto("/me");
  await expect(page.locator("time")).toBeVisible();
  await shellReady(page);

  const urls = await cached(page);
  expect(urls.every((url) => url.startsWith(`${baseURL}/`))).toBe(true);
  expect(urls.filter((url) => url.includes("/v1/") || url.includes("/oauth2/"))).toEqual([]);
  expect(urls).toContain(`${baseURL}/index.html`);
});

test("オフラインで画面の URL を直に開くと、保存した殻と設定の値で起動する", async ({ page, context }) => {
  await stubNetwork(page, { loginReady: false, finishLogin: false });
  await page.goto("/");
  await expect(page.getByText("ログインの設定を待っています")).toBeVisible();
  await shellReady(page);

  await context.setOffline(true);
  await page.goto("/p/prj_x/approvals/apr_y");
  await expect(page.getByText("ログインの設定を待っています")).toBeVisible();
});
