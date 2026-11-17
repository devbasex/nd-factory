import { describe, expect, it } from "vitest";
import { webConfigSchema } from "../src/web-config.ts";

const valid = {
  api_url: "https://api.example.com",
  authority: "https://acme-test.auth.example.com",
  client_id: "example-app-client",
  login_ready: false,
};

describe("webConfigSchema", () => {
  it("4 つのキーを受ける", () => {
    expect(webConfigSchema.parse(valid)).toEqual(valid);
  });

  it("キーが欠けるか URL でないと拒む", () => {
    expect(webConfigSchema.safeParse({ ...valid, login_ready: undefined }).success).toBe(false);
    expect(webConfigSchema.safeParse({ ...valid, api_url: "not a url" }).success).toBe(false);
    expect(webConfigSchema.safeParse({ ...valid, client_id: "" }).success).toBe(false);
  });
});
