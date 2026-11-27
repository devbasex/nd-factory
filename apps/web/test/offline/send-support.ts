import { defineOperation, okItem, okList, type OperationDef } from "@nd-factory/contracts/operation";
import { createClock } from "@nd-factory/core/clock";
import { z } from "zod";
import { createApiSender } from "../../src/offline/api-transport.ts";
import { createCacheStore } from "../../src/offline/cache-store.ts";
import { operationClassOf } from "../../src/offline/operation-classes.ts";
import { createOutbox, type Draft } from "../../src/offline/outbox.ts";
import { createSendWait } from "../../src/offline/send-wait.ts";
import { openDb, signedIn, USER } from "./support.ts";

// そろえ方のテストの準備。操作の形は未定なので、作り物の操作の表を使う

const any = z.looseObject({});
const write = (name: string, idempotencyKey: boolean): OperationDef =>
  defineOperation({
    name,
    features: ["F1"],
    access: "write",
    delegationKind: "run",
    idempotencyKey,
    item: any,
    result: okItem(z.object({ id: z.string() })),
    owner: "#1",
  });
const list = (name: string): OperationDef =>
  defineOperation({
    name,
    features: ["F1"],
    access: "read",
    delegationKind: "read",
    item: any,
    result: okList(any),
    owner: "#1",
  });

export const OPS: OperationDef[] = [
  list("projects.list"),
  write("questions.answer", true),
  write("users.update", false),
  write("projects.close", false),
  write("organizer_messages.create", true),
  write("organizer_messages.withdraw", false),
  write("notices.mark_read", false),
];

export const NOW = Date.parse("2026-11-26T00:00:00Z");

type Request = { name: string; items: Record<string, unknown>[] };
export type Answer = Response | Error | undefined;

export const ok = (id = "id-example") => json([{ ok: true, item: { id } }]);
export const denied = (status: number, reason: string) => json([{ ok: false, status, reason }]);
export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, headers: { date: new Date(NOW).toUTCString(), ...init.headers } });
}

export async function sendSetup() {
  const db = await openDb();
  const { keys, owner } = await signedIn(db);
  const state = { wall: NOW, perf: 0, flagged: false };
  const requests: Request[] = [];
  // 書き込みの操作の応答。無ければ成功を返す
  const replies: ((request: Request) => Answer | Promise<Answer>)[] = [];
  let time: () => Answer = () => json([{ ok: true, items: [], next_cursor: null }]);
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const [, , entity, verb] = new URL(String(url)).pathname.split("/");
    const request: Request = { name: `${entity}.${verb}`, items: JSON.parse(String(init?.body)) as Request["items"] };
    requests.push(request);
    const answer = request.name === "projects.list" ? time() : ((await replies.shift()?.(request)) ?? ok());
    if (answer instanceof Error) throw answer;
    return answer!;
  };
  const flagged = () => state.flagged;
  const session = { userId: USER, fingerprint: owner.fingerprint };
  const sender = createApiSender({
    db,
    baseUrl: "https://api.example.invalid",
    ops: OPS,
    fetch,
    flagged,
    session: async () => ({ accessToken: "token-a", ...session }),
    memory: () => session,
    perfNow: () => state.perf,
    wallNow: () => state.wall,
  });
  const clock = { ...createClock(), epochMs: () => state.wall };
  const outbox = createOutbox({ db, clock });
  const wait = createSendWait({ db });
  const cache = createCacheStore({ db, wallNow: () => state.wall, log: { warn: () => {} }, notify: () => {} });
  // 確定待ちには、読んだときの照合の値を付ける
  const checkOf = (operation: string): Pick<Draft, "check"> => {
    const cls = operationClassOf(operation);
    if (cls.class !== "confirm") return {};
    const check: Record<string, string | number> = { version: 1 };
    if (cls.check.includes("material_digest")) check["material_digest"] = "sha256:example";
    return { check };
  };
  const enqueue = (operation: string, targetId = "target-example", over: Partial<Draft> = {}) =>
    outbox.enqueue({ ...owner, flagged }, {
      operation,
      targetId,
      projectId: "p-example",
      input: { text: targetId },
      pressedFloor: NOW,
      ...checkOf(operation),
      ...over,
    });
  return {
    db,
    keys,
    owner: { ...owner, flagged },
    state,
    requests,
    replies,
    setTime: (next: () => Answer) => void (time = next),
    sender,
    outbox,
    wait,
    cache,
    enqueue,
    writes: () => requests.filter((r) => r.name !== "projects.list"),
  };
}
