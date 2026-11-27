import { defineConfig } from "vitest/config";

// ワークスペースごとのテストを 1 回の `vitest run` で打つ。画面だけ DOM の環境で動かす。
// 結合のテスト（`*.integration.test.ts`）は実行ファイルを起こすので、vitest.integration.config.ts で別に打つ
export default defineConfig({
  test: {
    projects: [
      { test: { name: "contracts", include: ["packages/contracts/test/**/*.test.ts"], environment: "node" } },
      { test: { name: "core", include: ["packages/core/test/**/*.test.ts"], environment: "node" } },
      { test: { name: "api", include: ["apps/api/test/**/*.test.ts"], environment: "node" } },
      { test: { name: "web", include: ["apps/web/test/**/*.test.ts", "apps/web/test/**/*.test.tsx"], environment: "jsdom" } },
      {
        test: {
          name: "infra",
          include: ["infra/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "tools",
          include: ["tools/test/**/*.test.ts"],
          exclude: ["tools/test/**/*.integration.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
