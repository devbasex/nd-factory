import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type Delivery, type Release, releases, serve } from "./support/releases.ts";

// Service Worker の版の入れ替え（#12 の決定 2）。版を 2 つ以上使う場面を、差し替えられる配信で確かめる

test.use({ serviceWorkers: "allow" });
// 幅で変わる振る舞いではないので、1 つの幅だけで打つ
test.skip(({ viewport }) => viewport?.width !== 1280);

const OLD = "https://api.example.com";
const NEW = "https://api2.example.com";
const WAITING = "ログインの設定を待っています";

let delivery: Delivery;
let versions: Release[];

test.beforeEach(async () => {
  versions = await releases(3);
  delivery = await serve(versions[0]!);
});

// 打たない幅でも afterEach は呼ばれる
test.afterEach(() => delivery?.close());

const cacheNames = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith("nd-shell-")).sort());
const nameOf = (release: Release) => `nd-shell-${release.version}`;
const config = (page: Page) =>
  page.evaluate(async () => ((await (await fetch("/config.json")).json()) as { api_url: string }).api_url);

// 開いて、Service Worker の制御と設定の値の保存を待つ
async function openControlled(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(delivery.url);
  await expect(page.getByText(WAITING)).toBeVisible();
  await page.evaluate(async () => void (await navigator.serviceWorker.ready));
  await expect
    .poll(() => page.evaluate(async () => (await caches.match("/config.json")) !== undefined))
    .toBe(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  return page;
}

// 反映した版の install が終わり、待機するまで
async function update(page: Page, release: Release): Promise<void> {
  delivery.deploy(release);
  await page.evaluate(async () => void (await (await navigator.serviceWorker.ready).update()));
  await expect.poll(() => cacheNames(page)).toContain(nameOf(release));
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return registration.installing === null && registration.waiting !== null;
      }),
    )
    .toBe(true);
}

// すべてのタブを閉じて開き直し、待機していた版が有効になるまで
async function reopen(context: BrowserContext, release: Release): Promise<Page> {
  for (const page of context.pages()) await page.close();
  let page: Page | undefined;
  await expect(async () => {
    await page?.close();
    // 閉じた直後は旧い版が残るので、有効になるまで開き直す
    page = await context.newPage();
    await page.goto(delivery.url);
    expect(await cacheNames(page)).toEqual([nameOf(release)]);
  }).toPass({ timeout: 20_000 });
  await expect(page!.getByText(WAITING)).toBeVisible();
  return page!;
}

test("旧い版のタブは新しい版を反映した後も自分の版のチャンクを取れ、開き直すと新しい版になる", async ({ context }) => {
  const [a, b] = versions as [Release, Release];
  const page = await openControlled(context);
  await update(page, b);

  const status = (path: string) => page.evaluate(async (url) => (await fetch(url)).status, path);
  expect(await status(a.lazyChunk)).toBe(200);
  expect(await cacheNames(page)).toEqual([nameOf(a), nameOf(b)].sort());

  const next = await reopen(context, b);
  expect(await next.evaluate(async (url) => (await fetch(url)).status, b.lazyChunk)).toBe(200);
});

test("新しい版の install の後も旧い版のタブは旧い設定の値を読み、開き直すと新しい値になる", async ({ context }) => {
  const [a, b] = versions as [Release, Release];
  const page = await openControlled(context);
  expect(await config(page)).toBe(OLD);

  delivery.config(NEW);
  await update(page, b);
  delivery.down();
  expect(await config(page)).toBe(OLD);
  expect(await cacheNames(page)).toEqual([nameOf(a), nameOf(b)].sort());

  const next = await reopen(context, b);
  expect(await config(next)).toBe(NEW);
});

test("更新で設定を読めなくても、旧い版で保存した値を引き継いでオフラインで開ける", async ({ context }) => {
  const [, b] = versions as [Release, Release];
  const page = await openControlled(context);

  delivery.config(null);
  await update(page, b);
  delivery.down();

  const next = await reopen(context, b);
  expect(await config(next)).toBe(OLD);
});

test("3 世代の更新で、待機を飛ばした版があっても、旧い版のタブが最後に読んだ値を引き継ぐ", async ({ context }) => {
  const [, b, c] = versions as [Release, Release, Release];
  const page = await openControlled(context);
  await update(page, b);

  delivery.config(NEW);
  expect(await config(page)).toBe(NEW);
  delivery.config(null);
  await update(page, c);
  delivery.down();

  const next = await reopen(context, c);
  expect(await config(next)).toBe(NEW);
});

test("初回の訪問の後は、install で設定を読めなくても、ページが渡した値でオフラインで開ける", async ({ context }) => {
  const page = await context.newPage();
  // ページの 1 回目の読み出しの後は、配信が設定を返さない
  delivery.configOnce();
  await page.goto(delivery.url);
  await expect(page.getByText(WAITING)).toBeVisible();
  await expect
    .poll(() => page.evaluate(async () => (await caches.match("/config.json")) !== undefined))
    .toBe(true);
  delivery.down();

  await page.goto(`${delivery.url}/p/prj_x/approvals/apr_y`);
  await expect(page.getByText(WAITING)).toBeVisible();
});
