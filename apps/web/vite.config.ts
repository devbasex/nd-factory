import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 画面を Vite で束ねる。出力は apps/web/dist で、配信の置き場へそのまま載せる
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
