import { expect, test } from "@playwright/test";
import { CLIENT_ID, CREATED_AT, stubNetwork, SUB } from "./support/network.ts";

// 骨組みの利用者の表示（R14）と、サインインの流れの振る舞い

test("token が無いと、認可コードと PKCE（S256）で認可の頁へ送る", async ({ page, baseURL }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: false });
  await page.goto("/");
  await expect.poll(() => rec.authorize.length).toBe(1);

  const url = rec.authorize[0]!;
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(url.searchParams.get("redirect_uri")).toBe(`${baseURL}/`);
  expect(rec.api).toHaveLength(0);
});

test("login_ready が偽なら、設定の待ちを示してログインへ送らない", async ({ page, baseURL }) => {
  const rec = await stubNetwork(page, { loginReady: false, finishLogin: false });
  await page.goto("/");
  await expect(page.getByText("ログインの設定を待っています")).toBeVisible();
  expect(page.url()).toBe(`${baseURL}/`);
  expect(rec.authorize).toHaveLength(0);
  expect(rec.token).toHaveLength(0);
  expect(rec.api).toHaveLength(0);
});

test("ログインの戻りの後に経路を 1 回だけ呼び、利用者の行を表示する", async ({ page, baseURL }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: true });
  await page.goto("/me");

  await expect(page.getByText(SUB)).toBeVisible();
  await expect(page.locator(`time[datetime="${CREATED_AT}"]`)).toBeVisible();

  // 認可コードの交換は PKCE の検証子つきで 1 回
  expect(rec.token).toHaveLength(1);
  const form = new URLSearchParams(rec.token[0]!.postData() ?? "");
  expect(form.get("grant_type")).toBe("authorization_code");
  expect(form.get("code")).toBe("example-code");
  expect(form.get("code_verifier")).toBeTruthy();

  // 経路は self の 1 要素で 1 回だけ。token を Bearer で渡す
  expect(rec.api).toHaveLength(1);
  const call = rec.api[0]!;
  expect(call.method()).toBe("PUT");
  expect(new URL(call.url()).pathname).toBe("/v1/users");
  expect(call.postData()).toBe('[{"id":"self"}]');
  expect(call.headers()["authorization"]).toMatch(/^Bearer \S+$/);

  // 認可コードを URL に残さず、サインインの前に開いていた画面へ戻す
  expect(page.url()).toBe(`${baseURL}/me`);
  expect(rec.other).toHaveLength(0);
});

test("API が 401 なら 1 回だけログインへ送り直し、取り直した token で表示する", async ({ page }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: true, apiStatus: [401] });
  await page.goto("/me");

  await expect(page.getByText(SUB)).toBeVisible();
  expect(rec.authorize).toHaveLength(2);
  expect(rec.api).toHaveLength(2);
});

test("送り直した後にまた 401 ならエラーを出し、送り直しを繰り返さない", async ({ page }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: true, apiStatus: [401, 401] });
  await page.goto("/");

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: /もう一度/ })).toBeVisible();
  expect(rec.authorize).toHaveLength(2);
  expect(rec.api).toHaveLength(2);
});

test("画面の設定の値が読めなければエラーと「もう一度」を出し、押すと読み直す", async ({ page }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: false, configStatus: 404 });
  await page.goto("/");
  const retry = page.getByRole("button", { name: /もう一度/ });
  await expect(page.getByRole("alert")).toBeVisible();

  const reread = page.waitForRequest("**/config.json");
  await retry.click();
  await reread;
  expect(rec.authorize).toHaveLength(0);
});

test("ログインの戻りが失敗するとエラーを出し、「もう一度」でログインへ送り直す", async ({ page }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: true, tokenStatus: 400 });
  await page.goto("/");

  await expect(page.getByRole("alert")).toBeVisible();
  expect(rec.api).toHaveLength(0);
  expect(new URL(page.url()).search).toBe("");
  await page.getByRole("button", { name: /もう一度/ }).click();
  await expect.poll(() => rec.authorize.length).toBe(2);
});
