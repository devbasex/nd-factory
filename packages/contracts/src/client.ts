import { z } from "zod";
import { isPending, type ItemOf, type OperationDef, type ResultOf, resultSchemaOf } from "./operation.ts";
import { OPERATIONS } from "./operations/index.ts";
import { requestProblemOf } from "./reasons.ts";

// 画面とテストが操作を呼ぶ口と、生成したダミーを返す送り手（設計の決定 16）。
// 画面の外のコードのため、zod と操作の表だけを読み、React・DOM・node: の組み込みを import しない

export type Transport = (op: OperationDef, items: readonly unknown[]) => Promise<{ status: number; body: unknown }>;

export type DummyScenario = "normal" | "empty" | "error" | "slow" | "notFound";

export type DummyFailure = { ok: false; status: number; reason: string };

// generated/dummy/<操作>.json の形。normal と failures は送り手が要素ごとに 1 件を選ぶ元の並び
export type DummyDoc = {
  operation: string;
  normal: unknown[];
  empty: unknown;
  edge: unknown[];
  failures: DummyFailure[];
};

export type RequestFailure = { ok: false; status: number; reason: string };

export type CallResult<Op extends OperationDef> = { ok: true; results: ResultOf<Op>[] } | RequestFailure;

type OpNamed<Ops extends readonly OperationDef[], N> = Extract<Ops[number], { name: N }>;

export type OperationClient<Ops extends readonly OperationDef[]> = {
  call<N extends Ops[number]["name"]>(
    name: N,
    items: readonly [ItemOf<OpNamed<Ops, N>>, ...ItemOf<OpNamed<Ops, N>>[]],
  ): Promise<CallResult<OpNamed<Ops, N>>>;
};

// 応答が結果の形に合わないとき。status 0 は HTTP の状態でなく呼び出しの口の判定であることを示す
const RESPONSE_INVALID: RequestFailure = { ok: false, status: 0, reason: "response_invalid" };

// 要素の配列を送り、応答を結果の zod で検証して型つきで返す。応答の誤りは値で返し、例外を投げない。
// 表は既定で操作の表で、テストは同じ defineOperation で組んだ操作の表を渡せる
export function createOperationClient<const Ops extends readonly OperationDef[] = typeof OPERATIONS>(
  transport: Transport,
  ops: Ops = OPERATIONS as unknown as Ops,
): OperationClient<Ops> {
  const byName = new Map<string, OperationDef>(ops.map((op) => [op.name, op]));
  return {
    async call(name, items) {
      const op = byName.get(name);
      if (op === undefined) throw new TypeError(`操作の表に無い操作: ${name}`);
      const res = await transport(op, items);
      if (res.status !== 200) {
        // 要求全体の誤りは、生成物と同じ problem の形で、本文の status が HTTP の状態と同じで、理由の表の組のときだけ受ける。
        // それ以外（中継が返した 502 の本文など）は API が返した正規の失敗とみなさない
        const problem = requestProblemOf(res.status, res.body);
        return problem === null ? RESPONSE_INVALID : { ok: false, status: res.status, reason: problem.reason };
      }
      if (isPending(op.result) || !Array.isArray(res.body) || res.body.length !== items.length) return RESPONSE_INVALID;
      const parsed = z.array(resultSchemaOf(op)).safeParse(res.body);
      return parsed.success ? { ok: true, results: parsed.data as never } : RESPONSE_INVALID;
    },
  };
}

// POST <baseUrl>/v1/... に Authorization: Bearer と JSON の本文で送る。fetch は呼び手が渡す
export function httpTransport(opts: { baseUrl: string; fetch: typeof fetch; token: () => Promise<string | null> }): Transport {
  return async (op, items) => {
    const token = await opts.token();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const res = await opts.fetch(`${opts.baseUrl}${op.route}`, { method: "POST", headers, body: JSON.stringify(items) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // JSON でない本文は null として渡し、呼び出しの口が response_invalid にする
    }
    return { status: res.status, body };
  };
}

const UNAVAILABLE = { status: 503, body: { type: "about:blank", status: 503, reason: "unavailable" } } as const;
const NOT_FOUND = { ok: false, status: 404, reason: "not_found" } as const;

// 生成したダミーから、要求の各要素に結果を 1 件ずつ組んで返す。scenario は要求ごとに読む
export function createDummyTransport<N extends string>(dummies: Readonly<Record<N, DummyDoc | null>>, scenario: () => DummyScenario): Transport {
  const table = dummies as Readonly<Record<string, DummyDoc | null | undefined>>;
  return async (op, items) => {
    const doc = table[op.name] ?? null;
    if (doc === null) return UNAVAILABLE;
    const pool = (s: DummyScenario): readonly unknown[] => {
      switch (s) {
        case "normal":
        case "slow":
          return doc.normal;
        case "empty":
          return doc.empty === null ? doc.normal : [doc.empty];
        case "error":
          return doc.failures;
        case "notFound":
          return [NOT_FOUND];
      }
    };
    const from = pool(scenario());
    if (from.length === 0) return UNAVAILABLE;
    return { status: 200, body: items.map((_, i) => from[i % from.length]) };
  };
}
