// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { seal, unseal } from "../../src/offline/crypto.ts";
import { nextSeq } from "../../src/offline/db.ts";
import { prepareGuard } from "../../src/offline/guarded-commit.ts";
import { operationClassOf } from "../../src/offline/operation-classes.ts";
import type { Outbox, OutboxItem } from "../../src/offline/outbox.ts";
import { checkDeadline, classifyResult, createSender, type Round, type SendEvent } from "../../src/offline/send.ts";
import { denied, json, NOW, OPS, ok, sendSetup } from "./send-support.ts";
import { freshIndexedDb } from "./support.ts";

beforeEach(freshIndexedDb);

const HOUR = 3_600_000;
const reply = (status: number, item?: { status: number; reason: string }) => ({
  kind: "response" as const,
  status,
  retryAfter: null,
  date: null,
  owner: { userId: "u", fingerprint: "f" },
  result:
    status !== 200
      ? { ok: false as const, status: 0, reason: "response_invalid" }
      : { ok: true as const, results: [item === undefined ? { ok: true, item: { id: "x" } } : { ok: false, ...item }] as never },
});
const confirm = operationClassOf("questions.answer");
const classify = (over: Partial<Parameters<typeof classifyResult>[0]>) =>
  classifyResult({ cls: confirm, resent: false, idempotent: true, hasInput: true, reply: reply(200), ...over }).kind;

describe("段 2 の結果の判定", () => {
  it.each([
    ["成功", reply(200), "done"],
    ["version_mismatch", reply(200, { status: 409, reason: "version_mismatch" }), "reject"],
    ["state_mismatch", reply(200, { status: 409, reason: "state_mismatch" }), "reject"],
    ["1 回目の 403", reply(200, { status: 403, reason: "forbidden" }), "reject"],
    ["400", reply(200, { status: 400, reason: "item_invalid" }), "reject"],
    ["422", reply(200, { status: 422, reason: "idempotency_key_reused" }), "unknown"],
    ["in_progress", reply(200, { status: 409, reason: "in_progress" }), "retry"],
    ["429", reply(429), "retry"],
    ["503", reply(503), "retry"],
    ["401", reply(401), "auth"],
    ["形の違う 502", reply(502), "retry"],
    ["通信の失敗", { kind: "network" as const, owner: { userId: "u", fingerprint: "f" } }, "retry"],
  ])("%s", (_name, answer, kind) => {
    expect(classify({ reply: answer })).toBe(kind);
  });

  it("再送の 403・404 は結果未確認、冪等キーを受けない操作の 503 も結果未確認で止める", () => {
    for (const status of [403, 404]) {
      expect(classify({ resent: true, reply: reply(200, { status, reason: "x" }) })).toBe("unknown");
    }
    expect(classifyResult({ cls: confirm, resent: false, idempotent: false, hasInput: true, reply: reply(503) })).toMatchObject({
      kind: "unknown",
      stop: true,
    });
    expect(classify({ cls: operationClassOf("users.update"), idempotent: false, reply: reply(503) })).toBe("retry");
  });

  it("入力を持たないキャッシュして送るの拒否は保留にしない", () => {
    const decision = classifyResult({
      cls: operationClassOf("notices.mark_read"),
      resent: false,
      idempotent: false,
      hasInput: false,
      reply: reply(200, { status: 404, reason: "not_found" }),
    });
    expect(decision).toMatchObject({ kind: "reject", hold: false, deny: true });
  });
});

describe("期限", () => {
  const item = (over: Partial<OutboxItem>) =>
    ({ kind: "confirm", pressedAt: 0, pressedFloor: 0, sendStarted: false, sentAt: null, ...over }) as OutboxItem;

  it("確定待ちは API の時刻で 23 時間 58 分未満、端末の時刻で 24 時間未満だけ送る", () => {
    expect(checkDeadline(item({}), 23 * HOUR + 58 * 60_000 - 1, 1)).toBe("send");
    expect(checkDeadline(item({}), 23 * HOUR + 58 * 60_000, 1)).toBe("expired");
    expect(checkDeadline(item({}), 1, 24 * HOUR)).toBe("expired");
    expect(checkDeadline(item({ pressedFloor: null }), 1, 1)).toBe("expired");
    expect(checkDeadline(item({}), null, 1)).toBe("expired");
  });

  it("送ったことのある件は期限切れでなく結果未確認にし、送り直しは 23 時間未満だけにする", () => {
    expect(checkDeadline(item({ sendStarted: true, sentAt: 0 }), 1, 24 * HOUR)).toBe("unknown");
    const queued = item({ kind: "queued", sendStarted: true, sentAt: 0 });
    expect(checkDeadline(queued, 23 * HOUR - 1, 1)).toBe("send");
    expect(checkDeadline(queued, 23 * HOUR, 1)).toBe("unknown");
    expect(checkDeadline({ ...queued, sentAt: null }, 1, 1)).toBe("unknown");
    expect(checkDeadline(queued, null, 1)).toBe("unknown");
  });
});

