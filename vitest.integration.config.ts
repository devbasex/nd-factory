import { defineConfig } from "vitest/config";

// 結合のテスト（実行ファイルを起こす）。`npm run test:integration` で打ち、既定の `npm run test` には含めない
export default defineConfig({
  test: {
    name: "integration",
    include: ["tools/test/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    // 結合のテストのファイルがまだ無くても、`test:integration` を落とさない
    passWithNoTests: true,
  },
});
