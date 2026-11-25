import { z } from "zod";
import { idOf } from "../../src/ids.ts";
import { defineOperation, okItem, okList } from "../../src/operation.ts";
import { githubRepo, languageTag, money, timeZone, utcDateTime } from "../../src/values.ts";

// 往復のテスト用の操作。本番の操作と同じ defineOperation で組み、形の正本の値の形を 1 か所でまとめて往復させる。
// 生成物のファイルには書かない（詳細設計の「往復のテスト用の操作」）

export const FIXTURE_CREATE = defineOperation({
  name: "fixture_notes.create",
  features: ["F1"],
  access: "write",
  delegationKind: "run",
  idempotencyKey: true,
  allOrNothing: { maxItems: 2 },
  item: z.strictObject({
    project_id: idOf("prj"),
    title: z.string().min(1).max(200),
    due_at: utcDateTime,
    budget: money,
    language: languageTag,
    time_zone: timeZone,
    repo: githubRepo,
  }),
  result: okItem(z.strictObject({ note_id: idOf("ntc"), version: z.int().min(1), created_at: utcDateTime })),
  reasons: [{ code: "fixture_limit", status: 409, when: "always" }],
  owner: "#2",
});

export const FIXTURE_LIST = defineOperation({
  name: "fixture_notes.list",
  features: ["F1"],
  access: "read",
  delegationKind: "read",
  item: z.strictObject({ project_id: idOf("prj"), cursor: z.string().nullable() }),
  result: okList(z.strictObject({ note_id: idOf("ntc"), title: z.string().min(1).max(200), due_at: utcDateTime })),
  owner: "#2",
});

export const FIXTURE_OPERATIONS = [FIXTURE_CREATE, FIXTURE_LIST] as const;
