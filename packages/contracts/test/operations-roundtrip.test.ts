import { faker } from "@faker-js/faker";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fake, seed, setFaker } from "zod-schema-faker/v4";
import { buildDummy, buildOpenApi, buildOperationSchemas, examplesOf } from "../scripts/artifacts.ts";
import { UUID_V7_PATTERN } from "../src/ids.ts";
import { defineOperation, isPending, MAX_ITEMS, okItem, type OperationDef, resultSchemaOf } from "../src/operation.ts";
import { OPERATIONS } from "../src/operations/index.ts";
import { itemsArray, UTC_DATE_TIME } from "../src/values.ts";
import { FIXTURE_OPERATIONS } from "./fixtures/operations.ts";

// 形の往復（受け入れ条件 7）。操作ごとに見本と反例を、zod と生成した JSON Schema（Ajv 2020）の両方で検証し、合否を比べる

const ITEM_SAMPLES = 3;
const PREFIXED_ID = new RegExp(`^[a-z]+_${UUID_V7_PATTERN}$`);

type Case = { label: string; value: unknown };
type Comparison = { items: number; openApiItems: number; successes: number; failures: number; mismatches: string[] };

function sampleItems(op: OperationDef & { item: z.ZodType }): unknown[] {
  setFaker(faker);
  seed(ITEM_SAMPLES);
  return Array.from({ length: ITEM_SAMPLES }, () => fake(op.item));
}

// 見本の中の値を 1 か所ずつ壊した反例（時刻帯の無い日時・通貨の無い金額・頭の違う ID）
function brokenCopies(value: unknown, path = "$"): Case[] {
  if (typeof value === "string") {
    if (UTC_DATE_TIME.test(value)) return [{ label: `${path} 時刻帯の無い日時`, value: value.replace(/Z$/, "") }];
    if (PREFIXED_ID.test(value)) return [{ label: `${path} 頭の違う ID`, value: value.replace(/^[a-z]+_/, "zzz_") }];
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => brokenCopies(v, `${path}[${i}]`).map((c) => ({ ...c, value: value.map((w, j) => (j === i ? c.value : w)) })));
  }
  if (value === null || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const out: Case[] = [];
  if ("amount_minor" in obj && "currency" in obj) {
    const { currency: _drop, ...rest } = obj;
    out.push({ label: `${path} 通貨の無い金額`, value: rest });
  }
  for (const [k, v] of Object.entries(obj)) {
    for (const c of brokenCopies(v, `${path}.${k}`)) out.push({ ...c, value: { ...obj, [k]: c.value } });
  }
  return out;
}

