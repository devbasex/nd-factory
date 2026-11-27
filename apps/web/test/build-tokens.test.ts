// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTokens, TOKENS_DIR } from "../scripts/build-tokens.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function copy(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "tokens-"));
  for (const name of ["tokens.json", "tokens.dark.json", "tokens.generated.css"]) {
    await writeFile(join(dir, name), await readFile(join(TOKENS_DIR, name), "utf8"));
  }
  return dir;
}

describe("buildTokens", () => {
  it("コミットした生成物と一致し、ダークの値は prefers-color-scheme の中に出る", async () => {
    await expect(buildTokens("check")).resolves.toBeUndefined();
    const css = await readFile(join(TOKENS_DIR, "tokens.generated.css"), "utf8");
    const [light, dark] = css.split("@media (prefers-color-scheme: dark)");
    expect(light).toContain("--size-target-min: 44px;");
    expect(dark).toContain("--color-ground: #14161c;");
  });

  it("JSON の値を変えると check が落ちる", async () => {
    const work = await copy();
    const json = (await readFile(join(work, "tokens.json"), "utf8")).replace('"44px"', '"40px"');
    await writeFile(join(work, "tokens.json"), json);
    await expect(buildTokens("check", work)).rejects.toThrow("tokens.generated.css");
  });
});
