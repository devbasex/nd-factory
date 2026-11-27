import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Plugin } from "vite";

// 成果物に描き出したモジュールの ID と、最適化の後に残った書き出しの名前の一覧を、成果物の外のファイルへ書く

export function moduleListPlugin(outFile: string): Plugin {
  return {
    name: "nd-module-list",
    generateBundle(_options, bundle) {
      const modules = Object.values(bundle).flatMap((output) =>
        output.type === "chunk"
          ? Object.entries(output.modules).map(([id, module]) => ({ id, renderedExports: module.renderedExports }))
          : [],
      );
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, JSON.stringify(modules, null, 2));
    },
  };
}
