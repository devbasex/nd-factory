import {
  type Access,
  defineOperation,
  type DelegationKind,
  type Endpoint,
  type FeatureId,
  type IssueNumber,
  type OperationDef,
  type OperationInput,
  pendingShape,
  type PendingShape,
} from "../operation.ts";

// 操作の表の行の印の組。印は docs/design/api.md の操作の一覧から写す。
// 要素と結果の形はどれも受け持つ子が置き換えるまで形の未定にする（設計の決定 1）

export type PendingOperation<N extends string> = OperationDef<N, PendingShape, PendingShape>;

type Marks = Omit<OperationInput<string, PendingShape, PendingShape>, "name" | "item" | "result" | "owner">;

// 表の列の外から足す印（席の役割ごとの操作・冪等の鍵・全部か無か・要素ごとの人だけ）
export type ExtraMarks = Pick<Marks, "ownerOnly" | "idempotencyKey" | "allOrNothing" | "humanOnly">;

export const IDEMPOTENT = { idempotencyKey: true } as const satisfies ExtraMarks;
export const OWNER_ONLY = { ownerOnly: true } as const satisfies ExtraMarks;
export const OWNER_ONLY_IDEMPOTENT = { ...OWNER_ONLY, ...IDEMPOTENT } as const satisfies ExtraMarks;

// 受け持つ子ごとの行の作り手。どの行も形の未定の要素と結果を持つ
export function ownedBy(owner: IssueNumber) {
  const pending = <N extends string>(name: N, marks: Marks): PendingOperation<N> =>
    defineOperation({ name, ...marks, item: pendingShape(owner), result: pendingShape(owner), owner });

  return {
    // 道具で、委任の read から呼べる読む操作
    read: <const N extends string>(name: N, features: readonly FeatureId[]): PendingOperation<N> =>
      pending(name, { features, access: "read", delegationKind: "read" }),
    // 道具で、括弧の委任の種類から呼べる書く操作
    write: <const N extends string>(name: N, features: readonly FeatureId[], kind: DelegationKind, extra: ExtraMarks = {}): PendingOperation<N> =>
      pending(name, { features, access: "write", delegationKind: kind, ...extra }),
    // 人だけの書く操作。MCP では対になる読み出しの道具（mcpRead）だけを持つ
    human: <const N extends string>(name: N, features: readonly FeatureId[], mcpRead: string, extra: ExtraMarks = {}): PendingOperation<N> =>
      pending(name, { features, access: "write", humanOnly: "always", mcpRead, ...extra }),
    // ランナー・手元のマシン向けの HTTP のルート
    self: <const N extends string>(endpoint: Exclude<Endpoint, "user">, name: N, access: Access): PendingOperation<N> =>
      pending(name, { endpoint, access }),
  };
}