async function setup() {
  const t = await sendSetup();
  const events: SendEvent[] = [];
  const reverted: string[] = [];
  const counts = { reconfirm: 0, auth: 0 };
  const round: Round = {
    owner: t.owner,
    mismatchProjectIds: new Set<string>(),
    apiNow: null,
    revert: async (item) => void reverted.push(item.targetId),
    reconfirm: async () => void (counts.reconfirm += 1),
    onAuth: () => void (counts.auth += 1),
    report: (event) => void events.push(event),
  };
  // 送る側の読み書きの直後に、ほかの処理（取り下げなど）を割り込ませる
  const hooks: {
    afterFind?: () => Promise<void>;
    afterMark?: (item: OutboxItem) => Promise<void>;
    afterApiTime?: () => Promise<void>;
    // 会話の写しの書き込みを用意した直後に、別のタブの読み直しで写しを書き換える回数
    conversationConflicts?: number;
    // 会話の写しを読んだ直後に、別のタブの読み直しを割り込ませる
    afterConversationRead?: () => Promise<void>;
  } = {};
  // 応答の時刻を書いた直後（件の反映の前）に、ほかのタブの処理を割り込ませる
  const wait = {
    ...t.wait,
    writeApiTime: async (owner: Round["owner"], ms: number) => {
      const written = await t.wait.writeApiTime(owner, ms);
      const hook = hooks.afterApiTime;
      hooks.afterApiTime = undefined;
      await hook?.();
      return written;
    },
  };
  const outbox: Outbox = {
    ...t.outbox,
    find: async (answerTag) => {
      const found = await t.outbox.find(answerTag);
      const hook = hooks.afterFind;
      hooks.afterFind = undefined;
      await hook?.();
      return found;
    },
    markSendStarted: async (item, sentAt) => {
      const marked = await t.outbox.markSendStarted(item, sentAt);
      const hook = hooks.afterMark;
      hooks.afterMark = undefined;
      if (marked !== null) await hook?.(marked);
      return marked;
    },
  };
  const cache: typeof t.cache = {
    ...t.cache,
    readGuarded: async (guard, kind, targetId) => {
      const read = await t.cache.readGuarded(guard, kind, targetId);
      const hook = hooks.afterConversationRead;
      hooks.afterConversationRead = undefined;
      await hook?.();
      return read;
    },
    prepareReplace: async (guard, kind, targetId, value, fetchSeq) => {
      const write = await t.cache.prepareReplace(guard, kind, targetId, value, fetchSeq);
      const conflicts = hooks.conversationConflicts ?? 0;
      if (conflicts > 0) {
        hooks.conversationConflicts = conflicts - 1;
        // 先映しした項目を残したまま、写しの行を書き直す
        await t.cache.applyOptimistic(guard, kind, targetId, (current) => current);
      }
      return write;
    },
  };
  const sender = createSender({
    db: t.db,
    outbox,
    wait,
    cache,
    send: t.sender,
    ops: OPS,
    perfNow: () => t.state.perf,
    wallNow: () => t.state.wall,
    log: { info: () => {}, warn: () => {} },
    notify: () => {},
  });
  const run = async () => sender.sendQueue(round, (await t.outbox.readBatch()).items);
  const held = async () => (await t.db.getAll("held")).map((r) => r.holdReason);
  const sent = () => t.writes().map((r) => (r.items[0] as { text: string }).text);
  return { ...t, round, sender, events, reverted, counts, run, held, sent, hooks };
}

