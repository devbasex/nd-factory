import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { idOf } from "../src/ids.ts";
import {
  defineOperation,
  IDEMPOTENCY_TTL_SECONDS,
  isPending,
  itemFailure,
  itemReasonsOf,
  MAX_ITEMS,
  okItem,
  okList,
  OperationDefinitionError,
  type OperationInput,
  pendingShape,
  type ResultOf,
  type ResultShape,
  resultSchemaOf,
  type Shape,
} from "../src/operation.ts";
import type { ReasonDef } from "../src/reasons.ts";
import { utcDateTime } from "../src/values.ts";

const UUID_V7 = "01935b4e-7c2a-7d10-8f3e-2b6f0c9a1d42";
const SPRINT_ID = `spr_${UUID_V7}`;

const sprint = z.strictObject({ sprint_id: idOf("spr"), created_at: utcDateTime });

const SPRINT = { sprint_id: SPRINT_ID, created_at: "2026-11-17T03:04:05.123Z" };

function base(over: Partial<OperationInput<string, Shape, ResultShape>> = {}): OperationInput<string, Shape, ResultShape> {
  return {
    name: "sprints.get",
    features: ["F8"],
    access: "read",
    delegationKind: "read",
    item: z.strictObject({ sprint_id: idOf("spr") }),
    result: okItem(sprint),
    owner: "#6",
    ...over,
  };
}

