import { describe, expect, it } from "vitest";
import { buildDummy } from "../scripts/artifacts.ts";
import { createDummyTransport, createOperationClient, type DummyDoc, type DummyScenario, httpTransport, type Transport } from "../src/client.ts";
import { type ItemOf, MAX_ITEMS, resultSchemaOf } from "../src/operation.ts";
import { OPERATIONS } from "../src/operations/index.ts";
import { FIXTURE_CREATE, FIXTURE_LIST, FIXTURE_OPERATIONS } from "./fixtures/operations.ts";

const UUID_V7 = "01935b4e-7c2a-7d10-8f3e-2b6f0c9a1d42";
const PROJECT_ID = `prj_${UUID_V7}`;
const NOTE_ID = `ntc_${UUID_V7}`;
const CREATED = { ok: true, item: { note_id: NOTE_ID, version: 1, created_at: "2026-11-17T03:04:05Z" } } as const;

const CREATE_ITEM: ItemOf<typeof FIXTURE_CREATE> = {
  project_id: PROJECT_ID,
  title: "見本",
  due_at: "2026-12-01T00:00:00Z",
  budget: { amount_minor: 1200, currency: "USD" },
  language: "ja-JP",
  time_zone: "Asia/Tokyo",
  repo: "acme/factory",
};
const LIST_ITEM: ItemOf<typeof FIXTURE_LIST> = { project_id: PROJECT_ID, cursor: null };

function replying(status: number, body: unknown): Transport {
  return async () => ({ status, body });
}

const DUMMIES: Record<string, DummyDoc | null> = Object.fromEntries(FIXTURE_OPERATIONS.map((op) => [op.name, buildDummy(op)]));

function dummyClient(scenario: DummyScenario, dummies: Record<string, DummyDoc | null> = DUMMIES) {
  return createOperationClient(
    createDummyTransport(dummies, () => scenario),
    FIXTURE_OPERATIONS,
  );
}

describe("createOperationClient", () => {
  it("送り手の応答を型つきの結果で返す", async () => {
    const client = createOperationClient(replying(200, [CREATED]), FIXTURE_OPERATIONS);
    const res = await client.call("fixture_notes.create", [CREATE_ITEM]);
    expect(res).toEqual({ ok: true, results: [CREATED] });
    if (res.ok && res.results[0]?.ok) expect(res.results[0].item.note_id).toBe(NOTE_ID);
  });

  it("要素 1 個と上限ちょうど（全部か無かの 2）で、要求と同じ件数の結果を受ける", async () => {
    const sent: number[] = [];
    const transport: Transport = async (_op, items) => {
      sent.push(items.length);
      return { status: 200, body: items.map(() => CREATED) };
    };
    const client = createOperationClient(transport, FIXTURE_OPERATIONS);
    expect((await client.call("fixture_notes.create", [CREATE_ITEM])).ok).toBe(true);
    expect((await client.call("fixture_notes.create", [CREATE_ITEM, CREATE_ITEM])).ok).toBe(true);
    expect(sent).toEqual([1, 2]);
  });

  it.each([
    ["結果の形に合わない", [{ ok: true, item: { note_id: "x" } }]],
    ["件数が要求と違う", [CREATED, CREATED]],
    ["配列でない", CREATED],
  ])("%s応答で response_invalid", async (_label, body) => {
    const client = createOperationClient(replying(200, body), FIXTURE_OPERATIONS);
    expect(await client.call("fixture_notes.create", [CREATE_ITEM])).toEqual({ ok: false, status: 0, reason: "response_invalid" });
  });

  it("problem の本文で要求全体の誤りを返し、本文が読めなければ response_invalid", async () => {
    const problem = createOperationClient(replying(400, { type: "about:blank", status: 400, reason: "body_not_array" }), FIXTURE_OPERATIONS);
    expect(await problem.call("fixture_notes.list", [LIST_ITEM])).toEqual({ ok: false, status: 400, reason: "body_not_array" });
    const broken = createOperationClient(replying(500, "oops"), FIXTURE_OPERATIONS);
    expect(await broken.call("fixture_notes.list", [LIST_ITEM])).toEqual({ ok: false, status: 0, reason: "response_invalid" });
  });

  it("既定の表は操作の表で、形の未定の操作の成功の応答は response_invalid", async () => {
    const client = createOperationClient(replying(200, [{ ok: true, item: {} }]));
    expect(await client.call("projects.get", [{} as never])).toEqual({ ok: false, status: 0, reason: "response_invalid" });
  });
});

