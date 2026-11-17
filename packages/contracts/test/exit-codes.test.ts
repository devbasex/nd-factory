import { describe, expect, it } from "vitest";
import { EXIT, EXIT_CODES } from "../src/exit-codes.ts";

describe("EXIT", () => {
  it("0 と 2〜8 をちょうど 1 つずつ持つ", () => {
    expect(EXIT_CODES.map((c) => c.code)).toEqual([0, 2, 3, 4, 5, 6, 7, 8]);
    expect(Object.values(EXIT).sort((a, b) => a - b)).toEqual([0, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("名前から番号を引ける", () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.USAGE).toBe(2);
    expect(EXIT.CONFIRM_MISMATCH).toBe(7);
    expect(EXIT.DEPLOY_FAILED).toBe(8);
  });

  it("どの行も意味と AWS へ書いたかを持つ", () => {
    for (const c of EXIT_CODES) {
      expect(c.meaning.length).toBeGreaterThan(0);
      expect(c.aws_write.length).toBeGreaterThan(0);
    }
  });
});
