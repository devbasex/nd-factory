import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GenerateError, generateArtifacts } from "../scripts/generate.ts";

const OUTPUTS = ["packages/contracts/schema/settings.schema.json", "infra/settings.example.json", "docs/operations/setup.md"];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "contracts-generate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("generateArtifacts", () => {
  it("write の後の check は空", async () => {
    expect(await generateArtifacts(root, "write")).toEqual([]);
    expect(await generateArtifacts(root, "check")).toEqual([]);
  });

  it("何も無い所の check は 3 つのパスを返し、書かない", async () => {
    expect(await generateArtifacts(root, "check")).toEqual(OUTPUTS);
    expect(await generateArtifacts(root, "check")).toEqual(OUTPUTS);
  });

  it("生成物を書き換えると、そのパスだけを返す", async () => {
    await generateArtifacts(root, "write");
    const schemaPath = join(root, OUTPUTS[0]!);
    writeFileSync(schemaPath, readFileSync(schemaPath, "utf8").replace('"prefix"', '"prefix_old"'));
    expect(await generateArtifacts(root, "check")).toEqual([OUTPUTS[0]]);
  });

  it("setup.md の印の外は書き換えない", async () => {
    mkdirSync(join(root, "docs/operations"), { recursive: true });
    const before = "# 手順\n\n前の本文\n\n<!-- exit-codes:begin -->\n古い表\n<!-- exit-codes:end -->\n\n後の本文\n";
    writeFileSync(join(root, OUTPUTS[2]!), before);
    expect(await generateArtifacts(root, "check")).toContain(OUTPUTS[2]);
    await generateArtifacts(root, "write");
    const after = readFileSync(join(root, OUTPUTS[2]!), "utf8");
    expect(after.startsWith("# 手順\n\n前の本文\n\n<!-- exit-codes:begin -->\n")).toBe(true);
    expect(after.endsWith("<!-- exit-codes:end -->\n\n後の本文\n")).toBe(true);
    expect(after).not.toContain("古い表");
    expect(after).toContain("| 7 |");
  });

  it("setup.md が無ければ見出しと印だけで作る", async () => {
    await generateArtifacts(root, "write");
    const text = readFileSync(join(root, OUTPUTS[2]!), "utf8");
    expect(text.startsWith("# 設置の手順\n")).toBe(true);
    expect(text).toContain("<!-- exit-codes:begin -->");
    expect(text).toContain("<!-- exit-codes:end -->");
  });

  it("印の無い setup.md は書き換えずに誤りにする", async () => {
    mkdirSync(join(root, "docs/operations"), { recursive: true });
    writeFileSync(join(root, OUTPUTS[2]!), "# 手順\n");
    await expect(generateArtifacts(root, "write")).rejects.toBeInstanceOf(GenerateError);
    expect(readFileSync(join(root, OUTPUTS[2]!), "utf8")).toBe("# 手順\n");
  });

  it("リポジトリに置いた生成物は今の形の正本と同じ", async () => {
    const repo = new URL("../../../", import.meta.url).pathname;
    for (const p of OUTPUTS) {
      mkdirSync(join(root, p, ".."), { recursive: true });
      cpSync(join(repo, p), join(root, p));
    }
    expect(await generateArtifacts(root, "check")).toEqual([]);
  });

  it("見本は JSON Schema の必須のキーを持ち、client_id を持たない", async () => {
    await generateArtifacts(root, "write");
    const example = JSON.parse(readFileSync(join(root, OUTPUTS[1]!), "utf8")) as Record<string, unknown>;
    expect(example).toEqual({ prefix: "acme", environment: "test", login: { google: {} } });
    const schema = JSON.parse(readFileSync(join(root, OUTPUTS[0]!), "utf8")) as { required: string[] };
    expect(schema.required).toEqual(["prefix", "environment", "login"]);
  });
});
