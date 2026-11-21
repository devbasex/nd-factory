import { z } from "zod";
import { ITEM_REASONS, REASON_CODE, type ReasonDef } from "./reasons.ts";
import { MAX_ITEMS } from "./values.ts";

// 操作の定義の型と組み立て。操作の表（operations/*.ts）の行はどれも defineOperation で作る（docs/design/api.md の「形の正本」）

// 要求の本文の要素の数の上限。値の正本は values.ts（itemsArray の既定）で、操作の規約の値としてここからも出す
export { MAX_ITEMS };

// 冪等の鍵の済みの行を残す秒（24 時間）
export const IDEMPOTENCY_TTL_SECONDS = 86400;

export type Endpoint = "user" | "runner" | "machine" | "db_prep";
export type Access = "read" | "write";
export type HumanOnly = "always" | "per_item" | "never";
export type DelegationKind = "read" | "run" | "manage";
export type FeatureId = `F${number}`;
export type IssueNumber = `#${number}`;

// 形の未定。どの値も通さない形と、受け持つ子の番号を持つ
export type PendingShape = { kind: "pending"; owner: string; schema: z.ZodNever };

export type Shape = z.ZodType | PendingShape;

// 成功の要素の結果の封筒。ok を z.literal(true) で持つ strictObject（okItem・okList）で、resultSchemaOf の和を ok で分けられる。
// z.object と z.strictObject は型の上で見分けられないため、strict かは defineOperation（checkResult）が実行の時に照らす
export type SuccessEnvelope = z.ZodObject<{ ok: z.ZodLiteral<true> } & z.core.$ZodShape, z.core.$strict>;

export type ResultShape = SuccessEnvelope | PendingShape;

export type OperationExamples = { normal?: unknown[]; edge?: unknown[] };

// defineOperation へ渡す値。既定を持つ項目は省ける
export type OperationInput<N extends string, I extends Shape, R extends ResultShape> = {
  name: N;
  endpoint?: Endpoint;
  features?: readonly FeatureId[];
  access: Access;
  humanOnly?: HumanOnly;
  mcpRead?: string | null;
  delegationKind?: DelegationKind | null;
  ownerOnly?: boolean;
  allOrNothing?: { maxItems: number } | null;
  idempotencyKey?: boolean;
  item: I;
  result: R;
  reasons?: readonly ReasonDef[];
  auditKeys?: readonly string[];
  order?: string | null;
  examples?: OperationExamples | null;
  description_en?: string;
  owner: IssueNumber;
};

// 操作の定義。項目の並びは生成物の JSON の鍵の順でもある
export type OperationDef<N extends string = string, I extends Shape = Shape, R extends ResultShape = ResultShape> = {
  readonly name: N;
  readonly entity: string;
  readonly verb: string;
  readonly endpoint: Endpoint;
  readonly route: string;
  readonly features: readonly FeatureId[];
  readonly access: Access;
  readonly humanOnly: HumanOnly;
  readonly mcpRead: string | null;
  readonly delegationKind: DelegationKind | null;
  readonly ownerOnly: boolean;
  readonly allOrNothing: { readonly maxItems: number } | null;
  readonly idempotencyKey: boolean;
  readonly item: I;
  readonly result: R;
  readonly reasons: readonly ReasonDef[];
  readonly auditKeys: readonly string[];
  readonly order: string | null;
  readonly examples: OperationExamples | null;
  readonly description_en: string;
  readonly owner: IssueNumber;
};

export class OperationDefinitionError extends Error {
  override name = "OperationDefinitionError";
}

const SEGMENT = "[a-z][a-z0-9_]*";
const USER_NAME = new RegExp(`^${SEGMENT}\\.${SEGMENT}$`);

