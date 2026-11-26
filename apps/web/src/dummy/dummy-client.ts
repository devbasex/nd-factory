import type { FrameData } from "../app/App.tsx";
import type { AuthClient } from "../app/boot.ts";
import type { Connectivity } from "../offline/connectivity.ts";
import type { PlaceholderData } from "../screens/placeholder.tsx";

// ダミーの mode だけが読むモジュール。クエリパラメータ scenario と connection を読むのはここだけで、値は作り物だけを使う

/** 本番の成果物に混じっていないことを、ビルドの検査がこの文字列で確かめる @internal */
export const DUMMY_MARK = "nd-factory:dummy-client";

const SLOW_MS = 2000;

const ROWS: PlaceholderData = {
  kind: "rows",
  rows: [
    { id: "spr_00000000-0000-7000-8000-000000000001", title: "acme: sample row 1" },
    { id: "spr_00000000-0000-7000-8000-000000000002", title: "acme: sample row 2" },
  ],
};

const SCENARIOS: Record<string, () => Promise<PlaceholderData>> = {
  normal: async () => ROWS,
  empty: async () => ({ kind: "empty" }),
  error: async () => ({ kind: "error", reason: "unavailable" }),
  notFound: async () => ({ kind: "notFound" }),
  slow: () => new Promise((resolve) => setTimeout(() => resolve(ROWS), SLOW_MS)),
};

export type DummyApp = {
  placeholder: () => Promise<PlaceholderData>;
  connectivity: Connectivity;
  seedPending: boolean;
  frame: FrameData;
  fetch: typeof fetch;
  createAuth: () => AuthClient;
};

const CONFIG = {
  api_url: "https://api.example.com",
  authority: "https://acme-test.auth.example.com",
  client_id: "example-app-client",
  login_ready: true,
};

const USER = { id: "example-user-sub", created_at: "2026-01-02T03:04:05.000Z" };

export function createDummyApp(url: URL): DummyApp {
  document.documentElement.dataset["nd"] = DUMMY_MARK;
  const scenario = url.searchParams.get("scenario") ?? "normal";
  const connection = url.searchParams.get("connection");
  const seedPending = connection === "pending";
  const user = { access_token: "dummy", expired: false };
  return {
    placeholder: (Object.hasOwn(SCENARIOS, scenario) ? SCENARIOS[scenario] : SCENARIOS["normal"])!,
    connectivity: { online: () => connection !== "offline", subscribe: () => () => {} },
    seedPending,
    frame: {
      places: [{ to: "/t/team_00000000-0000-7000-8000-000000000001", name: "acme" }],
      waiting: 2,
      stopped: 0,
      sprintsPath: "/p/prj_00000000-0000-7000-8000-000000000001",
      pending: seedPending ? 1 : 0,
      held: 0,
    },
    // 設定の値と利用者の読み出しだけに答え、外へは何も送らない
    fetch: async (input) =>
      Response.json(String(input) === "/config.json" ? CONFIG : [{ status: "ok", item: USER }]),
    createAuth: () =>
      ({
        getUser: async () => user,
        signinRedirect: async () => {},
        signinRedirectCallback: async () => user,
        removeUser: async () => {},
      }) as unknown as AuthClient,
  };
}