function compare(ops: readonly OperationDef[]): Comparison {
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  ajv.addSchema(buildOperationSchemas(ops), "ops");
  // openapi.json の components.schemas の要素の形。受け口 user の操作だけが載る。
  // 要素の中の $ref は文書の根からの "#/components/schemas/…" のため、components を持つ文書として足す
  const openApi = new Ajv2020({ strict: false, validateFormats: false });
  openApi.addSchema({ components: buildOpenApi(ops).components ?? {} }, "openapi");
  const result: Comparison = { items: 0, openApiItems: 0, successes: 0, failures: 0, mismatches: [] };
  const check = (name: string, zod: z.ZodType, ajvSchema: object | string, cases: Case[]): number => {
    const validate = typeof ajvSchema === "string" ? ajv.getSchema(ajvSchema) : ajv.compile(ajvSchema);
    if (validate === undefined) throw new Error(`JSON Schema が無い: ${String(ajvSchema)}`);
    for (const c of cases) {
      const byZod = zod.safeParse(c.value).success;
      const byAjv = validate(c.value) === true;
      if (byZod !== byAjv) result.mismatches.push(`${name} ${c.label}: zod=${byZod} ajv=${byAjv}`);
    }
    return cases.length;
  };

  for (const op of ops) {
    if (isPending(op.item) || isPending(op.result)) continue;
    const max = op.allOrNothing?.maxItems ?? MAX_ITEMS;
    const items = sampleItems(op as OperationDef & { item: z.ZodType });
    const first = items[0];
    const extra = first !== null && typeof first === "object" ? [{ label: "追加の項目", value: { ...first, extra_key: 1 } }] : [];
    const itemCases: Case[] = [...items.map((value, i) => ({ label: `見本 ${i}`, value })), ...items.flatMap((v) => brokenCopies(v)), ...extra];
    result.items += check(op.name, op.item, `ops#/$defs/${op.name}.item`, itemCases);
    if (op.endpoint === "user") {
      const validate = openApi.getSchema(`openapi#/components/schemas/${op.name}.item`);
      if (validate === undefined) throw new Error(`OpenAPI の要素の形が無い: ${op.name}`);
      for (const c of itemCases) {
        const byZod = op.item.safeParse(c.value).success;
        const byOpenApi = validate(c.value) === true;
        if (byZod !== byOpenApi) result.mismatches.push(`${op.name} ${c.label}: zod=${byZod} openapi=${byOpenApi}`);
      }
      result.openApiItems += itemCases.length;
    }

    const body = { type: "array", minItems: 1, maxItems: max, items: { $ref: `ops#/$defs/${op.name}.item` } };
    check(op.name, itemsArray(op.item, max), body, [
      { label: "要素 1 個の配列", value: [first] },
      { label: "上限ちょうどの配列", value: Array.from({ length: max }, () => first) },
      { label: "上限を越える配列", value: Array.from({ length: max + 1 }, () => first) },
      { label: "配列でない本文", value: first },
      { label: "空の配列", value: [] },
    ]);

    const schema = resultSchemaOf(op);
    const ref = `ops#/$defs/${op.name}.result`;
    const { normal, edge } = examplesOf(op);
    result.successes += check(op.name, schema, ref, [...normal, ...edge].map((value, i) => ({ label: `成功 ${i}`, value })));

    const failures = buildDummy(op)?.failures ?? [];
    const swapped = failures.map((f) => ({ label: `${f.reason} の状態の組み替え`, value: { ...f, status: f.status === 409 ? 404 : 409 } }));
    result.failures += check(op.name, schema, ref, [
      ...failures.map((value) => ({ label: value.reason, value })),
      ...swapped,
      { label: "ReasonDef に無い理由", value: { ok: false, status: 400, reason: "no_such_reason" } },
    ]);
  }
  return result;
}

describe("形の往復", () => {
  it("形のある操作とテスト用の操作で、zod と JSON Schema の合否が同じ", () => {
    const shaped = OPERATIONS.filter((op) => !isPending(op.item) && !isPending(op.result));
    const result = compare([...shaped, ...FIXTURE_OPERATIONS]);
    expect(result.mismatches).toEqual([]);
    expect(result.items).toBeGreaterThan(0);
    expect(result.openApiItems).toBeGreaterThan(0);
    expect(result.successes).toBeGreaterThan(0);
    expect(result.failures).toBeGreaterThan(0);
  });

  it("反例は時刻帯の無い日時・通貨の無い金額・頭の違う ID を含む", () => {
    const [create] = FIXTURE_OPERATIONS;
    const labels = sampleItems(create)
      .flatMap((v) => brokenCopies(v))
      .map((c) => c.label);
    expect(labels.some((l) => l.endsWith("時刻帯の無い日時"))).toBe(true);
    expect(labels.some((l) => l.endsWith("通貨の無い金額"))).toBe(true);
    expect(labels.some((l) => l.endsWith("頭の違う ID"))).toBe(true);
  });

  it("refine を使う形を足すと食い違いを検出する", () => {
    const even = z.int().refine((v) => v % 2 === 0);
    const op = defineOperation({
      name: "fixture_counts.update",
      features: ["F1"],
      access: "write",
      delegationKind: "run",
      item: z.strictObject({ n: even }),
      result: okItem(z.strictObject({ n: even })),
      examples: { normal: [{ ok: true, item: { n: 3 } }], edge: [] },
      owner: "#2",
    });
    expect(compare([op]).mismatches.length).toBeGreaterThan(0);
  });
});