function passes(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

describe("defineOperation", () => {
  it("経路と既定の値を名前から作る", () => {
    const op = defineOperation(base());
    expect(op.entity).toBe("sprints");
    expect(op.verb).toBe("get");
    expect(op.endpoint).toBe("user");
    expect(op.route).toBe("/v1/sprints/get");
    expect(op.humanOnly).toBe("never");
    expect(op.mcpRead).toBeNull();
    expect(op.ownerOnly).toBe(false);
    expect(op.allOrNothing).toBeNull();
    expect(op.idempotencyKey).toBe(false);
    expect(op.reasons).toEqual([]);
    expect(op.auditKeys).toEqual([]);
    expect(op.order).toBeNull();
    expect(op.examples).toBeNull();
    expect(op.description_en).toBe("get sprints");
    expect(op.owner).toBe("#6");
  });

  it("項目の並びは決まった順", () => {
    expect(Object.keys(defineOperation(base()))).toEqual([
      "name",
      "entity",
      "verb",
      "endpoint",
      "route",
      "features",
      "access",
      "humanOnly",
      "mcpRead",
      "delegationKind",
      "ownerOnly",
      "allOrNothing",
      "idempotencyKey",
      "item",
      "result",
      "reasons",
      "auditKeys",
      "order",
      "examples",
      "description_en",
      "owner",
    ]);
  });

  it("受け口 runner の経路は /v1/runner/…", () => {
    const op = defineOperation(base({ name: "runner.events.create", endpoint: "runner", features: [], access: "write", delegationKind: null }));
    expect(op.route).toBe("/v1/runner/events/create");
    expect(op.entity).toBe("events");
    expect(op.verb).toBe("create");
  });

  it("全部か無かの上限は 1 から置ける", () => {
    const op = defineOperation(base({ name: "projects.create", access: "write", delegationKind: "manage", allOrNothing: { maxItems: 1 } }));
    expect(op.allOrNothing).toEqual({ maxItems: 1 });
  });

  it("人だけの操作は読み出しの道具を持ち、委任の種類を持たない", () => {
    const op = defineOperation(base({ name: "machines.create", access: "write", humanOnly: "always", mcpRead: "machines.list", delegationKind: null }));
    expect(op.mcpRead).toBe("machines.list");
    expect(op.delegationKind).toBeNull();
  });

  it.each<[string, Partial<OperationInput<string, Shape, ResultShape>>]>([
    ["読む操作に冪等の鍵", { idempotencyKey: true }],
    ["読む操作に全部か無か", { allOrNothing: { maxItems: 10 } }],
    ["全部か無かの上限が 0", { access: "write", allOrNothing: { maxItems: 0 } }],
    ["全部か無かの上限が 101", { access: "write", allOrNothing: { maxItems: MAX_ITEMS + 1 } }],
    ["人だけの操作に読み出しの道具が無い", { humanOnly: "always", delegationKind: null }],
    ["人だけでない操作に読み出しの道具", { mcpRead: "sprints.list" }],
    ["委任から呼べる操作に委任の種類が無い", { delegationKind: null }],
    ["人だけの操作に委任の種類", { humanOnly: "always", mcpRead: "sprints.list" }],
    ["受け口 user で機能が無い", { features: [] }],
    ["受け口 runner に機能", { name: "runner.events.create", endpoint: "runner", delegationKind: null }],
    ["受け口 runner に委任の種類", { name: "runner.events.create", endpoint: "runner", features: [] }],
    ["名前に大文字", { name: "Sprints.get" }],
    ["名前の区切りが 3 つ", { name: "sprints.lanes.get" }],
    ["受け口 runner の名前の頭が違う", { name: "machine.events.create", endpoint: "runner", features: [], delegationKind: null }],
    ["list でない操作に並び", { order: "created_at の古い順" }],
    ["共通の理由のコードを書く", { reasons: [{ code: "not_found", status: 404, when: "always" }] }],
    ["理由のコードの形が違う", { reasons: [{ code: "Bad-Code", status: 409, when: "always" }] }],
    ["操作ごとの理由の when が always でない", { reasons: [{ code: "sprint_closed", status: 409, when: "write" }] }],
    [
      "操作ごとの理由のコードが重なる",
      {
        reasons: [
          { code: "sprint_closed", status: 409, when: "always" },
          { code: "sprint_closed", status: 409, when: "always" },
        ],
      },
    ],
  ])("%s で投げる", (_why, over) => {
    expect(() => defineOperation(base(over))).toThrow(OperationDefinitionError);
  });

  it("成功の結果に ok: true の封筒でない形を型で拒む", () => {
    // @ts-expect-error ok を持たない形は成功の結果にならない
    base({ result: z.string() });
    // @ts-expect-error ok: false の封筒は成功の結果にならない
    base({ result: z.strictObject({ ok: z.literal(false), item: sprint }) });
    // z.object と z.strictObject は型の上で見分けられないため、strict かは defineOperation が実行の時に照らす（下のテスト）
  });

  it.each<[string, z.ZodType]>([
    ["ok を持たない形", z.string()],
    ["ok を持たないオブジェクト", z.strictObject({ item: sprint })],
    ["ok が false", z.strictObject({ ok: z.literal(false), item: sprint })],
    ["ok が真偽値", z.strictObject({ ok: z.boolean(), item: sprint })],
    ["余分なキーを落とす z.object", z.object({ ok: z.literal(true), item: sprint })],
  ])("型を外して渡した成功の結果が %s なら投げる", (_why, result) => {
    expect(() => defineOperation(base({ result: result as unknown as ResultShape }))).toThrow(OperationDefinitionError);
  });
});

describe("pendingShape", () => {
  it("形の未定と受け持つ子を持ち、どの値も通さない", () => {
    const shape = pendingShape("#4");
    expect(isPending(shape)).toBe(true);
    expect(shape.owner).toBe("#4");
    for (const value of [null, undefined, 0, "", {}, [], { ok: true }]) expect(passes(shape.schema, value)).toBe(false);
  });

  it("zod の形は形の未定でない", () => {
    expect(isPending(z.string())).toBe(false);
    expect(isPending(okItem(sprint))).toBe(false);
  });
});

describe("okItem・okList", () => {
  it("成功の封筒を通す", () => {
    expect(passes(okItem(sprint), { ok: true, item: SPRINT })).toBe(true);
    expect(passes(okList(sprint), { ok: true, items: [SPRINT], next_cursor: null })).toBe(true);
    expect(passes(okList(sprint), { ok: true, items: [], next_cursor: "c1" })).toBe(true);
  });

  it("封筒の余分なキーを拒む", () => {
    expect(passes(okItem(sprint), { ok: true, item: SPRINT, reason: "not_found" })).toBe(false);
    expect(passes(okList(sprint), { ok: true, items: [SPRINT], next_cursor: null, reason: "not_found" })).toBe(false);
  });

  it("一覧は next_cursor を必ず持つ", () => {
    expect(passes(okList(sprint), { ok: true, items: [SPRINT] })).toBe(false);
  });
});

describe("itemFailure", () => {
  const reasons = [
    { code: "not_found", status: 404, when: "always" },
    { code: "version_mismatch", status: 409, when: "write" },
    { code: "sprint_closed", status: 409, when: "always" },
  ] as const satisfies readonly ReasonDef[];

  it("理由ごとの失敗を通し、位置を足せる", () => {
    const schema = itemFailure(reasons);
    expect(passes(schema, { ok: false, status: 404, reason: "not_found" })).toBe(true);
    expect(passes(schema, { ok: false, status: 409, reason: "version_mismatch" })).toBe(true);
    expect(passes(schema, { ok: false, status: 409, reason: "sprint_closed", fields: ["/0/title"] })).toBe(true);
  });

  it("理由が 1 つでも組める", () => {
    const schema = itemFailure([{ code: "not_found", status: 404, when: "always" }]);
    expect(passes(schema, { ok: false, status: 404, reason: "not_found" })).toBe(true);
    expect(passes(schema, { ok: false, status: 409, reason: "not_found" })).toBe(false);
  });

  it.each([
    { ok: false, status: 409, reason: "not_found" },
    { ok: false, status: 404, reason: "gone" },
    { ok: true, status: 404, reason: "not_found" },
    { ok: false, reason: "not_found" },
    { ok: false, status: 404, reason: "not_found", item: SPRINT },
  ])("理由と状態の組み替え・無い理由を拒む（%j）", (value) => {
    expect(passes(itemFailure(reasons), value)).toBe(false);
  });
});

describe("itemReasonsOf", () => {
  it("読む操作は always の 3 つと操作ごとの理由", () => {
    const op = defineOperation(base({ reasons: [{ code: "sprint_closed", status: 409, when: "always" }] }));
    expect(itemReasonsOf(op).map((r) => r.code)).toEqual(["item_invalid", "not_found", "role_insufficient", "sprint_closed"]);
  });

  it("操作の印に当たる共通の理由を合わせる", () => {
    const op = defineOperation(
      base({
        name: "projects.create",
        access: "write",
        humanOnly: "per_item",
        mcpRead: "projects.list",
        delegationKind: "manage",
        idempotencyKey: true,
        allOrNothing: { maxItems: 20 },
      }),
    );
    expect(itemReasonsOf(op).map((r) => r.code)).toEqual([
      "item_invalid",
      "not_found",
      "role_insufficient",
      "human_only",
      "version_mismatch",
      "state_mismatch",
      "idempotency_key_reused",
      "in_progress",
      "not_applied",
    ]);
  });
});

describe("resultSchemaOf", () => {
  const op = defineOperation({
    name: "sprints.cancel",
    features: ["F9"],
    access: "write",
    delegationKind: "run",
    item: z.strictObject({ sprint_id: idOf("spr") }),
    result: okItem(sprint),
    reasons: [{ code: "sprint_closed", status: 409, when: "always" }],
    owner: "#6",
  });
  const schema = resultSchemaOf(op);

  it("成功の結果と各理由の失敗をどちらも通す", () => {
    expect(passes(schema, { ok: true, item: SPRINT })).toBe(true);
    for (const r of itemReasonsOf(op)) expect(passes(schema, { ok: false, status: r.status, reason: r.code })).toBe(true);
  });

  it.each([
    { ok: false, status: 409, reason: "not_found" },
    { ok: false, status: 409, reason: "idempotency_key_reused" },
    { ok: false, status: 404, reason: "gone" },
    { ok: true, item: SPRINT, reason: "not_found" },
    { ok: true, item: { sprint_id: SPRINT_ID } },
    { ok: true },
  ])("拒む（%j）", (value) => {
    expect(passes(schema, value)).toBe(false);
  });

  it("一覧の封筒でも ok: true に理由を持つ値を拒む", () => {
    const list = resultSchemaOf(defineOperation(base({ name: "sprints.list", result: okList(sprint) })));
    expect(passes(list, { ok: true, items: [SPRINT], next_cursor: null })).toBe(true);
    expect(passes(list, { ok: true, items: [SPRINT], next_cursor: null, reason: "not_found" })).toBe(false);
  });

  it("結果の形が未定なら投げる", () => {
    const pending = defineOperation(base({ result: pendingShape("#6") }));
    expect(() => resultSchemaOf(pending)).toThrow(OperationDefinitionError);
  });

  it("ResultOf の成功の側は okItem に渡した要素の型で、形の未定が和に入らない", () => {
    type Result = ResultOf<typeof op>;
    expectTypeOf<Extract<Result, { ok: true }>>().toEqualTypeOf<{ ok: true; item: z.infer<typeof sprint> }>();
    expectTypeOf<Extract<Result, { ok: false }>["reason"]>().toEqualTypeOf<string>();
    expectTypeOf<Extract<Result, { kind: "pending" }>>().toBeNever();
  });
});

describe("操作の規約の値", () => {
  it("要素の上限と冪等の鍵の期限", () => {
    expect(MAX_ITEMS).toBe(100);
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(86400);
  });
});