describe("httpTransport", () => {
  it("POST <baseUrl>/v1/<entity>/<verb> に Bearer と JSON の本文で送る", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify([CREATED]), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = httpTransport({ baseUrl: "https://api.example.com", fetch: fakeFetch, token: async () => "tkn" });
    const res = await transport(FIXTURE_CREATE, [CREATE_ITEM]);
    expect(res).toEqual({ status: 200, body: [CREATED] });
    expect(calls[0]?.url).toBe("https://api.example.com/v1/fixture_notes/create");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json", authorization: "Bearer tkn" });
    expect(calls[0]?.init?.body).toBe(JSON.stringify([CREATE_ITEM]));
  });

  it("token が無ければ Authorization を付けず、JSON でない本文は null", async () => {
    const fakeFetch = (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch;
    const transport = httpTransport({ baseUrl: "https://api.example.com", fetch: fakeFetch, token: async () => null });
    expect(await transport(FIXTURE_LIST, [LIST_ITEM])).toEqual({ status: 502, body: null });
  });
});

describe("createDummyTransport", () => {
  const createDoc = DUMMIES["fixture_notes.create"];
  const listDoc = DUMMIES["fixture_notes.list"];

  it("場面ごとに要素ごとに 1 件ずつ返し、結果の zod に合う", async () => {
    for (const scenario of ["normal", "slow", "empty", "error", "notFound"] as const) {
      const res = await dummyClient(scenario).call("fixture_notes.list", [LIST_ITEM]);
      expect(res.ok, scenario).toBe(true);
      if (!res.ok) continue;
      expect(res.results).toHaveLength(1);
      for (const r of res.results) expect(resultSchemaOf(FIXTURE_LIST).safeParse(r).success).toBe(true);
    }
  });

  it("要素 1 個の normal は 1 件、要素 5 個の normal は見本を順に回して 5 件", async () => {
    const one = await dummyClient("normal").call("fixture_notes.list", [LIST_ITEM]);
    expect(one).toEqual({ ok: true, results: [listDoc?.normal[0]] });
    const five = await dummyClient("normal").call("fixture_notes.list", [LIST_ITEM, LIST_ITEM, LIST_ITEM, LIST_ITEM, LIST_ITEM]);
    const normal = listDoc?.normal ?? [];
    expect(five).toEqual({ ok: true, results: [0, 1, 2, 3, 4].map((i) => normal[i % normal.length]) });
  });

  it("error は理由を順に回し、notFound は 404、list の empty は空の一覧、create の empty は normal と同じ", async () => {
    expect(await dummyClient("error").call("fixture_notes.create", [CREATE_ITEM])).toEqual({ ok: true, results: [createDoc?.failures[0]] });
    expect(await dummyClient("notFound").call("fixture_notes.create", [CREATE_ITEM])).toEqual({
      ok: true,
      results: [{ ok: false, status: 404, reason: "not_found" }],
    });
    const empty = { ok: true, items: [], next_cursor: null };
    expect(await dummyClient("empty").call("fixture_notes.list", [LIST_ITEM, LIST_ITEM])).toEqual({ ok: true, results: [empty, empty] });
    expect(await dummyClient("empty").call("fixture_notes.create", [CREATE_ITEM])).toEqual(await dummyClient("normal").call("fixture_notes.create", [CREATE_ITEM]));
  });

  it("上限ちょうどの要素で件数が要求と同じ", async () => {
    const items = Array.from({ length: MAX_ITEMS }, () => LIST_ITEM) as [typeof LIST_ITEM, ...(typeof LIST_ITEM)[]];
    const res = await dummyClient("normal").call("fixture_notes.list", items);
    expect(res.ok && res.results.length).toBe(MAX_ITEMS);
  });

  it("形の未定の操作と、failures が 0 件の操作の error は要求全体の unavailable の 503", async () => {
    const pending = createOperationClient(createDummyTransport({ "projects.get": null }, () => "normal"), OPERATIONS);
    expect(await pending.call("projects.get", [{} as never])).toEqual({ ok: false, status: 503, reason: "unavailable" });
    const noFailures = { "fixture_notes.list": { ...listDoc, failures: [] } as DummyDoc };
    expect(await dummyClient("error", noFailures).call("fixture_notes.list", [LIST_ITEM])).toEqual({ ok: false, status: 503, reason: "unavailable" });
    const noNormal = { "fixture_notes.list": { ...listDoc, normal: [] } as DummyDoc };
    expect(await dummyClient("normal", noNormal).call("fixture_notes.list", [LIST_ITEM])).toEqual({ ok: false, status: 503, reason: "unavailable" });
  });
});
