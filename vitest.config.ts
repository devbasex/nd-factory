import { defineConfig } from "vitest/config";

const INTEGRATION = "integration";

// 結合のテスト（`*.integration.test.ts`）は実行ファイルを起こすので、`--project integration`（`npm run test:integration`）
// を指したときだけ project に加える。既定の `vitest run`（`npm run test`）では走らせない
const integrationSelected = process.argv.some(
  (arg, index, args) => arg === `--project=${INTEGRATION}` || (arg === "--project" && args[index + 1] === INTEGRATION),
);

// ワークスペースごとのテストを 1 回の `vitest run` で打つ。画面だけ DOM の環境で動かす
export default defineConfig({
  test: {
    // 結合のテストのファイルがまだ無くても、`test:integration` を落とさない
    passWithNoTests: integrationSelected,
    projects: [
      { test: { name: "contracts", include: ["packages/contracts/test/**/*.test.ts"], environment: "node" } },
      { test: { name: "api", include: ["apps/api/test/**/*.test.ts"], environment: "node" } },
      { test: { name: "web", include: ["apps/web/test/**/*.test.ts"], environment: "jsdom" } },
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
      ...(integrationSelected
        ? [
            {
              test: {
                name: INTEGRATION,
                include: ["tools/test/**/*.integration.test.ts"],
                environment: "node" as const,
                testTimeout: 120_000,
              },
            },
          ]
        : []),
    ],
  },
});
