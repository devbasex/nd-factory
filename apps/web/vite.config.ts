import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { MODULE_LIST } from "./scripts/check-dummy-free.ts";
import { moduleListPlugin } from "./scripts/module-list-plugin.ts";

// 画面を Vite で束ねる。出力は apps/web/dist で、配信の置き場へそのまま載せる。
// mode dummy は画面の状態と手数を確かめるためのビルドで、出力を dist-dummy に分ける
export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  plugins: mode === "dummy" ? [react()] : [react(), moduleListPlugin(MODULE_LIST)],
  build: {
    outDir: mode === "dummy" ? "dist-dummy" : "dist",
    emptyOutDir: true,
    // Service Worker が事前に保存する一覧の元（scripts/build-sw.ts）
    manifest: mode !== "dummy",
  },
  preview: {
    port: mode === "dummy" ? 4174 : 4173,
    strictPort: true,
  },
}));
