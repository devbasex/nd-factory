import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/sha256.ts";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const expected = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("sha256", () => {
  it("FIPS 180-4 の見本の値を出す", () => {
    expect(hex(sha256(new Uint8Array()))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256(new TextEncoder().encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("詰め物の境目（55・56・63・64・65 バイト）と複数の塊・多バイトの文字で node:crypto と同じ値を出す", () => {
    for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 128, 1000]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
      expect([length, hex(sha256(bytes))]).toEqual([length, expected(bytes)]);
    }
    const text = new TextEncoder().encode(JSON.stringify(["nd-factory/incarnation", "USER#usr_acme", "ログイン#google"]));
    expect(hex(sha256(text))).toBe(expected(text));
  });
});
