import { ID_KINDS } from "@nd-factory/contracts/ids";
import { describe, expect, it } from "vitest";
import { createClock } from "../src/clock.ts";
import { newId, parseId } from "../src/ids.ts";

// 単調性の状態はモジュールに 1 つあるため、このファイルの時計は前のテストより先の時刻から始める
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fixedClock(ms: number) {
  return createClock(() => ms);
}

// UUIDv7 の頭 48 ビットのミリ秒
function msecsOf(id: string): number {
  const hex = id.slice(id.indexOf("_") + 1).replaceAll("-", "").slice(0, 12);
  return Number.parseInt(hex, 16);
}

describe("newId", () => {
  it("頭と UUIDv7 の形で、時刻の部分が時計のミリ秒", () => {
    const ms = Date.UTC(2026, 10, 21, 0, 0, 0, 1);
    const id = newId("usr", fixedClock(ms));
    expect(id.startsWith("usr_")).toBe(true);
    expect(id.slice(4)).toMatch(UUID_V7);
    expect(msecsOf(id)).toBe(ms);
  });

  it("どの種類の頭でも parseId が受ける形を作る", () => {
    const clock = fixedClock(Date.UTC(2026, 10, 21, 0, 0, 1));
    for (const kind of ID_KINDS) expect(parseId(kind, newId(kind, clock))).not.toBeNull();
  });

  it("2 つ作ると後の方が大きい", () => {
    let ms = Date.UTC(2026, 10, 21, 0, 0, 2);
    const clock = createClock(() => (ms += 5));
    const first = newId("prj", clock);
    const second = newId("prj", clock);
    expect(second > first).toBe(true);
  });

  it("同じミリ秒の中で 1,000 個作っても重ならず、作った順に並ぶ", () => {
    const ms = Date.UTC(2026, 10, 21, 0, 0, 3);
    const clock = fixedClock(ms);
    const ids = Array.from({ length: 1_000 }, () => newId("aud", clock));
    expect(new Set(ids).size).toBe(1_000);
    expect([...ids].sort()).toEqual(ids);
    expect(msecsOf(ids[0] ?? "")).toBe(ms);
  });

  it("時計が戻っても前の値より大きい", () => {
    const later = Date.UTC(2026, 10, 21, 0, 0, 5);
    const first = newId("spr", fixedClock(later));
    const second = newId("spr", fixedClock(later - 1_000));
    expect(second > first).toBe(true);
    expect(msecsOf(second)).toBe(later);
  });

  it("集合に無い種類は型で弾き、型の外から来ても実行の時に投げる", () => {
    const clock = fixedClock(Date.UTC(2026, 10, 21, 0, 0, 6));
    // @ts-expect-error ID の頭の集まりに無い種類
    expect(() => newId("nope", clock)).toThrow(TypeError);
  });
});

describe("parseId", () => {
  const valid = "usr_01890a5d-ac96-774b-bcce-b302099a8057";

  it("合う ID を返す", () => {
    expect(parseId("usr", valid)).toBe(valid);
  });

  it.each([
    ["大文字", valid.toUpperCase().replace("USR_", "usr_")],
    ["頭の違い", valid.replace("usr_", "prj_")],
    ["版の数字が 7 でない", "usr_01890a5d-ac96-474b-bcce-b302099a8057"],
    ["変種が 8〜b でない", "usr_01890a5d-ac96-774b-ccce-b302099a8057"],
    ["空", ""],
    ["長すぎる", `${valid}0`],
    ["頭だけ", "usr_"],
  ])("%s は null", (_why, value) => {
    expect(parseId("usr", value)).toBeNull();
  });
});
