import { describe, expect, it } from "vitest";
import contracts from "../data/ndf-contracts.json" with { type: "json" };
import { ndfAnswerWord, ndfContractSet } from "../src/ndf.ts";

const SHA = "ed8b036584bec284dfc93a2bb5b988e2385b4f8f297d659399f5d3cb91b520c4";
const OTHER_SHA = "0".repeat(64);

function passes(value: unknown): boolean {
  return ndfContractSet.safeParse(value).success;
}

describe("ndfContractSet", () => {
  it("今のデータが通る", () => {
    expect(passes(contracts)).toBe(true);
  });

  it("組が 1 つでも通る", () => {
    expect(passes({ accepted: [{ version: 1, sha256: OTHER_SHA }] })).toBe(true);
  });

  it("組が 2 つ並んでも通る（配布の移り目）", () => {
    expect(passes({ accepted: [{ version: 8, sha256: SHA }, { version: 9, sha256: OTHER_SHA }] })).toBe(true);
  });

  it.each([
    ["空の集合", { accepted: [] }],
    ["集合が無い", {}],
    ["63 桁の sha256", { accepted: [{ version: 8, sha256: SHA.slice(1) }] }],
    ["65 桁の sha256", { accepted: [{ version: 8, sha256: `${SHA}0` }] }],
    ["大文字の 16 進", { accepted: [{ version: 8, sha256: SHA.toUpperCase() }] }],
    ["16 進でない字", { accepted: [{ version: 8, sha256: `${SHA.slice(1)}g` }] }],
    ["版 0", { accepted: [{ version: 0, sha256: SHA }] }],
    ["版が整数でない", { accepted: [{ version: 8.5, sha256: SHA }] }],
    ["版が文字列", { accepted: [{ version: "8", sha256: SHA }] }],
    ["版だけ", { accepted: [{ version: 8 }] }],
    ["sha256 だけ", { accepted: [{ sha256: SHA }] }],
    ["対でなく値の並び", { accepted: [8, SHA] }],
    ["組に余分な鍵", { accepted: [{ version: 8, sha256: SHA, latest: true }] }],
    ["集合に余分な鍵", { accepted: [{ version: 8, sha256: SHA }], preferred: 8 }],
  ])("%s を拒む", (_why, value) => {
    expect(passes(value)).toBe(false);
  });
});

describe("ndfAnswerWord", () => {
  it("答えの語は 6 つ", () => {
    expect(ndfAnswerWord.options).toEqual(["approved", "rejected", "request_changes", "retry", "finish", "cancel"]);
  });

  it.each(["approve", "APPROVED", "", "done"])("語に無い値を拒む（%s）", (value) => {
    expect(ndfAnswerWord.safeParse(value).success).toBe(false);
  });
});
