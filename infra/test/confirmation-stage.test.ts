import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type RecordState, confirmationStage, refusalReason } from "../lib/confirmation-stage.ts";

type StageCase = { name: string; settings: unknown; record: RecordState; stage?: string; refused: boolean };

const STAGE_CASES = JSON.parse(
  readFileSync(new URL("../../packages/contracts/test/fixtures/confirmation-stage-cases.json", import.meta.url), "utf8"),
) as StageCase[];

describe("confirmationStage と refusalReason（契約の表）", () => {
  it.each(STAGE_CASES)("$name", ({ settings, record, stage, refused }) => {
    // パラメーターを読めない行は null で、期待する段階を持たない
    const read = settings === null ? undefined : settings;
    if (stage !== undefined) expect(confirmationStage(read)).toBe(stage);
    else expect(settings).toBeNull();
    expect(refusalReason(read, record) !== null).toBe(refused);
  });
});
