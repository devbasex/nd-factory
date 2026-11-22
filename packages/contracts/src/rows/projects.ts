import { z } from "zod";
import { repairIdentity, rowCodec } from "../row-codec.ts";
import { idOf } from "../ids.ts";
import { githubRepo, utcDateTime } from "../values.ts";
import { expireAt, identifier, overwriteRow, type RowKey, seqKey, versionlessRow } from "./common.ts";

// db-projects の行（プロジェクト・割り当て・リポジトリ・渡した GitHub の token の記録）。
// プロジェクトと割り当ては全体の設計（docs/design/data.md の「テーブル定義」）の列のまま

// 割り当ての行の ID。ID の頭の集まりに割り当ての頭が無いため、形を縛らない
const assignId = z.string().min(1);

// プロジェクト（PROJECT#<プロジェクト> / PROJECT）。上書き。全体の設計の「空」は列が無いことで表す（索引の鍵に空の文字列を置けない）
export const projectRow = overwriteRow(1, {
  project_id: idOf("prj"),
  name: z.string().min(1),
  current_team_id: idOf("team").optional(),
  current_assign_id: assignId.optional(),
  transfer_in_progress: idOf("trf").optional(),
  // 割り当てを移す途中の状態。項目は割り当ての移しを書く子（#5）が決めるため、知らない項目を落とさない
  transfer: z.looseObject({}).optional(),
  // 進行表の DB の状態（全体の設計の 無い・作成中・有る）。識別子の対応は進行表の DB を書く子が決める
  progress_db_state: identifier,
  progress_db_name: z.string().min(1).optional(),
  progress_db_role: z.string().min(1).optional(),
  progress_db_prep_id: z.string().min(1).optional(),
  progress_db_prep_task: z.string().min(1).optional(),
  progress_db_rotation_seq: z.int().min(0),
  progress_db_rotation_pending: z.boolean(),
  progress_db_rotation_attempts: z.int().min(0),
  progress_db_secret: z.string().min(1).optional(),
  gh_token_max_expiry: utcDateTime.optional(),
  gh_token_generation: z.int().min(0),
  created_at: utcDateTime,
});
export type ProjectRow = z.infer<typeof projectRow>;
export const projectKey = (row: ProjectRow): RowKey => ({ pk: `PROJECT#${row.project_id}`, sk: "PROJECT" });

// 割り当て（PROJECT#<プロジェクト> / ASSIGN#<確定の時刻>#<ID>）。追記だけ。
// project_id は表と鍵の決まり（プロジェクトに属する行は区切りの鍵の外でも project_id を持つ）で持つ
export const assignmentRow = versionlessRow(1, {
  assign_id: assignId,
  project_id: idOf("prj"),
  team_id: idOf("team").optional(),
  confirmed_by: idOf("usr"),
  accepted_by: idOf("usr").optional(),
  confirmed_at: utcDateTime,
});
export type AssignmentRow = z.infer<typeof assignmentRow>;
export const assignmentKey = (row: AssignmentRow): RowKey => ({ pk: `PROJECT#${row.project_id}`, sk: `ASSIGN#${row.confirmed_at}#${row.assign_id}` });

// リポジトリ（PROJECT#<プロジェクト> / REPO#<リポジトリ>）。上書き
export const repositoryRow = overwriteRow(1, {
  repo_id: idOf("repo"),
  project_id: idOf("prj"),
  github_repo: githubRepo,
  // GitHub の App の導入の ID（整数）
  installation_id: z.int().min(1),
  primary: z.boolean(),
  added_at: utcDateTime,
});
export type RepositoryRow = z.infer<typeof repositoryRow>;
export const repositoryKey = (row: RepositoryRow): RowKey => ({ pk: `PROJECT#${row.project_id}`, sk: `REPO#${row.repo_id}` });

// 渡した GitHub の token の記録（PROJECT#<プロジェクト> / GHTOKEN#<期限>#<レーン>#<連番>）。追記だけで、token の期限で TTL。
// 連番は記録を足したときのプロジェクトの行の gh_token_generation の値。token の値と識別は #33 の答えで足す
export const githubTokenRow = versionlessRow(1, {
  project_id: idOf("prj"),
  lane_id: idOf("lane"),
  generation: z.int().min(1),
  expires_at: utcDateTime,
  expire_at: expireAt,
});
export type GithubTokenRow = z.infer<typeof githubTokenRow>;
export const githubTokenKey = (row: GithubTokenRow): RowKey => ({
  pk: `PROJECT#${row.project_id}`,
  sk: `GHTOKEN#${row.expires_at}#${row.lane_id}#${seqKey(row.generation)}`,
});

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない。
// U3b より前の書き手が保存した行（incarnation と、U3b で足した version の無い行）を、旧形式の補い（repairIdentity）で読む
export const projectCodec = rowCodec({ latest: { version: 1, schema: projectRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: projectKey });
export const assignmentCodec = rowCodec({ latest: { version: 1, schema: assignmentRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: assignmentKey });
export const repositoryCodec = rowCodec({ latest: { version: 1, schema: repositoryRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: repositoryKey });
export const githubTokenCodec = rowCodec({ latest: { version: 1, schema: githubTokenRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: githubTokenKey });