function splitName(name: string, endpoint: Endpoint): { entity: string; verb: string; route: string } {
  const pattern = endpoint === "user" ? USER_NAME : new RegExp(`^${endpoint}\\.${SEGMENT}\\.${SEGMENT}$`);
  if (!pattern.test(name)) throw new OperationDefinitionError(`操作の名前の形が受け口 ${endpoint} に合わない: ${name}`);
  const parts = name.split(".");
  const entity = parts.at(-2) ?? "";
  const verb = parts.at(-1) ?? "";
  return { entity, verb, route: `/v1/${parts.join("/")}` };
}

function fail(name: string, why: string): never {
  throw new OperationDefinitionError(`${name}: ${why}`);
}

function checkReasons(name: string, reasons: readonly ReasonDef[]): void {
  const common = new Set<string>(ITEM_REASONS.map((r) => r.code));
  const seen = new Set<string>();
  for (const r of reasons) {
    if (!REASON_CODE.test(r.code)) fail(name, `理由のコードの形が違う: ${r.code}`);
    if (r.when !== "always") fail(name, `操作ごとの理由の when は always だけ: ${r.code}`);
    if (common.has(r.code)) fail(name, `共通の理由のコードを書いている: ${r.code}`);
    if (seen.has(r.code)) fail(name, `理由のコードが重なる: ${r.code}`);
    seen.add(r.code);
  }
}

// 失敗の要素だけが持つキー。成功の封筒には置かない
const FAILURE_KEYS = ["status", "reason", "fields"] as const;

// 成功の結果が ok: true の strict な封筒かを照らす。型の制約を as で外した定義も、ここで落とす。
// 封筒のキーは docs/design/api.md の「本文は配列」に合わせる。list の操作は ok・items・next_cursor、ほかは ok・item。
// 受け口 user は封筒をこのキーだけにする。受け口 user でない経路は応答に足す値を文書が持つ（runner の answers.list の delivered_seqs など）ため、
// 決まったキーを必ず持ち、失敗の要素のキーを持たないことだけを照らす
function checkResult(name: string, verb: string, endpoint: Endpoint, result: ResultShape): void {
  if (isPending(result)) return;
  if (!(result instanceof z.ZodObject)) fail(name, "成功の結果は okItem・okList の封筒で書く");
  const shape: Record<string, unknown> = result.shape;
  const ok = shape["ok"];
  if (!(ok instanceof z.ZodLiteral) || ok.values.size !== 1 || !ok.values.has(true)) fail(name, "成功の結果の封筒は ok を z.literal(true) で持つ");
  if (!(result.def.catchall instanceof z.ZodNever)) fail(name, "成功の結果の封筒は strictObject で組む");

  const required = verb === "list" ? ["ok", "items", "next_cursor"] : ["ok", "item"];
  for (const key of required) {
    const field = shape[key];
    if (!(field instanceof z.ZodType) || field.safeParse(undefined).success) fail(name, `成功の結果の封筒は ${key} を必ず持つ`);
  }
  if (verb === "list") {
    if (!(shape["items"] instanceof z.ZodArray)) fail(name, "一覧の成功の結果の items は配列で持つ");
    const cursor = shape["next_cursor"];
    if (!(cursor instanceof z.ZodNullable) || !(cursor.unwrap() instanceof z.ZodString)) fail(name, "一覧の成功の結果の next_cursor は文字列か null で持つ");
  }
  const keys = Object.keys(shape);
  for (const key of FAILURE_KEYS) if (keys.includes(key)) fail(name, `成功の結果の封筒に失敗の要素のキーを置かない: ${key}`);
  if (endpoint === "user") {
    const extra = keys.filter((k) => !required.includes(k));
    if (extra.length > 0) fail(name, `成功の結果の封筒は ${required.join("・")} だけを持つ: ${extra.join("・")}`);
  }
}

