import { expect, test } from "@playwright/test";
import { smallTargets } from "./support/measure.ts";

// 幅ごとのナビゲーションの形と、44 px の確認

const DUMMY = "http://localhost:4174";
const ORDER = ["organizers", "approvals", "sprints", "settings"];

for (const [width, shape] of [
  [639, "bottom"],
  [640, "rail"],
  [1023, "rail"],
  [1024, "side"],
] as const) {
  test(`幅 ${width} px では 4 つの行き先が同じ順で ${shape} の帯に出る`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${DUMMY}/approvals`);
    const items = page.locator("nav [data-nav]");
    await expect(items).toHaveCount(4);
    expect(await items.evaluateAll((all) => all.map((e) => e.getAttribute("data-nav")))).toEqual(ORDER);
    const box = (await page.locator("nav").boundingBox())!;
    if (shape === "bottom") {
      expect(box.width).toBe(width);
      expect(Math.round(box.y + box.height)).toBe(800);
    } else {
      expect(box.x).toBe(0);
      expect(box.width).toBe(shape === "rail" ? 80 : 240);
    }
  });
}

test("場所の一覧を開いても、押せる要素は 44 px 以上", async ({ page }) => {
  await page.goto(`${DUMMY}/`);
  await page.getByRole("button", { name: "チームとプロジェクトの切り替え" }).click();
  await expect(page.getByRole("link", { name: "acme", exact: true })).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
});

test("40 px のボタンは、44 px の確認が返す", async ({ page }) => {
  await page.setContent('<button style="width:40px;height:44px;padding:0">a</button><button style="width:44px;height:44px">b</button>');
  expect(await smallTargets(page)).toEqual(["BUTTON a 40x44"]);
});
