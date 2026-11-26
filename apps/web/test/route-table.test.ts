// @vitest-environment node
import { readFile } from "node:fs/promises";
import { OPERATIONS } from "@nd-factory/contracts/operations";
import { describe, expect, it } from "vitest";
import { parseScreensTable, renderRouteOperations, SCREENS_DOC } from "../scripts/build-route-operations.ts";
import { ROUTE_OPERATIONS } from "../src/routes/route-operations.generated.ts";
import { isMapPath, matchReturn, ROUTES } from "../src/routes/route-table.ts";

const url = (path: string) => new URL(path, "https://app.example.com");

describe("matchReturn", () => {
  it("3 つの戻り先を見分ける", () => {
    expect(matchReturn(url("/?code=a&state=b"))).toBe("return:signin");
    expect(matchReturn(url("/me/logins/return?code=a&state=b"))).toBe("return:link");
    expect(matchReturn(url("/signed-out"))).toBe("return:signout");
  });
  it("code か state の片方だけの / は戻り先でない", () => {
    expect(matchReturn(url("/?code=a"))).toBeNull();
    expect(matchReturn(url("/?state=b"))).toBeNull();
    expect(matchReturn(url("/me?code=a&state=b"))).toBeNull();
  });
  it("code 付きの /signed-out はサインアウトの戻り", () => {
    expect(matchReturn(url("/signed-out?code=a&state=b"))).toBe("return:signout");
  });
});

describe("画面マップの表", () => {
  it("R1〜R16 の 16 本を、画面の文書の path で持つ", async () => {
    const doc = await readFile(SCREENS_DOC, "utf8");
    const documented = [...doc.matchAll(/^\| (R\d+) \| `([^`]+)` \|/gm)].map((m) => [m[1], m[2]]);
    expect(documented).toHaveLength(16);
    expect(ROUTES.map((r) => [r.id, r.path])).toEqual(documented);
  });
  it("画面の path だけを画面マップの path と判定する", () => {
    expect(isMapPath("/p/prj_1/sprints/spr_1")).toBe(true);
    expect(isMapPath("/approvals")).toBe(true);
    expect(isMapPath("/nowhere")).toBe(false);
    expect(isMapPath("/signed-out")).toBe(false);
  });
  it("画面の操作は、どれもスキーマの正本の操作の一覧にある", () => {
    const known = new Set<string>(OPERATIONS.map((op) => op.name));
    const used = ROUTES.flatMap((r) => r.operations);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !known.has(name))).toEqual([]);
  });
  it("利用者が呼ぶ操作は、どれもどこかの画面にある", () => {
    const used = new Set(ROUTES.flatMap((r) => r.operations));
    const missing = OPERATIONS.filter((op) => op.endpoint === "user" && !used.has(op.name)).map((op) => op.name);
    // 画面を持たないのは、オーガナイザー専用の委任だけが呼べる起票の依頼だけである（人が呼ぶと 403。docs/design/api.md の操作の一覧）
    expect(missing).toEqual(["issue_requests.create"]);
  });
});

const HEAD = "## 画面一覧\n\n| HTTP のルート | 画面 | 読む・書く API の操作 |\n| --- | --- | --- |\n";
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => `| R${i + 1} \`/x\` | 画面 | （IdP へ移る） \`a.get\` と \`/\` |`).join("\n");

describe("ルートと操作の対応の生成", () => {
  it("実の画面の文書から 16 本を読み、コミットした生成物と一致する", async () => {
    const map = parseScreensTable(await readFile(SCREENS_DOC, "utf8"));
    expect([...map.keys()]).toHaveLength(16);
    expect(Object.fromEntries(map)).toEqual(ROUTE_OPERATIONS);
  });
  it("コードの書式のうち操作の名前の形だけを読む", () => {
    expect(parseScreensTable(HEAD + rows(16)).get("R1")).toEqual(["a.get"]);
  });
  it("見出しの違いと 15 本は失敗する", () => {
    expect(() => parseScreensTable((HEAD + rows(16)).replace("読む・書く API の操作", "操作"))).toThrow("読む・書く API の操作");
    expect(() => parseScreensTable(HEAD + rows(15))).toThrow("R16");
  });
  it("同じ入力で同じ出力", () => {
    const map = parseScreensTable(HEAD + rows(16));
    expect(renderRouteOperations(map)).toBe(renderRouteOperations(map));
  });
});
