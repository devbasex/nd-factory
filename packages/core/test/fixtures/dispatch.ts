import { idOf } from "@nd-factory/contracts/ids";
import { defineOperation, okItem } from "@nd-factory/contracts/operation";
import { z } from "zod";
import { cond, putIfAbsent, replaceIfVersion } from "../../src/conditional-write.ts";
import type { Handler } from "../../src/dispatch/types.ts";

// 振り分けのテストが使う作り物の操作とハンドラー。要素と結果の形を持つ（形の未定の操作は fixtures/operations.ts）

const project = idOf("prj");
const idempotencyKey = z.uuid();

// 読む操作
const notesGet = defineOperation({
  name: "notes.get",
  features: ["F3"],
  access: "read",
  delegationKind: "read",
  auditKeys: ["project_id"],
  item: z.strictObject({ project_id: project }),
  result: okItem(z.strictObject({ project_id: project, title: z.string() })),
  owner: "#2",
});

// 冪等の鍵を持つ書く操作。title も記録の許した鍵に入れ、秘密の形の値が記録の行へ写らないこと（redact）を照らす
export const notesCreate = defineOperation({
  name: "notes.create",
  features: ["F3"],
  access: "write",
  delegationKind: "run",
  idempotencyKey: true,
  auditKeys: ["project_id", "title"],
  item: z.strictObject({ project_id: project, title: z.string().min(1), idempotency_key: idempotencyKey }),
  result: okItem(z.strictObject({ title: z.string() })),
  owner: "#2",
});

// 版で照らす書く操作（冪等の鍵なし）
const notesRename = defineOperation({
  name: "notes.rename",
  features: ["F3"],
  access: "write",
  delegationKind: "run",
  auditKeys: ["project_id"],
  item: z.strictObject({ project_id: project, title: z.string().min(1), version: z.number().int().min(1) }),
  result: okItem(z.strictObject({ title: z.string() })),
  owner: "#2",
});

// 全部か無か（要素は 3 つまで）
const notesImport = defineOperation({
  name: "notes.import",
  features: ["F3"],
  access: "write",
  delegationKind: "run",
  allOrNothing: { maxItems: 3 },
  auditKeys: ["project_id"],
  item: z.strictObject({ project_id: project, title: z.string().min(1) }),
  result: okItem(z.strictObject({ title: z.string() })),
  owner: "#2",
});

// 人だけの操作
const notesPurge = defineOperation({
  name: "notes.purge",
  features: ["F3"],
  access: "write",
  humanOnly: "always",
  mcpRead: "notes.get",
  item: z.strictObject({ project_id: project }),
  result: okItem(z.strictObject({ project_id: project })),
  owner: "#2",
});

// サインイン（初回は利用者を作る。既にある利用者のサインインし直しは状態を書かない）
const sessionsCreate = defineOperation({
  name: "sessions.create",
  features: ["F1"],
  access: "write",
  humanOnly: "always",
  mcpRead: "notes.get",
  idempotencyKey: true,
  item: z.strictObject({ idempotency_key: idempotencyKey }),
  result: okItem(z.strictObject({ user_id: idOf("usr") })),
  owner: "#2",
});

// サインアウト（取り消しの行を書く側。要求元の照らしを足さない）
const sessionsDelete = defineOperation({
  name: "sessions.delete",
  features: ["F1"],
  access: "write",
  humanOnly: "always",
  mcpRead: "notes.get",
  item: z.strictObject({}),
  result: okItem(z.strictObject({ revoked_at: z.string() })),
  owner: "#2",
});

// ログインを外す。要素は外す Cognito の主体（作り物の形。ハンドラーは対応の行を強い整合で読んで消す）
const loginsDelete = defineOperation({
  name: "logins.delete",
  features: ["F1"],
  access: "write",
  humanOnly: "always",
  mcpRead: "notes.get",
  idempotencyKey: true,
  item: z.strictObject({ cognito_sub: z.string().min(1), idempotency_key: idempotencyKey }),
  result: okItem(z.strictObject({ cognito_sub: z.string() })),
  // 最後のログインは外せない（操作の契約にある失敗の結果）
  reasons: [{ code: "last_login", status: 409, when: "always" }],
  owner: "#2",
});