describe("送る列を送る", () => {
  it("押した順に送り、冪等キーは受ける操作にだけ入れ、成功した件を消す", async () => {
    const t = await setup();
    await t.enqueue("users.update", "first");
    await t.enqueue("questions.answer", "second");
    expect(await t.run()).toBe("done");
    expect(t.sent()).toEqual(["first", "second"]);
    expect(t.writes()[0]!.items[0]).not.toHaveProperty("idempotency_key");
    expect(t.writes()[1]!.items[0]).toHaveProperty("idempotency_key");
    expect(await t.db.count("outbox")).toBe(0);
    expect(t.events.map((e) => e.kind)).toEqual(["confirmed"]);
    t.db.close();
  });

  it("照合の値の無い確定待ちは送らず、保留へ移す", async () => {
    const t = await setup();
    const item = await t.enqueue("questions.answer", "bare");
    // 照合の値を持たずに保存された件
    const row = (await t.db.get("outbox", item.answerTag))!;
    const { check: _check, ...body } = await unseal<Record<string, unknown>>(t.keys.key, row);
    await t.db.put("outbox", { ...row, ...(await seal(t.keys.key, body)) });
    expect(await t.run()).toBe("done");
    expect(t.writes()).toEqual([]);
    expect(await t.held()).toEqual(["unmigrated"]);
    t.db.close();
  });

  it("確定待ちは、依頼の状態や資料が変わっていれば拒まれ、保留の件に入力を残す", async () => {
    const t = await setup();
    await t.enqueue("questions.answer", "state");
    await t.enqueue("questions.answer", "version", { check: { version: 3 } });
    t.replies.push(
      () => denied(409, "state_mismatch"),
      () => denied(409, "version_mismatch"),
    );
    expect(await t.run()).toBe("done");
    expect(t.writes()[1]!.items[0]).toMatchObject({ version: 3 });
    expect(await t.held()).toEqual(["rejected", "rejected"]);
    expect(t.events.map((e) => e.kind)).toEqual(["rejected", "rejected"]);
    t.db.close();
  });

  it("一時の失敗で後続を止め、次の回で同じ冪等キーで送り直す", async () => {
    const t = await setup();
    await t.enqueue("questions.answer", "first");
    await t.enqueue("questions.answer", "second");
    t.replies.push(() => new TypeError("offline"));
    expect(await t.run()).toBe("stopped");
    expect(t.sent()).toEqual(["first"]);
    expect(await t.run()).toBe("done");
    expect(t.sent()).toEqual(["first", "first", "second"]);
    const [a, b] = t.writes().map((r) => (r.items[0] as { idempotency_key: string }).idempotency_key);
    expect(a).toBe(b);
    t.db.close();
  });

  it("429 は待機の期限を書いて止め、冪等キーを受けない操作は印を戻す", async () => {
    const t = await setup();
    await t.enqueue("users.update");
    t.replies.push(() => json({}, { status: 429, headers: { "retry-after": "30" } }));
    expect(await t.run()).toBe("stopped");
    expect(await t.wait.read()).toEqual({ retryUntil: NOW + 30_000, backoffMs: 0 });
    expect((await t.outbox.readBatch()).items[0]).toMatchObject({ sendStarted: false });
    t.db.close();
  });

  it("成功の応答は、送る前に見た待機の期限だけを解き、応答を待つ間に別のタブが書いた期限は残す", async () => {
    const t = await setup();
    await t.wait.write(t.owner, { retryUntil: NOW - 1_000, backoffMs: 60_000 });
    await t.enqueue("users.update", "first");
    expect(await t.run()).toBe("done");
    expect(await t.wait.read()).toBeNull();
    await t.enqueue("users.update", "second");
    const later = { retryUntil: NOW + 90_000, backoffMs: 60_000 };
    t.replies.push(async () => {
      await t.wait.write(t.owner, later);
      return ok();
    });
    expect(await t.run()).toBe("done");
    expect(await t.db.count("outbox")).toBe(0);
    expect(await t.wait.read()).toEqual(later);
    t.db.close();
  });

  it("成功を反映する前にセッションが替われば、件も待機の期限も変えずに止める", async () => {
    const t = await setup();
    const waiting = { retryUntil: NOW - 1_000, backoffMs: 60_000 };
    await t.wait.write(t.owner, waiting);
    await t.enqueue("users.update", "first");
    t.hooks.afterApiTime = async () => void (t.state.flagged = true);
    expect(await t.run()).toBe("stopped");
    t.state.flagged = false;
    expect(await t.db.count("outbox")).toBe(1);
    expect(await t.wait.read()).toEqual(waiting);
    t.db.close();
  });

  it("401 は件を残して認証の回復へ渡す", async () => {
    const t = await setup();
    await t.enqueue("questions.answer");
    t.replies.push(() => json({}, { status: 401 }));
    expect(await t.run()).toBe("stopped");
    expect(t.counts.auth).toBe(1);
    expect(await t.db.count("outbox")).toBe(1);
    t.db.close();
  });

  it("期限切れの確定待ちは送らず保留にして後続へ進む", async () => {
    const t = await setup();
    await t.enqueue("questions.answer", "old", { pressedFloor: NOW - 24 * HOUR });
    await t.enqueue("questions.answer", "new");
    expect(await t.run()).toBe("done");
    expect(t.sent()).toEqual(["new"]);
    expect(await t.held()).toEqual(["expired"]);
    t.db.close();
  });

  it("時刻の読み出しが一時の失敗なら、件を残して止める", async () => {
    const t = await setup();
    await t.enqueue("questions.answer");
    t.setTime(() => new TypeError("offline"));
    expect(await t.run()).toBe("stopped");
    expect(t.writes()).toEqual([]);
    expect((await t.outbox.readBatch()).items[0]).toMatchObject({ sendStarted: false });
    t.db.close();
  });

  it("時刻の読み出しに 60 秒かかれば 1 回だけ読み直し、まだ合わなければ印を戻して止める", async () => {
    const t = await setup();
    await t.enqueue("questions.answer");
    t.setTime(() => {
      t.state.perf += 60_000;
      return json([{ ok: true, items: [], next_cursor: null }]);
    });
    expect(await t.run()).toBe("stopped");
    expect(t.requests.map((r) => r.name)).toEqual(["projects.list", "projects.list"]);
    expect((await t.outbox.readBatch()).items[0]).toMatchObject({ sendStarted: false, sentAt: null });
    t.db.close();
  });

  it("送り始めた冪等キーを受けない確定待ちは送り直さず、結果未確認にする", async () => {
    const t = await setup();
    const item = await t.enqueue("projects.close");
    await t.outbox.markSendStarted(item, NOW);
    await t.run();
    expect(t.writes()).toEqual([]);
    expect(await t.held()).toEqual(["unknown-result"]);
    t.db.close();
  });

  it("所属の食い違いのプロジェクトの件に達したら、後続も残して止める", async () => {
    const t = await setup();
    await t.enqueue("questions.answer", "mix", { projectId: "p-mix" });
    await t.enqueue("questions.answer", "other");
    t.round.mismatchProjectIds = new Set(["p-mix"]);
    expect(await t.run()).toBe("stopped");
    expect(t.writes()).toEqual([]);
    expect(await t.db.count("outbox")).toBe(2);
    t.db.close();
  });

  it("403 は対象の表示を保留して確かめ直し、後続へ進む", async () => {
    const t = await setup();
    await t.enqueue("questions.answer", "first");
    await t.enqueue("questions.answer", "second");
    t.replies.push(() => denied(403, "role_insufficient"));
    expect(await t.run()).toBe("done");
    expect(t.counts.reconfirm).toBe(1);
    expect(t.sent()).toEqual(["first", "second"]);
    expect(await t.held()).toEqual(["rejected"]);
    expect((await prepareGuard(t.db, t.owner))!.authz!.denied.map((d) => d.id)).toEqual(["p-example"]);
    t.db.close();
  });

  it("キャッシュして送るの拒否は先映しを取り消す", async () => {
    const t = await setup();
    await t.enqueue("notices.mark_read", "n1", { projectId: null });
    t.replies.push(() => denied(409, "state_mismatch"));
    await t.run();
    expect(t.reverted).toEqual(["n1"]);
    expect(await t.db.count("outbox")).toBe(0);
    expect(await t.db.count("held")).toBe(0);
    t.db.close();
  });

  it("応答の前にフラグが立てば、レスポンスを捨てて件を残す", async () => {
    const t = await setup();
    await t.enqueue("questions.answer");
    t.replies.push(() => {
      t.state.flagged = true;
      return ok();
    });
    expect(await t.run()).toBe("stopped");
    expect(await t.db.count("outbox")).toBe(1);
    t.db.close();
  });
});

