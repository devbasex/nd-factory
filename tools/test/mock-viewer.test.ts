import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MOCK_ORIGIN, readMockFile } from "../mock-viewer/src/files.ts";

describe("readMockFile", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mock-viewer-"));
    mkdirSync(join(root, "project"));
    writeFileSync(join(root, "viewer.html"), "<html></html>");
    writeFileSync(join(root, "project", "canvas.json"), "{}");
    writeFileSync(join(root, "project", "Home.dc.html"), "<p>画面</p>");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("ルートの URL は viewer.html を返す", () => {
    const file = readMockFile(root, `${MOCK_ORIGIN}/`);
    expect(file?.status).toBe(200);
    expect(file?.contentType).toBe("text/html; charset=utf-8");
    expect(file?.body.toString()).toBe("<html></html>");
  });

  it("下の階層のファイルを拡張子に合う型で返し、クエリとハッシュを無視する", () => {
    const file = readMockFile(root, `${MOCK_ORIGIN}/project/canvas.json?v=1#organizer`);
    expect(file?.status).toBe(200);
    expect(file?.contentType).toBe("application/json; charset=utf-8");
  });

  it("URL エンコードした名前を読み解く", () => {
    writeFileSync(join(root, "project", "承認 待ち.dc.html"), "x");
    const file = readMockFile(root, `${MOCK_ORIGIN}/project/${encodeURIComponent("承認 待ち.dc.html")}`);
    expect(file?.status).toBe(200);
  });

  it("無いファイルは 404 を返す", () => {
    expect(readMockFile(root, `${MOCK_ORIGIN}/project/none.html`)?.status).toBe(404);
  });

  it("ルートの外へ出るパスは 404 を返し、ファイルを読まない", () => {
    writeFileSync(join(root, "..", "secret.txt"), "s");
    expect(readMockFile(root, `${MOCK_ORIGIN}/%2e%2e/secret.txt`)?.status).toBe(404);
    expect(readMockFile(root, `${MOCK_ORIGIN}/project/..%2f..%2fsecret.txt`)?.status).toBe(404);
    rmSync(join(root, "..", "secret.txt"));
  });

  it("ディレクトリは 404 を返す", () => {
    expect(readMockFile(root, `${MOCK_ORIGIN}/project`)?.status).toBe(404);
  });

  it("モックの外のオリジンは扱わない", () => {
    expect(readMockFile(root, "http://example.com/viewer.html")).toBeUndefined();
  });
});
