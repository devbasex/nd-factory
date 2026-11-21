import { describe, expect, it } from "vitest";
import { fakeTable } from "./fakes/table.ts";

// 偽の表そのものの振る舞い。ほかのテストが頼る読みの順と続きを固める

describe("fakeTable の scan", () => {
  it("大文字と小文字の違う鍵も、続きの鍵から抜けも重なりもなく読み切る", async () => {
    const table = fakeTable();
    for (const pk of ["a", "A", "b", "B", "USER#a", "USER#A"]) table.seed("users", { pk, sk: "USER", schema_version: 1 });
    const seen: string[] = [];
    let startKey = null as Parameters<typeof table.db.scan>[1]["startKey"];
    for (let page = 0; page < 10; page += 1) {
      const out = await table.db.scan("users", { limit: 1, startKey, consistent: true });
      seen.push(...out.items.map((row) => String(row["pk"])));
      if (out.lastKey === null) break;
      startKey = out.lastKey;
    }
    expect([...seen].sort()).toEqual(["A", "B", "USER#A", "USER#a", "a", "b"]);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
