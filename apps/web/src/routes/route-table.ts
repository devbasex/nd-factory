import type { MessageKey } from "../i18n/translate.ts";
import { ROUTE_OPERATIONS } from "./route-operations.generated.ts";

// 画面マップの表。ルーター・ナビゲーション・e2e・操作の対応の検査がこの表を読む

export type RouteId = keyof typeof ROUTE_OPERATIONS;
export type RouteGroup = "signin" | "main" | "project" | "team" | "me";
export type NavId = "organizers" | "approvals" | "sprints" | "settings";

export type RouteDef = {
  readonly id: RouteId;
  readonly path: string;
  readonly group: RouteGroup;
  readonly titleKey: MessageKey;
  readonly operations: readonly string[];
  // つながっていないときに、最後に受け取った中身を読めるか
  readonly offline: boolean;
  readonly nav: NavId | null;
};

type Row = [RouteId, string, RouteGroup, string, boolean, NavId | null];

const ROWS: Row[] = [
  ["R1", "/signin", "signin", "signin", false, null],
  ["R2", "/", "main", "organizers", true, "organizers"],
  ["R3", "/p/:projectId", "project", "sprints", true, "sprints"],
  ["R4", "/p/:projectId/start", "project", "sprintStart", false, "sprints"],
  ["R5", "/p/:projectId/sprints/:sprintId", "project", "sprintDetail", true, "sprints"],
  ["R6", "/p/:projectId/approvals/:approvalId", "project", "approvalDetail", true, "approvals"],
  ["R7", "/p/:projectId/questions/:questionId", "project", "question", true, "approvals"],
  ["R8", "/p/:projectId/settings", "project", "projectSettings", false, "settings"],
  ["R9", "/t/:teamId", "team", "team", false, "settings"],
  ["R10", "/t/:teamId/projects/new", "team", "projectNew", false, "settings"],
  ["R11", "/t/:teamId/execution", "team", "execution", false, "settings"],
  ["R12", "/t/:teamId/usage", "team", "usage", false, "settings"],
  ["R13", "/t/:teamId/audit", "team", "audit", false, "settings"],
  ["R14", "/me", "me", "me", true, "settings"],
  ["R15", "/p/:projectId/organizers/:organizerId", "main", "organizerChat", true, "organizers"],
  ["R16", "/approvals", "main", "approvals", true, "approvals"],
];

export const ROUTES: readonly RouteDef[] = ROWS.map(([id, path, group, name, offline, nav]) => ({
  id,
  path,
  group,
  titleKey: `routes.${name}.title` as MessageKey,
  operations: ROUTE_OPERATIONS[id],
  offline,
  nav,
}));

const PATTERNS = ROUTES.map((r) => new RegExp(`^${r.path.replace(/:\w+/g, "[^/]+")}/?$`));

export function isMapPath(pathname: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(pathname));
}

export type ReturnKind = "return:signin" | "return:link" | "return:signout";

// ルーターより先に戻り先を判定する。順は、サインアウト → ログインをつなぐ → サインイン
export function matchReturn(url: URL): ReturnKind | null {
  if (url.pathname === "/signed-out") return "return:signout";
  if (url.pathname === "/me/logins/return") return "return:link";
  if (url.pathname === "/" && url.searchParams.has("code") && url.searchParams.has("state")) return "return:signin";
  return null;
}
