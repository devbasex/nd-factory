import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSEMBLY_DIGEST_SHELL, AssemblyDigestError, assemblyDigest } from "../lib/assembly-digest.ts";

function shellDigest(dir: string): string {
  return execFileSync("sh", ["-c", ASSEMBLY_DIGEST_SHELL], { cwd: dir, encoding: "utf8" }).trim();
}

function sampleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nd-assembly-"));
  writeFileSync(join(dir, "manifest.json"), '{"version":"1"}\n');
  writeFileSync(join(dir, "acme-test-app.template.json"), "{}\n");
  mkdirSync(join(dir, "asset.abc"));
  writeFileSync(join(dir, "asset.abc", "index.js"), "exports.handler = () => 1;\n");
  mkdirSync(join(dir, "asset.abc", "Sub"));
  writeFileSync(join(dir, "asset.abc", "Sub", "b.txt"), "b");
  writeFileSync(join(dir, "Z.txt"), "upper");
  return dir;
}

describe("assemblyDigest", () => {
  it("シェルの式と同じ 64 桁の 16 進を返す", async () => {
    const dir = sampleDir();
    const digest = await assemblyDigest(dir);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(shellDigest(dir));
  });

  it("空のディレクトリでもシェルの式と同じ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nd-assembly-empty-"));
    expect(await assemblyDigest(dir)).toBe(shellDigest(dir));
  });

  it("名前に空白やバックスラッシュのあるファイルでもシェルの式と同じ", async () => {
    const dir = sampleDir();
    writeFileSync(join(dir, "with space.txt"), "s");
    writeFileSync(join(dir, "back\\slash.txt"), "b");
    expect(await assemblyDigest(dir)).toBe(shellDigest(dir));
  });

  it("1 バイト書き換えると値が変わる", async () => {
    const dir = sampleDir();
    const before = await assemblyDigest(dir);
    writeFileSync(join(dir, "asset.abc", "index.js"), "exports.handler = () => 2;\n");
    expect(await assemblyDigest(dir)).not.toBe(before);
  });

  it("ファイルを足すと値が変わる", async () => {
    const dir = sampleDir();
    const before = await assemblyDigest(dir);
    writeFileSync(join(dir, "nd-setup-stacks.json"), "{}");
    expect(await assemblyDigest(dir)).not.toBe(before);
  });

  it("置き場が無ければ AssemblyDigestError", async () => {
    await expect(assemblyDigest(join(tmpdir(), "nd-no-such-assembly"))).rejects.toBeInstanceOf(AssemblyDigestError);
  });

  it("ディレクトリでなければ AssemblyDigestError", async () => {
    const dir = sampleDir();
    await expect(assemblyDigest(join(dir, "manifest.json"))).rejects.toBeInstanceOf(AssemblyDigestError);
  });
});
