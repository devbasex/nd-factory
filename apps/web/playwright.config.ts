import { defineConfig, devices } from "@playwright/test";

// 画面の e2e。本番の mode とダミーの mode の 2 組の配信物を vite preview で出し、3 つの幅で打つ。
// 利用者プールと API は試験の中でネットワークの手前で差し替える
const PORT = 4173;
const DUMMY_PORT = 4174;

const WIDTHS = [
  { name: "phone", viewport: { width: 360, height: 780 } },
  { name: "tablet", viewport: { width: 768, height: 1024 } },
  { name: "desktop", viewport: { width: 1280, height: 800 } },
];

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "ja-JP",
    // 差し替えたネットワークを Service Worker が通り抜けないようにする。使う spec だけが許す
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: WIDTHS.map(({ name, viewport }) => ({ name, use: { ...devices["Desktop Chrome"], viewport } })),
  webServer: [
    {
      command: "npm run build && npm run preview",
      cwd: import.meta.dirname,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "npx vite build --mode dummy && npx vite preview --mode dummy",
      cwd: import.meta.dirname,
      url: `http://localhost:${DUMMY_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
