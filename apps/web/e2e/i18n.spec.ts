import { expect, test } from "@playwright/test";

// ブラウザーの言語と時刻帯で、文言と日時が変わる

const DUMMY = "http://localhost:4174";

test.use({ locale: "en-US", timezoneId: "America/Los_Angeles" });

test("英語のブラウザーでは英語の文を出し、日時は利用者の時刻帯で出す", async ({ page }) => {
  await page.goto(`${DUMMY}/me`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("My settings");
  expect(await page.getAttribute("html", "lang")).toBe("en");
  // 2026-01-02T03:04 UTC は、ロサンゼルスでは前の日
  await expect(page.locator("time")).toContainText("01/01/2026");
});
