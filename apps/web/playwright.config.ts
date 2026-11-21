import { defineConfig, devices } from "@playwright/test";

// 画面の e2e。ビルドした配信物を vite preview で出し、利用者プールと API は試験の中でネットワークの手前で差し替える
const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview",
    cwd: import.meta.dirname,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
