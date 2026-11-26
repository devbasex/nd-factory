import { createClock } from "@nd-factory/core/clock";
import { createLogger } from "@nd-factory/core/log";
import { createDeviceView, type DeviceView } from "../app/device-view.ts";
import type { ApiSender } from "../offline/api-transport.ts";
import type { Connectivity } from "../offline/connectivity.ts";
import { seal, tagOf } from "../offline/crypto.ts";
import { createOwner, openDeviceDb, readOwner } from "../offline/db.ts";
import { createOutbox } from "../offline/outbox.ts";
import { createSendWait } from "../offline/send-wait.ts";
import type { ScreenRead } from "../offline/sync.ts";
import type { PlaceholderAction } from "../screens/placeholder.tsx";

// ダミーの mode の端末のデータ。本物の端末のデータベースとそろえ方を使い、送り先だけを作り物にする

const USER = "example-user-sub";
const FINGERPRINT = "example-fingerprint";
const PROJECT = "prj_example";
const TEAM = "team_example";

const approval = (targetId: string, label: string): PlaceholderAction => ({
  label,
  operation: "approvals.answer",
  targetId,
  projectId: PROJECT,
  input: { comment: "作り物のコメント" },
  check: { version: 1, material_digest: "example-digest" },
});
const notice = (targetId: string, label: string): PlaceholderAction => ({
  label,
  operation: "notices.mark_read",
  targetId,
  projectId: null,
  input: {},
});

export const DUMMY_ACTIONS: readonly PlaceholderAction[] = [
  approval("apr_example-open", "承認する（受付中）"),
  approval("apr_example-closed", "承認する（受付終了）"),
  approval("apr_example-changed", "承認する（資料が変わった）"),
  notice("ntc_example-1", "通知 1 を既読にする"),
  notice("ntc_example-2", "通知 2 を既読にする"),
  { label: "チームを作る", operation: "teams.create", targetId: "team_example-new", projectId: null, input: {} },
];

// 対象の ID の末尾で、サーバーの今の状態を作り分ける
const REFUSALS: Record<string, string> = { "-closed": "state_mismatch", "-changed": "version_mismatch" };

/** pending は、確定待ちを送れないまま残す */
export async function openDummyDevice(connectivity: Connectivity, pending: boolean): Promise<DeviceView> {
  const db = await openDeviceDb({ onClosed: () => {} });
  const keys = (await readOwner(db)) ?? (await createOwner(db, USER));
  await db.put("login", {
    id: "login",
    userTag: keys.ownerTag,
    fingerprintTag: await tagOf(keys.tagKey, FINGERPRINT),
    ...(await seal(keys.key, {})),
  });
  const clock = createClock();
  // 前に API の時刻を受けた端末にする。無いと、確定待ちは期限を確かめられず送らない
  await createSendWait({ db }).writeApiTime(clock.epochMs());

  const session = { userId: USER, fingerprint: FINGERPRINT };
  const owner = { ...session, flagged: () => false };
  const sent: string[] = [];
  const record = () => void (document.documentElement.dataset["ndSent"] = JSON.stringify(sent));
  record();
  const send: ApiSender = async (call) => {
    if (pending) return { kind: "network", owner: session };
    const id = (call.items[0] as { id?: string }).id;
    if (call.name !== "projects.list") {
      sent.push(id ?? "");
      record();
    }
    const reason = Object.entries(REFUSALS).find(([suffix]) => id?.endsWith(suffix))?.[1];
    const result = reason === undefined ? { ok: true, item: { id } } : { ok: false, status: 409, reason };
    return {
      kind: "response",
      status: 200,
      result: { ok: true, results: [result] as never },
      retryAfter: null,
      date: new Date(clock.epochMs()).toUTCString(),
      owner: session,
    };
  };

  const empty: ScreenRead = { kind: "ok", snapshots: [], lists: [], missing: [] };
  const channel = new BroadcastChannel("nd-device");
  if (pending && (await db.count("outbox")) === 0) {
    const { label: _label, ...draft } = DUMMY_ACTIONS[0]!;
    await createOutbox({ db, clock }).enqueue(owner, { ...draft, pressedFloor: clock.epochMs() });
  }
  return createDeviceView({
    db,
    clock,
    perfNow: () => performance.now(),
    owner,
    send,
    readers: {
      projects: async () => ({ kind: "ok", items: [{ id: PROJECT, teamId: TEAM }] }),
      teams: async () => ({ kind: "ok", items: [{ id: TEAM }] }),
      transfers: async () => ({ kind: "ok", items: [] }),
      screen: async () => empty,
      lists: async () => empty,
      target: async () => "temporary",
    },
    connectivity,
    document,
    timers: { setInterval: (fn, ms) => window.setInterval(fn, ms), clearInterval: (id) => window.clearInterval(id) },
    channel: {
      post: () => channel.postMessage("changed"),
      subscribe(listener) {
        channel.addEventListener("message", listener);
        return () => channel.removeEventListener("message", listener);
      },
    },
    log: createLogger({ request_id: "-", fn: "web", endpoint: "web" }),
    onAuth: () => {},
    onStale: () => window.location.reload(),
  });
}
