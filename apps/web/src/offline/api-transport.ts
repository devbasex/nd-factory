import { type CallResult, createOperationClient, httpTransport } from "@nd-factory/contracts/client";
import type { OperationDef } from "@nd-factory/contracts/operation";
import { tagOf } from "./crypto.ts";
import { type DeviceDb, readOwner } from "./db.ts";
import { withSigninLock } from "./quarantine.ts";

// API への 1 つの送り方。照合した token をそのまま送り、照合と送信の開始の間にサインアウトや
// アカウントの切り替えが入らないようにする（#12 の設計書の「送信の直前の照合と token の固定」）

// 時刻の読み出しを始めてから、件を送り始めるまでに許す長さ
const TIME_READ_MAX_MS = 60_000;
export const DEADLINE_MS = 24 * 60 * 60 * 1000;

export type SessionOwner = { userId: string; fingerprint: string };

type ApiCall = {
  name: string;
  items: readonly unknown[];
  // そろえ方の回の持ち主。回でないリクエストは持たない
  round?: SessionOwner;
  // 送る列の件を送るとき。件が残っていなければ送らない
  answerTag?: string;
  // 件ごとに時刻を読み直したときの、読み出しを始めた時点
  timed?: { since: { perf: number; wall: number } };
  // 確定待ちの、押したときの端末の時刻
  pressedAt?: number;
};

export type ApiReply =
  | {
      kind: "response";
      status: number;
      result: CallResult<OperationDef>;
      retryAfter: string | null;
      date: string | null;
      owner: SessionOwner;
    }
  // 通信の失敗。サーバーに届いたかは分からない
  | { kind: "network"; owner: SessionOwner }
  // 本物の fetch を呼んでいない
  | { kind: "aborted"; reason: "session" | "gone" | "stale-time" | "deadline" };

export type SenderDeps = {
  db: DeviceDb;
  baseUrl: string;
  fetch: typeof fetch;
  ops?: readonly OperationDef[];
  // サインアウトか連携ログインの解除の途中のフラグがあるか
  flagged: () => boolean;
  // 送る access token と、その利用者とセッションの指紋。取り直しもここで済ませる
  session: () => Promise<({ accessToken: string } & SessionOwner) | null>;
  // このタブのメモリの利用者とセッション
  memory: () => SessionOwner | null;
  perfNow: () => number;
  wallNow: () => number;
};

export type ApiSender = (call: ApiCall) => Promise<ApiReply>;

type Abort = Extract<ApiReply, { kind: "aborted" }>["reason"];

class Aborted extends Error {
  override name = "Aborted";
  readonly reason: Abort;
  constructor(reason: Abort) {
    super("送らなかった");
    this.reason = reason;
  }
}

export function createApiSender(d: SenderDeps): ApiSender {
  const same = (a: SessionOwner, b: SessionOwner | null) => b !== null && a.userId === b.userId && a.fingerprint === b.fingerprint;

  // 錠の中で読む。応答と token の取り直しは待たない
  async function check(call: ApiCall, token: SessionOwner, tags: { user: string; fingerprint: string }): Promise<Abort | null> {
    if (d.flagged()) return "session";
    const tx = d.db.transaction(["keys", "login", "outbox"], "readonly");
    const [keys, login, queued] = await Promise.all([
      tx.objectStore("keys").get("main"),
      tx.objectStore("login").get("login"),
      call.answerTag === undefined ? undefined : tx.objectStore("outbox").get(call.answerTag),
    ]);
    await tx.done;
    const memory = d.memory();
    if (keys === undefined || login === undefined) return "session";
    if (login.userTag !== keys.ownerTag || login.userTag !== tags.user || login.fingerprintTag !== tags.fingerprint) return "session";
    if (!same(token, call.round ?? memory) || !same(token, memory)) return "session";
    if (call.answerTag !== undefined && queued === undefined) return "gone";
    if (call.pressedAt !== undefined && d.wallNow() - call.pressedAt >= DEADLINE_MS) return "deadline";
    if (call.timed !== undefined) {
      const { since } = call.timed;
      const fresh = (elapsed: number) => elapsed >= 0 && elapsed < TIME_READ_MAX_MS;
      if (!fresh(d.perfNow() - since.perf) || !fresh(d.wallNow() - since.wall)) return "stale-time";
    }
    return null;
  }

  return async (call) => {
    const session = await d.session();
    const keys = await readOwner(d.db);
    if (session === null || keys === null) return { kind: "aborted", reason: "session" };
    const owner: SessionOwner = { userId: session.userId, fingerprint: session.fingerprint };
    const tags = { user: await tagOf(keys.tagKey, owner.userId), fingerprint: await tagOf(keys.tagKey, owner.fingerprint) };

    // 呼び出しの口は状態とヘッダーを捨てることがあるので、リクエストごとに持つ
    const seen: { status: number; retryAfter: string | null; date: string | null } = { status: 0, retryAfter: null, date: null };
    const guarded: typeof fetch = async (input, init) => {
      let pending: Promise<Response> | undefined;
      await withSigninLock(async () => {
        const reason = await check(call, owner, tags);
        if (reason !== null) throw new Aborted(reason);
        // 照合から送信の開始まで await を挟まない。応答は錠を放してから待つ
        pending = d.fetch(input, init);
        pending.catch(() => {});
      });
      const response = await pending!;
      seen.status = response.status;
      seen.retryAfter = response.headers.get("retry-after");
      seen.date = response.headers.get("date");
      return response;
    };

    const transport = httpTransport({ baseUrl: d.baseUrl, fetch: guarded, token: async () => session.accessToken });
    const client = d.ops === undefined ? createOperationClient(transport) : createOperationClient(transport, d.ops);
    try {
      const result = (await client.call(call.name as never, call.items as never)) as CallResult<OperationDef>;
      return { kind: "response", ...seen, result, owner };
    } catch (error) {
      if (error instanceof Aborted) return { kind: "aborted", reason: error.reason };
      if (error instanceof TypeError && error.message.startsWith("操作の表に無い操作")) throw error;
      // 本文の読み取りの失敗も、通信の失敗として扱う
      return { kind: "network", owner };
    }
  };
}
