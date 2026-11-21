import type { DelegationKind } from "@nd-factory/contracts/operation";
import type { Id } from "../ids.ts";

// 要求の主体（docs/design/api.md の「認証と主体」）。認可の判定（authorize）と操作の記録（audit）が読む。
// 主体を決める authenticate は Task 10 でこのファイルに足す

export type Principal =
  | { readonly kind: "human"; readonly userId: Id<"usr"> }
  | {
      readonly kind: "delegation";
      readonly userId: Id<"usr">;
      readonly delegationId: Id<"dlg">;
      readonly scope: { readonly projectIds: readonly Id<"prj">[]; readonly operations: DelegationKind };
      readonly clientName: string;
    }
  | { readonly kind: "runner"; readonly laneId: Id<"lane">; readonly projectId: Id<"prj">; readonly generation: number }
  | { readonly kind: "machine"; readonly teamId: Id<"team">; readonly machineId: Id<"mch"> }
  | { readonly kind: "github" }
  | { readonly kind: "db_prep"; readonly projectId: Id<"prj">; readonly prepId: string }
  | { readonly kind: "patrol" };

export type AuthResult = { readonly ok: true; readonly principal: Principal } | { readonly ok: false; readonly reason: "unauthorized" | "unavailable" };