describe("取り下げ", () => {
  it("未送信の件は消え、送り始めた件は保留になる", async () => {
    const t = await setup();
    const unsent = await t.enqueue("organizer_messages.create", "a");
    expect(await t.sender.withdraw(t.owner, unsent.answerTag)).toBe("removed");
    const started = await t.enqueue("questions.answer", "b");
    await t.outbox.markSendStarted(started, NOW);
    expect(await t.sender.withdraw(t.owner, started.answerTag)).toBe("held");
    expect(await t.held()).toEqual(["unknown-result"]);
    expect(await t.sender.withdraw(t.owner, started.answerTag)).toBe("held");
    expect(t.writes()).toEqual([]);
    t.db.close();
  });

  it("送っている間に取り下げた会話の送信が成功すれば、返った項目の取り下げを足す", async () => {
    const t = await setup();
    const item = await t.enqueue("organizer_messages.create", "hello");
    t.replies.push(async () => {
      expect(await t.sender.withdraw(t.owner, item.answerTag)).toBe("held");
      return ok("msg-1");
    });
    await t.run();
    expect(await t.db.count("held")).toBe(0);
    expect((await t.outbox.readBatch()).items).toMatchObject([{ operation: "organizer_messages.withdraw", targetId: "msg-1" }]);
    t.db.close();
  });

  it("成功を反映する直前に取り下げが保留へ移しても、同じ処理で返った項目の取り下げを足す", async () => {
    const t = await setup();
    const item = await t.enqueue("organizer_messages.create", "hello");
    t.replies.push(() => {
      // 成功の反映が送る列を読んだ直後に、取り下げが件を保留へ移す
      t.hooks.afterFind = async () => void (await t.sender.withdraw(t.owner, item.answerTag));
      return ok("msg-1");
    });
    expect(await t.run()).toBe("done");
    expect(await t.db.count("held")).toBe(0);
    expect((await t.outbox.readBatch()).items).toMatchObject([{ operation: "organizer_messages.withdraw", targetId: "msg-1" }]);
    t.db.close();
  });

  it("取り下げた会話の成功を反映する直前にセッションが替われば、保存の失敗にせず、取り下げを足さずに止める", async () => {
    const t = await setup();
    const item = await t.enqueue("organizer_messages.create", "hello");
    t.replies.push(async () => {
      expect(await t.sender.withdraw(t.owner, item.answerTag)).toBe("held");
      // 成功の反映が件を読んだ直後に、別のタブでサインアウトが始まる
      t.hooks.afterFind = async () => void (t.state.flagged = true);
      return ok("msg-1");
    });
    expect(await t.run()).toBe("stopped");
    t.state.flagged = false;
    expect(await t.held()).toEqual(["unknown-result"]);
    expect(await t.db.count("outbox")).toBe(0);
    t.db.close();
  });

  it("送り始めの印の後、送る前に取り下げた件は、送らなかった件として保留から消す", async () => {
    const t = await setup();
    const item = await t.enqueue("users.update", "first");
    t.hooks.afterMark = async () => {
      expect(await t.sender.withdraw(t.owner, item.answerTag)).toBe("held");
    };
    expect(await t.run()).toBe("done");
    expect(t.writes()).toEqual([]);
    expect(await t.db.count("held")).toBe(0);
    expect(await t.db.count("outbox")).toBe(0);
    t.db.close();
  });

  it("前の回で送った件が取り下げで保留へ移っていれば、送らずに結果未確認のまま残す", async () => {
    const t = await setup();
    const item = await t.enqueue("users.update", "first");
    const marked = (await t.outbox.markSendStarted(item, NOW))!;
    expect(await t.outbox.dropWithdrawnUnsent(marked)).toBe(false);
    expect(await t.sender.withdraw(t.owner, item.answerTag)).toBe("held");
    expect(await t.outbox.dropWithdrawnUnsent({ ...marked, iv: new Uint8Array(12) })).toBe(false);
    expect(await t.held()).toEqual(["unknown-result"]);
    t.db.close();
  });

  // 会話の写しに、送る列の件を先映しした項目を置く
  async function project(t: Awaited<ReturnType<typeof setup>>, answerTag: string) {
    const guard = (await prepareGuard(t.db, t.owner))!;
    const write = (await t.cache.prepareReplace(
      guard,
      "organizer-messages",
      "org-1",
      { items: [{ answer_tag: answerTag }] },
      await nextSeq(t.db),
    ))!;
    const tx = t.db.transaction(["keys", "login", "snapshots", "outbox", "held", "authz"], "readwrite");
    await write(tx);
    await tx.done;
  }

  it("成功の反映が先なら会話の写しの項目 ID で取り下げ、引けなければ確かめられないとする", async () => {
    const t = await setup();
    const item = await t.enqueue("organizer_messages.create", "hello", { targetId: "org-1" });
    await project(t, item.answerTag);
    await t.run();
    const conversation = { organizerId: "org-1", projectId: "p-example" };
    expect(await t.sender.withdraw(t.owner, item.answerTag, conversation)).toBe("enqueued");
    expect((await t.outbox.readBatch()).items).toMatchObject([{ targetId: "id-example" }]);
    expect(await t.sender.withdraw(t.owner, "unknown-tag", conversation)).toBe("unconfirmed");
    t.db.close();
  });

  it("会話の写しの照合が続けて外れても、最後の回で返った項目の ID を写しに書いて件を消し、直後の取り下げをその ID で足す", async () => {
    const t = await setup();
    const item = await t.enqueue("organizer_messages.create", "hello", { targetId: "org-1" });
    await project(t, item.answerTag);
    t.hooks.conversationConflicts = 2;
    t.replies.push(() => ok("msg-1"));
    expect(await t.run()).toBe("done");
    expect(t.hooks.conversationConflicts).toBe(0);
    expect(await t.db.count("outbox")).toBe(0);
    const conversation = { organizerId: "org-1", projectId: "p-example" };
    expect(await t.sender.withdraw(t.owner, item.answerTag, conversation)).toBe("enqueued");
    expect((await t.outbox.readBatch()).items).toMatchObject([{ operation: "organizer_messages.withdraw", targetId: "msg-1" }]);
    t.db.close();
  });

  it("会話の写しの照合が最後の回まで外れたら、返った ID を件に書いて後続の件を送り、次の回は送り直さずに写しに書く", async () => {
    const t = await setup();
    const item = await t.enqueue("organizer_messages.create", "hello", { targetId: "org-1" });
    await t.enqueue("users.update", "after");
    await project(t, item.answerTag);
    t.hooks.conversationConflicts = 3;
    t.replies.push(() => ok("msg-1"));
    expect(await t.run()).toBe("done");
    expect(t.sent()).toEqual(["hello", "after"]);
    expect((await t.outbox.readBatch()).items).toMatchObject([{ answerTag: item.answerTag, sentItemId: "msg-1" }]);
    const before = t.requests.length;
    expect(await t.run()).toBe("done");
    // 送り直しも時刻の読み直しもしない
    expect(t.requests.length).toBe(before);
    expect(await t.db.count("outbox")).toBe(0);
    const conversation = { organizerId: "org-1", projectId: "p-example" };
    expect(await t.sender.withdraw(t.owner, item.answerTag, conversation)).toBe("enqueued");
    expect((await t.outbox.readBatch()).items).toMatchObject([{ operation: "organizer_messages.withdraw", targetId: "msg-1" }]);
    t.db.close();
  });

  it("返った ID を件に書いて残した後に取り下げると、保留へ移さずその ID で取り下げを足す", async () => {
    const t = await setup();
    const item = await t.enqueue("organizer_messages.create", "hello", { targetId: "org-1" });
    await project(t, item.answerTag);
    t.hooks.conversationConflicts = 3;
    t.replies.push(() => ok("msg-1"));
    expect(await t.run()).toBe("done");
    expect(await t.sender.withdraw(t.owner, item.answerTag)).toBe("enqueued");
    expect(await t.db.count("held")).toBe(0);
    expect((await t.outbox.readBatch()).items).toMatchObject([{ operation: "organizer_messages.withdraw", targetId: "msg-1" }]);
    t.db.close();
  });

  it("先映しが無いと読んだ後に別のタブの読み直しが先映しを書いたら、読み直して返った ID を写しに書く", async () => {
    const t = await setup();
    const item = await t.enqueue("organizer_messages.create", "hello", { targetId: "org-1" });
    t.replies.push(() => {
      t.hooks.afterConversationRead = () => project(t, item.answerTag);
      return ok("msg-1");
    });
    expect(await t.run()).toBe("done");
    expect(await t.db.count("outbox")).toBe(0);
    const conversation = { organizerId: "org-1", projectId: "p-example" };
    expect(await t.sender.withdraw(t.owner, item.answerTag, conversation)).toBe("enqueued");
    expect((await t.outbox.readBatch()).items).toMatchObject([{ operation: "organizer_messages.withdraw", targetId: "msg-1" }]);
    t.db.close();
  });
});
