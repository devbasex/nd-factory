// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createKeySet, seal, tagOf, UnreadableError, unseal } from "../../src/offline/crypto.ts";

describe("暗号化と HMAC", () => {
  it("暗号化した値は復号で戻り、暗号文に平文が現れない", async () => {
    const { key } = await createKeySet();
    const sealed = await seal(key, { note: "example-note" });
    expect(new TextDecoder().decode(sealed.data)).not.toContain("example-note");
    await expect(unseal(key, sealed)).resolves.toEqual({ note: "example-note" });
  });

  it("同じ値を 2 回暗号化すると 12 バイトの IV が違う", async () => {
    const { key } = await createKeySet();
    const [a, b] = [await seal(key, "x"), await seal(key, "x")];
    expect(a.iv).toHaveLength(12);
    expect(a.iv).not.toEqual(b.iv);
  });

  it("キーは取り出せない", async () => {
    const { key, tagKey } = await createKeySet();
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("raw", tagKey)).rejects.toThrow();
  });

  it("壊した暗号文と違うキーは UnreadableError", async () => {
    const { key } = await createKeySet();
    const sealed = await seal(key, "x");
    const broken = new Uint8Array(sealed.data.slice(0));
    broken[0] = (broken[0] ?? 0) ^ 1;
    await expect(unseal(key, { iv: sealed.iv, data: broken.buffer })).rejects.toBeInstanceOf(UnreadableError);
    await expect(unseal((await createKeySet()).key, sealed)).rejects.toBeInstanceOf(UnreadableError);
  });

  it("タグは同じキーと入力で同じになり、区切りの位置が違えば違う", async () => {
    const { tagKey } = await createKeySet();
    const tag = await tagOf(tagKey, "ab", "c");
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
    await expect(tagOf(tagKey, "ab", "c")).resolves.toBe(tag);
    await expect(tagOf(tagKey, "a", "bc")).resolves.not.toBe(tag);
    await expect(tagOf((await createKeySet()).tagKey, "ab", "c")).resolves.not.toBe(tag);
  });
});
