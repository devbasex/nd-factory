import type { ReactNode } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { type RouteDef, ROUTES } from "./route-table.ts";

// 画面マップの表の行からルートを作る。表に無い path は、履歴を置き換えて / へ移す

export type ScreenFactory = (route: RouteDef) => ReactNode;

type Create = (routes: RouteObject[]) => ReturnType<typeof createBrowserRouter>;

export function createAppRouter(screens: ScreenFactory, create: Create = createBrowserRouter) {
  return create([
    ...ROUTES.map((route) => ({ id: route.id, path: route.path, element: screens(route) })),
    { path: "*", element: <Navigate to="/" replace /> },
  ]);
}