// 印を照らし、HTTP の経路と既定の値を足した定義を返す。印が食い違えば投げる（モジュールの読み込みで落ちる）
export function defineOperation<N extends string, I extends Shape, R extends ResultShape>(def: OperationInput<N, I, R>): OperationDef<N, I, R> {
  const endpoint = def.endpoint ?? "user";
  const { entity, verb, route } = splitName(def.name, endpoint);
  const features = def.features ?? [];
  const humanOnly = def.humanOnly ?? "never";
  const mcpRead = def.mcpRead ?? null;
  const delegationKind = def.delegationKind ?? null;
  const allOrNothing = def.allOrNothing ?? null;
  const idempotencyKey = def.idempotencyKey ?? false;
  const order = def.order ?? null;
  const reasons = def.reasons ?? [];

  if (endpoint === "user" && features.length === 0) fail(def.name, "受け口 user の操作は機能を 1 つ以上持つ");
  if (endpoint !== "user" && features.length > 0) fail(def.name, "受け口 user でない操作は機能を持たない");
  if (def.access === "read" && idempotencyKey) fail(def.name, "読む操作は冪等の鍵を持たない");
  if (def.access === "read" && allOrNothing !== null) fail(def.name, "読む操作は全部か無かを持たない");
  if (allOrNothing !== null) {
    const max = allOrNothing.maxItems;
    if (!Number.isInteger(max) || max < 1 || max > MAX_ITEMS) fail(def.name, `全部か無かの上限は 1〜${MAX_ITEMS} の整数: ${max}`);
  }
  if (humanOnly === "always" && mcpRead === null) fail(def.name, "人だけの操作は読み出しの道具を持つ");
  if (humanOnly === "never" && mcpRead !== null) fail(def.name, "人だけでない操作は読み出しの道具を持たない");
  const needsDelegation = endpoint === "user" && humanOnly !== "always";
  if (needsDelegation && delegationKind === null) fail(def.name, "委任から呼べる操作は委任の種類を持つ");
  if (!needsDelegation && delegationKind !== null) fail(def.name, "委任から呼べない操作は委任の種類を持たない");
  if (verb !== "list" && order !== null) fail(def.name, "並びは list の操作だけが持つ");
  checkReasons(def.name, reasons);
  checkResult(def.name, verb, endpoint, def.result);

  return {
    name: def.name,
    entity,
    verb,
    endpoint,
    route,
    features,
    access: def.access,
    humanOnly,
    mcpRead,
    delegationKind,
    ownerOnly: def.ownerOnly ?? false,
    allOrNothing,
    idempotencyKey,
    item: def.item,
    result: def.result,
    reasons,
    auditKeys: def.auditKeys ?? [],
    order,
    examples: def.examples ?? null,
    description_en: def.description_en ?? `${verb} ${entity}`,
    owner: def.owner,
  };
}

// どの値も通さない形と、受け持つ子の番号
export function pendingShape(owner: IssueNumber): PendingShape {
  return { kind: "pending", owner, schema: z.never() };
}

export function isPending(shape: z.ZodType | PendingShape): shape is PendingShape {
  return !(shape instanceof z.ZodType) && shape.kind === "pending";
}

// 成功の要素の結果の封筒。strictObject で組み、封筒の余分なキー（reason など）を拒む
export function okItem<R extends z.ZodType>(item: R): z.ZodObject<{ ok: z.ZodLiteral<true>; item: R }, z.core.$strict> {
  return z.strictObject({ ok: z.literal(true), item });
}

export function okList<R extends z.ZodType>(
  item: R,
): z.ZodObject<{ ok: z.ZodLiteral<true>; items: z.ZodArray<R>; next_cursor: z.ZodNullable<z.ZodString> }, z.core.$strict> {
  return z.strictObject({ ok: z.literal(true), items: z.array(item), next_cursor: z.string().nullable() });
}

// 理由 1 つの失敗の要素の結果。status と reason を z.literal で縛る
export type FailureBranch<D extends ReasonDef> = z.ZodObject<
  {
    ok: z.ZodLiteral<false>;
    status: z.ZodLiteral<D["status"]>;
    reason: z.ZodLiteral<D["code"]>;
    fields: z.ZodOptional<z.ZodArray<z.ZodString>>;
  },
  z.core.$strict
