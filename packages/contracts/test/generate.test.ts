import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DUMMY_DIR, GENERATED_DIR, GenerateError, generateArtifacts, generateArtifactsFor } from "../scripts/generate.ts";
import { idOf } from "../src/ids.ts";
import { defineOperation, okItem } from "../src/operation.ts";
import { OPERATIONS } from "../src/operations/index.ts";
import { money } from "../src/values.ts";
import { FIXTURE_OPERATIONS } from "./fixtures/operations.ts";

const OUTPUTS = ["packages/contracts/schema/settings.schema.json", "infra/settings.example.json", "docs/operations/setup.md"];
// 操作の表からの生成物。今の操作はどれも形の未定のため、ダミーは index.json だけ
const GENERATED = [
  `${GENERATED_DIR}/operations.schema.json`,
  `${GENERATED_DIR}/openapi.json`,
  `${GENERATED_DIR}/mcp-tools.json`,
  `${GENERATED_DIR}/routes.json`,
  `${GENERATED_DIR}/reasons.json`,
  `${GENERATED_DIR}/pending.json`,
  `${DUMMY_DIR}/index.json`,
];
const FIXTURE_DUMMIES = FIXTURE_OPERATIONS.map((op) => `${DUMMY_DIR}/${op.name}.json`);

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

  it("何も無い所の check はすべての生成物のパスを返し、書かない", async () => {
    expect(await generateArtifacts(root, "check")).toEqual([...OUTPUTS, ...GENERATED]);
    expect(await generateArtifacts(root, "check")).toEqual([...OUTPUTS, ...GENERATED]);
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
    cpSync(join(repo, GENERATED_DIR), join(root, GENERATED_DIR), { recursive: true });
    expect(await generateArtifacts(root, "check")).toEqual([]);
  });

  it("操作の定義を変えて generate を打たずに check を打つと、差のある生成物を返す", async () => {
    await generateArtifacts(root, "write");
    const differ = await generateArtifactsFor(root, "check", [...OPERATIONS, ...FIXTURE_OPERATIONS]);
    expect(differ).toEqual(expect.arrayContaining([`${GENERATED_DIR}/operations.schema.json`, `${GENERATED_DIR}/routes.json`, ...FIXTURE_DUMMIES]));
    expect(differ).not.toContain(OUTPUTS[0]);
  });

  it("形のある操作はダミーのファイルを持ち、消えた操作のダミーは check で差になり write で消える", async () => {
    await generateArtifactsFor(root, "write", [...OPERATIONS, ...FIXTURE_OPERATIONS]);
    for (const p of FIXTURE_DUMMIES) expect(existsSync(join(root, p))).toBe(true);
    const index = JSON.parse(readFileSync(join(root, DUMMY_DIR, "index.json"), "utf8")) as Record<string, string | null>;
    expect(index["fixture_notes.list"]).toBe("fixture_notes.list.json");
    expect(index["projects.get"]).toBeNull();
    expect(await generateArtifactsFor(root, "check", OPERATIONS)).toEqual(expect.arrayContaining(FIXTURE_DUMMIES));
    await generateArtifacts(root, "write");
    for (const p of FIXTURE_DUMMIES) expect(existsSync(join(root, p))).toBe(false);
    expect(await generateArtifacts(root, "check")).toEqual([]);
  });

  it("古いダミーの掃除は生成したダミー JSON だけを消し、サブディレクトリと .json でないファイルを残す", async () => {
    await generateArtifacts(root, "write");
    const dir = join(root, DUMMY_DIR);
    mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(join(dir, "notes", "keep.json"), "{}\n");
    writeFileSync(join(dir, "README.md"), "メモ\n");
    writeFileSync(join(dir, "gone.json"), "{}\n");
    expect(await generateArtifacts(root, "check")).toEqual([`${DUMMY_DIR}/gone.json`]);
    await generateArtifacts(root, "write");
    expect(existsSync(join(dir, "gone.json"))).toBe(false);
    expect(existsSync(join(dir, "notes", "keep.json"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });

  it("見本の誤り（通貨の無い金額）で書かずに投げる", async () => {
    const bad = defineOperation({
      name: "fixture_bills.update",
      features: ["F1"],
      access: "write",
      delegationKind: "manage",
      item: z.strictObject({ bill_id: idOf("prj") }),
      result: okItem(z.strictObject({ budget: money })),
      examples: { normal: [{ ok: true, item: { budget: { amount_minor: 1 } } }] },
      owner: "#2",
    });
    await expect(generateArtifactsFor(root, "write", [...OPERATIONS, bad])).rejects.toBeInstanceOf(GenerateError);
    expect(existsSync(join(root, GENERATED_DIR))).toBe(false);
    expect(existsSync(join(root, OUTPUTS[0]!))).toBe(false);
  });

  it("見本は JSON Schema の必須のキーを持ち、client_id を持たない", async () => {
    await generateArtifacts(root, "write");
    const example = JSON.parse(readFileSync(join(root, OUTPUTS[1]!), "utf8")) as Record<string, unknown>;
    expect(example).toEqual({ prefix: "acme", environment: "test", login: { google: {} } });
    const schema = JSON.parse(readFileSync(join(root, OUTPUTS[0]!), "utf8")) as { required: string[] };
    expect(schema.required).toEqual(["prefix", "environment", "login"]);
  });
});