// 全部か無かで冪等の鍵を持つ（要素は 3 つまで）
const notesBulk = defineOperation({
  name: "notes.bulk",
  features: ["F3"],
  access: "write",
  delegationKind: "run",
  allOrNothing: { maxItems: 3 },
  idempotencyKey: true,
  auditKeys: ["project_id"],
  item: z.strictObject({ project_id: project, title: z.string().min(1), idempotency_key: idempotencyKey }),
  result: okItem(z.strictObject({ title: z.string() })),
  owner: "#2",
});

// 成功の item が形に無い鍵を除く（z.object）読む操作
const notesPeek = defineOperation({
  name: "notes.peek",
  features: ["F3"],
  access: "read",
  delegationKind: "read",
  auditKeys: ["project_id"],
  item: z.strictObject({ project_id: project }),
  result: okItem(z.object({ title: z.string() })),
  owner: "#2",
});

export const DISPATCH_OPERATIONS = [notesGet, notesCreate, notesRename, notesImport, notesPurge, sessionsCreate, sessionsDelete, loginsDelete, notesBulk, notesPeek];

type Note = { project_id: string; title: string; version?: number };

const noteKey = (item: Note) => ({ pk: `PROJECT#${item.project_id}`, sk: `NOTE#${item.title}` });

export const NOTE_KEY = (projectId: string) => ({ pk: `PROJECT#${projectId}`, sk: "NOTE" });

// notes.rename が置き換えた行に書く作り物の行の世代
export const NOTE_INCARNATION = "5b9e2c4a-7d1f-4e3b-8a6c-0f2d4e6a8b1c";

const putNote: Handler = async (item) => {
  const note = item as Note;
  return { result: { ok: true, item: { title: note.title } }, writes: [putIfAbsent({ table: "sprints", item: { ...noteKey(note), schema_version: 1, version: 1, title: note.title }, onConflict: "state_mismatch" })] };
};

export const noteHandlers: Record<string, Handler> = {
  async "notes.get"(item) {
    const note = item as Note;
    return { result: { ok: true, item: { project_id: note.project_id, title: "acme" } }, writes: [] };
  },
  "notes.create": putNote,
  async "notes.rename"(item) {
    const note = item as Note;
    return {
      result: { ok: true, item: { title: note.title } },
      // 要素が持つ読んだ版を条件にした行全体の置き換え。作り物の行は incarnation を持たない（U3b より前の行と同じく absent を条件にする）
      writes: [
        replaceIfVersion({
          table: "sprints",
          item: { ...NOTE_KEY(note.project_id), schema_version: 1, title: note.title },
          version: note.version ?? 1,
          incarnation: NOTE_INCARNATION,
          expect: { version: { kind: "value", value: note.version ?? 1 }, incarnation: { kind: "absent" } },
          onConflict: "version_mismatch",
        }),
      ],
    };
  },
  "notes.import": putNote,
  "notes.bulk": putNote,
  async "notes.peek"() {
    return { result: { ok: true, item: { title: "acme", secret_column: "internal" } }, writes: [] };
  },
  async "notes.purge"(item) {
    const note = item as Note;
    return { result: { ok: true, item: { project_id: note.project_id } }, writes: [] };
  },
  // 既にある利用者のサインインし直し: 状態を書かない（記録の行と冪等の鍵の済みの行だけ）
  async "sessions.create"(_item, ctx) {
    const userId = ctx.principal.kind === "human" ? ctx.principal.userId : "usr_01890a5d-ac96-774b-bcce-0000000000ff";
    return { result: { ok: true, item: { user_id: userId } }, writes: [] };
  },
  async "sessions.delete"(_item, ctx) {
    return { result: { ok: true, item: { revoked_at: ctx.sessionRevokedAt ?? ctx.clock.iso() } }, writes: [] };
  },
  // 外す行の有無は、冪等の鍵の照合の後に強い整合で読んで照らす
  async "logins.delete"(item, ctx) {
    const sub = (item as { cognito_sub: string }).cognito_sub;
    const key = { pk: `COGNITO#${sub}`, sk: "COGNITO" };
    const row = await ctx.db.get("users", key, true);
    if (row === null) return { result: { ok: false, status: 404, reason: "not_found" }, writes: [] };
    return {
      result: { ok: true, item: { cognito_sub: sub } },
      writes: [{ table: "users", op: "delete", key, condition: cond.exists("pk"), onConflict: "state_mismatch" }],
    };
  },
};
