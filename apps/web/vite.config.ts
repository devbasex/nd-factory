import { defineConfig } from "vite";

// 画面は素の TypeScript を Vite で束ねる。出力は apps/web/dist で、配信の置き場へそのまま載せる
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