>;

export type ItemFailureSchema<RS extends readonly [ReasonDef, ...ReasonDef[]]> = z.ZodDiscriminatedUnion<
  { -readonly [K in keyof RS]: FailureBranch<RS[K]> },
  "reason"
>;

// 理由ごとのオブジェクトを、reason を判別の鍵にした和にする
export function itemFailure<const RS extends readonly [ReasonDef, ...ReasonDef[]]>(reasons: RS): ItemFailureSchema<RS> {
  const branches = reasons.map((r) =>
    z.strictObject({
      ok: z.literal(false),
      status: z.literal(r.status),
      reason: z.literal(r.code),
      fields: z.array(z.string()).optional(),
    }),
  );
  const [first, ...rest] = branches;
  if (first === undefined) throw new OperationDefinitionError("失敗の要素の理由が空");
  return z.discriminatedUnion("reason", [first, ...rest]) as unknown as ItemFailureSchema<RS>;
}

// その操作で起きうる要素の理由。ITEM_REASONS のうち空にならない always の 3 つを必ず含む。
// 意図した妥協: 型引数 _Op は使わず、要素を ReasonDef に広げる。このため ResultOf の失敗の側の reason は string になり、
// 呼び手は reason のリテラルで絞り込めない。理由ごとの status と reason の組は、itemFailure が実行の時に作る zod の和が縛る。
// 型引数は、操作ごとの理由をリテラルで残す形へ後で絞っても呼び手の書き方が変わらないように置いている（issues/issue-2-design-detail.md の ReasonsOf の行）
export type ReasonsOf<_Op extends OperationDef = OperationDef> = readonly [ReasonDef, ...ReasonDef[]];

export function itemReasonsOf<Op extends OperationDef>(op: Op): ReasonsOf<Op> {
  const applies = (r: ReasonDef): boolean => {
    switch (r.when) {
      case "always":
        return true;
      case "write":
        return op.access === "write";
      case "idempotency":
        return op.idempotencyKey;
      case "all_or_nothing":
        return op.allOrNothing !== null;
      case "human_only_per_item":
        return op.humanOnly === "per_item";
    }
  };
  const [first, ...rest] = [...ITEM_REASONS.filter(applies), ...op.reasons];
  if (first === undefined) throw new OperationDefinitionError(`${op.name}: 要素の理由が空`);
  return [first, ...rest];
}

// 結果の和の成功の選択肢。形の未定は外す
export type ResultShapeOf<Op extends OperationDef> = Exclude<Op["result"], PendingShape>;

export type ResultSchemaOf<Op extends OperationDef> = z.ZodDiscriminatedUnion<[ResultShapeOf<Op>, ItemFailureSchema<ReasonsOf<Op>>], "ok">;

// その操作の要素の結果の zod。成功と失敗を ok で分け、失敗の側は itemFailure の和を 1 つの要素として入れる
export function resultSchemaOf<Op extends OperationDef>(op: Op): ResultSchemaOf<Op> {
  const result = op.result;
  if (isPending(result)) throw new OperationDefinitionError(`${op.name}: 結果の形が未定（${result.owner}）`);
  const failure = itemFailure(itemReasonsOf(op));
  // 成功の側は ok を z.literal(true) で持つ封筒だけが来る（型の SuccessEnvelope と defineOperation の checkResult が縛る）。型の上の和は宣言の ResultSchemaOf で出す
  const options = [result, failure] as unknown as readonly [z.core.$ZodTypeDiscriminable, z.core.$ZodTypeDiscriminable];
  return z.discriminatedUnion("ok", options) as unknown as ResultSchemaOf<Op>;
}

// 要素の型と要素の結果の型
export type ItemOf<Op extends OperationDef> = Op["item"] extends z.ZodType ? z.infer<Op["item"]> : never;
export type ResultOf<Op extends OperationDef> = z.infer<ResultSchemaOf<Op>>;
