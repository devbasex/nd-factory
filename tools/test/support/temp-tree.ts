import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

/** 一時の木の作成と、ファイルの配置 */
type TempTree = {
  /** 接頭辞を付けた一時のディレクトリを作る。テストごとに後片付けする */
  tempDir(prefix: string): string;
  /** 一時の木を作り、ファイルを置く */
  makeTree(files: Record<string, string>): string;
};

/**
 * テストのファイルの最上位で呼び、一時の木を作る道具を返す。作ったディレクトリはテストごとの afterEach で消す。
 * `treePrefix` は makeTree が作る木の接頭辞
 */
export function useTempTree(treePrefix: string): TempTree {
  const temps: string[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeTree(files: Record<string, string>): string {
    const root = tempDir(treePrefix);
    for (const [path, body] of Object.entries(files)) write(root, path, body);
    return root;
  }

  return { tempDir, makeTree };
}

/** 木の根からの相対のパスにファイルを置く。途中のディレクトリも作る */
export function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
