import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createClock } from "@nd-factory/core/clock";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, StoreError, ensureUser } from "../src/user-store.ts";
import { FakeStore } from "./fake-store.ts";

const TABLE = "acme-test-accounts";
const T1 = new Date("2026-01-02T03:04:05.000Z");
const T2 = new Date("2026-02-03T04:05:06.000Z");
const clockAt = (at: Date) => createClock(() => at.getTime());

describe("ensureUser", () => {
  it("行が無ければ条件付きで作り、その中身を返す", async () => {
    const store = new FakeStore();
    const row = await ensureUser(store.asDb(TABLE), "users", "sub-1", clockAt(T1));
    expect(row).toEqual({ id: "sub-1", created_at: T1.toISOString() });
    expect(store.rows.get("USER#sub-1|PROFILE")).toEqual({
      pk: "USER#sub-1",
      sk: "PROFILE",
      schema_version: SCHEMA_VERSION,
      created_at: T1.toISOString(),
      // putIfAbsent が新しい行の世代（UUID v4）を入れる
      incarnation: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    });
    const write = store.calls[0] as TransactWriteCommand;
    expect(write).toBeInstanceOf(TransactWriteCommand);
    const put = write.input.TransactItems?.[0]?.Put;
    expect(put?.TableName).toBe(TABLE);
    expect(put?.ConditionExpression).toBe("attribute_not_exists(#n0)");
    expect(put?.ExpressionAttributeNames).toEqual({ "#n0": "pk" });
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("行があれば作らず、created_at を変えない", async () => {
    const store = new FakeStore();
    await ensureUser(store.asDb(TABLE), "users", "sub-1", clockAt(T1));
    const row = await ensureUser(store.asDb(TABLE), "users", "sub-1", clockAt(T2));
    expect(row).toEqual({ id: "sub-1", created_at: T1.toISOString() });
    expect(store.rows.get("USER#sub-1|PROFILE")?.created_at).toBe(T1.toISOString());
    expect(store.calls.at(-1)).toBeInstanceOf(GetCommand);
  });

  it("同時の作成で条件に当たれば、行を読み直す", async () => {
    const store = new FakeStore();
    store.raceRow = { pk: "USER#sub-1", sk: "PROFILE", schema_version: 1, created_at: T1.toISOString() };
    const row = await ensureUser(store.asDb(TABLE), "users", "sub-1", clockAt(T2));
    expect(row).toEqual({ id: "sub-1", created_at: T1.toISOString() });
    const get = store.calls[1] as GetCommand;
    expect(get.input.TableName).toBe(TABLE);
    expect(get.input.ConsistentRead).toBe(true);
  });

  it("表の失敗は操作の名前つきで投げる", async () => {
    const store = new FakeStore();
    const failure = new Error("throttled");
    failure.name = "ProvisionedThroughputExceededException";
    store.failWith = failure;
    const err = await ensureUser(store.asDb(TABLE), "users", "sub-1", clockAt(T1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).operation).toBe("put");
    expect((err as StoreError).causeName).toBe("ProvisionedThroughputExceededException");
  });

  it("読み直しの失敗は get の名前つきで投げる", async () => {
    const store = new FakeStore();
    store.raceRow = { pk: "USER#sub-1", sk: "PROFILE", schema_version: 1, created_at: T1.toISOString() };
    const send = store.send.bind(store);
    store.send = async (cmd) => {
      if (cmd instanceof GetCommand) throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      return send(cmd);
    };
    const err = await ensureUser(store.asDb(TABLE), "users", "sub-1", clockAt(T2)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).operation).toBe("get");
    expect((err as StoreError).causeName).toBe("AccessDeniedException");
  });

  it("読み直しで行が無ければ投げる", async () => {
    const store = new FakeStore();
    store.raceRow = { pk: "USER#sub-1", sk: "PROFILE", schema_version: 1, created_at: T1.toISOString() };
    const send = store.send.bind(store);
    store.send = async (cmd) => {
      const out = await send(cmd);
      if (cmd instanceof TransactWriteCommand) return out;
      return { Item: undefined };
    };
    const err = await ensureUser(store.asDb(TABLE), "users", "sub-1", clockAt(T2)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).operation).toBe("get");
  });

  it("空の sub を受けない", async () => {
    const store = new FakeStore();
    await expect(ensureUser(store.asDb(TABLE), "users", "", clockAt(T1))).rejects.toThrow();
    expect(store.calls).toHaveLength(0);
  });
});
