import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, StoreError, ensureUser } from "../src/user-store.ts";
import { FakeStore } from "./fake-store.ts";

const TABLE = "acme-test-accounts";
const T1 = new Date("2026-01-02T03:04:05.000Z");
const T2 = new Date("2026-02-03T04:05:06.000Z");

describe("ensureUser", () => {
  it("行が無ければ条件付きで作り、その中身を返す", async () => {
    const store = new FakeStore();
    const row = await ensureUser(store.asClient(), TABLE, "sub-1", T1);
    expect(row).toEqual({ id: "sub-1", created_at: T1.toISOString() });
    expect(store.rows.get("USER#sub-1|PROFILE")).toEqual({
      pk: "USER#sub-1",
      sk: "PROFILE",
      schema_version: SCHEMA_VERSION,
      created_at: T1.toISOString(),
    });
    const put = store.calls[0] as PutCommand;
    expect(put).toBeInstanceOf(PutCommand);
    expect(put.input.TableName).toBe(TABLE);
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("行があれば作らず、created_at を変えない", async () => {
    const store = new FakeStore();
    await ensureUser(store.asClient(), TABLE, "sub-1", T1);
    const row = await ensureUser(store.asClient(), TABLE, "sub-1", T2);
    expect(row).toEqual({ id: "sub-1", created_at: T1.toISOString() });
    expect(store.rows.get("USER#sub-1|PROFILE")?.created_at).toBe(T1.toISOString());
    expect(store.calls.at(-1)).toBeInstanceOf(GetCommand);
  });

  it("同時の作成で条件に当たれば、行を読み直す", async () => {
    const store = new FakeStore();
    store.raceRow = { pk: "USER#sub-1", sk: "PROFILE", schema_version: 1, created_at: T1.toISOString() };
    const row = await ensureUser(store.asClient(), TABLE, "sub-1", T2);
    expect(row).toEqual({ id: "sub-1", created_at: T1.toISOString() });
    const get = store.calls[1] as GetCommand;
    expect(get.input.ConsistentRead).toBe(true);
  });

  it("表の失敗は操作の名前つきで投げる", async () => {
    const store = new FakeStore();
    const failure = new Error("throttled");
    failure.name = "ProvisionedThroughputExceededException";
    store.failWith = failure;
    const err = await ensureUser(store.asClient(), TABLE, "sub-1", T1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).operation).toBe("put");
    expect((err as StoreError).causeName).toBe("ProvisionedThroughputExceededException");
  });

  it("読み直しで行が無ければ投げる", async () => {
    const store = new FakeStore();
    store.raceRow = { pk: "USER#sub-1", sk: "PROFILE", schema_version: 1, created_at: T1.toISOString() };
    const send = store.send.bind(store);
    store.send = async (cmd) => {
      const out = await send(cmd);
      if (cmd instanceof PutCommand) return out;
      return { Item: undefined };
    };
    const err = await ensureUser(store.asClient(), TABLE, "sub-1", T2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).operation).toBe("get");
  });

  it("空の sub を受けない", async () => {
    const store = new FakeStore();
    await expect(ensureUser(store.asClient(), TABLE, "", T1)).rejects.toThrow();
    expect(store.calls).toHaveLength(0);
  });
});
