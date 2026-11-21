import type { AnyRowCodec } from "./row-codec.ts";
import { answerCodec, approvalCodec, questionCodec } from "./rows/decisions.ts";
import { assignmentCodec, githubTokenCodec, projectCodec, repositoryCodec } from "./rows/projects.ts";
import { auditCodec } from "./rows/audit.ts";
import { costRecordCodec } from "./rows/usage.ts";
import { cognitoSubjectCodec, delegationCodec, loginCodec, loginLinkCodec, loginSubjectCodec, sessionRevocationCodec, userCodec } from "./rows/users.ts";
import { destinationCodec, noticeCodec } from "./rows/notices.ts";
import { idempotencyCodec } from "./rows/idempotency.ts";
import { invitationCodec, machineCodec, seatCodec, teamCodec, usageMonthCodec } from "./rows/teams.ts";
import { laneCodec, segmentCodec, sprintCodec } from "./rows/sprints.ts";
import { progressEventCodec } from "./rows/events.ts";
import { TTL_ATTRIBUTE } from "./rows/common.ts";

// サービスの 10 の表の仕様（docs/design/data.md の「表と鍵」、issues/issue-2-design-detail.md の「サービスの表」、決定 8）。
// infra の ServiceTable がこの仕様から表と索引を作る。表の名前は <prefix>-<environment>-<suffix>

export const TABLE_PURPOSES = ["users", "teams", "projects", "sprints", "events", "decisions", "notices", "usage", "audit", "idempotency"] as const;

export type TablePurpose = (typeof TABLE_PURPOSES)[number];

// 行の書き方。上書き（version で照らす）・追記だけ・作ると消すだけ・借りから済みへ 1 回だけ書き換える・
// 状態を条件に決まった向きへだけ書き換える（version を持たない。ログインをつなぐ流れの open → verified → used）
export type RowWrites = "overwrite" | "append" | "create_delete" | "settle_once" | "advance_state";

// 索引。鍵は元の行の列そのもので、索引のための写しの列を持たない。どの索引も結果整合で、候補を出すだけに使う（決定 14）
export type IndexSpec = {
  readonly name: string;
  readonly partitionKey: string;
  readonly sortKey: string;
  // 鍵のほかに写す列
  readonly projection: readonly string[];
};

// 行の種類。skPattern は並びの鍵で行の種類を決める正規表現（区切りの鍵だけの表は null）で、上から当てて最初に当たったものを使う
export type RowSpec = {
  readonly name: string;
  readonly skPattern: RegExp | null;
  readonly codec: AnyRowCodec;
  readonly writes: RowWrites;
};

export type TableSpec = {
  readonly purpose: TablePurpose;
  readonly suffix: string;
  readonly partitionKey: "pk";
  readonly sortKey: "sk" | null;
  readonly ttlAttribute: typeof TTL_ATTRIBUTE | null;
  readonly indexes: readonly IndexSpec[];
  readonly rows: readonly RowSpec[];
};

export class TableSpecError extends Error {
  override name = "TableSpecError";
}

function noDuplicates(what: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TableSpecError(`${what}が重なる: ${value}`);
    seen.add(value);
  }
}

// 表の仕様を照らして目的ごとの表にする。名前の末尾・索引の名前・行の種類の名前の重なりと、並びの鍵の有無と行の種類の食い違いで投げる
export function defineTables(specs: readonly TableSpec[]): Readonly<Record<TablePurpose, TableSpec>> {
  noDuplicates("表の目的", specs.map((s) => s.purpose));
  noDuplicates("表の名前の末尾", specs.map((s) => s.suffix));
  noDuplicates("索引の名前", specs.flatMap((s) => s.indexes.map((i) => i.name)));
  noDuplicates("行の種類の名前", specs.flatMap((s) => s.rows.map((r) => r.name)));
  for (const spec of specs) {
    if (spec.rows.length === 0) throw new TableSpecError(`${spec.purpose} に行の種類が無い`);
    for (const row of spec.rows) {
      if ((spec.sortKey === null) !== (row.skPattern === null)) throw new TableSpecError(`${spec.purpose} の ${row.name} の skPattern が並びの鍵の有無と合わない`);
    }
    if (spec.sortKey === null && spec.rows.length !== 1) throw new TableSpecError(`${spec.purpose} は並びの鍵が無く、行の種類は 1 つだけ`);
  }
  const missing = TABLE_PURPOSES.filter((p) => !specs.some((s) => s.purpose === p));
  if (missing.length > 0) throw new TableSpecError(`表の仕様が無い: ${missing.join(", ")}`);
  return Object.fromEntries(specs.map((s) => [s.purpose, s])) as Record<TablePurpose, TableSpec>;
}

const ID = "[^#]+";

function table(purpose: TablePurpose, opts: { sortKey?: boolean; ttl?: boolean; indexes?: readonly IndexSpec[]; rows: readonly RowSpec[] }): TableSpec {
  return {
    purpose,
    suffix: `db-${purpose}`,
    partitionKey: "pk",
    sortKey: opts.sortKey === false ? null : "sk",
    ttlAttribute: opts.ttl === true ? TTL_ATTRIBUTE : null,
    indexes: opts.indexes ?? [],
    rows: opts.rows,
  };
}

export const TABLES = defineTables([
  table("users", {
    // ログインをつなぐ流れの行とセッションの取り消しの行が TTL で消える
    ttl: true,
    rows: [
      { name: "user", skPattern: /^USER$/, codec: userCodec, writes: "overwrite" },
      { name: "login_subject", skPattern: /^LOGIN$/, codec: loginSubjectCodec, writes: "create_delete" },
      { name: "cognito_subject", skPattern: /^COGNITO$/, codec: cognitoSubjectCodec, writes: "overwrite" },
      { name: "session_revocation", skPattern: new RegExp(`^REVOKED#${ID}$`), codec: sessionRevocationCodec, writes: "append" },
      { name: "login_link", skPattern: new RegExp(`^LINK#${ID}$`), codec: loginLinkCodec, writes: "advance_state" },
      { name: "login", skPattern: new RegExp(`^LOGIN#${ID}#.+$`), codec: loginCodec, writes: "create_delete" },
      { name: "delegation", skPattern: new RegExp(`^DELEGATION#${ID}$`), codec: delegationCodec, writes: "overwrite" },
    ],
  }),
  table("teams", {
    // 主体が席を持つチームの候補（ScopeReader.seatsOf）。db-teams で user_id の列を持つのは席の行だけ
    indexes: [{ name: "user-seats", partitionKey: "user_id", sortKey: "team_id", projection: ["role"] }],
    rows: [
      { name: "team", skPattern: /^TEAM$/, codec: teamCodec, writes: "overwrite" },
      { name: "seat", skPattern: new RegExp(`^SEAT#${ID}$`), codec: seatCodec, writes: "overwrite" },
      { name: "invitation", skPattern: new RegExp(`^INVITE#${ID}$`), codec: invitationCodec, writes: "overwrite" },
      { name: "machine", skPattern: new RegExp(`^MACHINE#${ID}$`), codec: machineCodec, writes: "overwrite" },
      { name: "usage_month", skPattern: /^USAGE#\d{4}-\d{2}$/, codec: usageMonthCodec, writes: "overwrite" },
    ],
  }),
  table("projects", {
    ttl: true,
    // チームに今割り当てたプロジェクトの候補（projectsOfTeams）。current_team_id のあるプロジェクトの行だけが載る
    indexes: [{ name: "team-projects", partitionKey: "current_team_id", sortKey: "project_id", projection: ["name", "current_assign_id"] }],
    rows: [
      { name: "project", skPattern: /^PROJECT$/, codec: projectCodec, writes: "overwrite" },
      { name: "repository", skPattern: new RegExp(`^REPO#${ID}$`), codec: repositoryCodec, writes: "overwrite" },
      { name: "assignment", skPattern: new RegExp(`^ASSIGN#${ID}#${ID}$`), codec: assignmentCodec, writes: "append" },
      { name: "github_token", skPattern: new RegExp(`^GHTOKEN#${ID}#${ID}#\\d+$`), codec: githubTokenCodec, writes: "append" },
    ],
  }),
  table("sprints", {
    rows: [
      { name: "segment", skPattern: new RegExp(`^SPRINT#${ID}#LANE#${ID}#SEG#\\d+$`), codec: segmentCodec, writes: "overwrite" },
      { name: "lane", skPattern: new RegExp(`^SPRINT#${ID}#LANE#${ID}$`), codec: laneCodec, writes: "overwrite" },
      { name: "sprint", skPattern: new RegExp(`^SPRINT#${ID}$`), codec: sprintCodec, writes: "overwrite" },
    ],
  }),
  table("events", {
    rows: [{ name: "progress_event", skPattern: /^SEQ#\d+$/, codec: progressEventCodec, writes: "append" }],
  }),
  table("decisions", {
    // 見えるプロジェクトの待っているもの。古い順。waiting_since のある依頼と問いだけが載る（答えの行は持たない）
    indexes: [{ name: "waiting", partitionKey: "project_id", sortKey: "waiting_since", projection: ["sprint_id", "lane_id", "gate", "category"] }],
    rows: [
      { name: "answer", skPattern: new RegExp(`^(APPROVAL|QUESTION)#${ID}#ANSWER#${ID}$`), codec: answerCodec, writes: "append" },
      { name: "approval", skPattern: new RegExp(`^APPROVAL#${ID}$`), codec: approvalCodec, writes: "overwrite" },
      { name: "question", skPattern: new RegExp(`^QUESTION#${ID}$`), codec: questionCodec, writes: "overwrite" },
    ],
  }),
  table("notices", {
    rows: [
      { name: "notice", skPattern: new RegExp(`^NOTICE#${ID}#${ID}$`), codec: noticeCodec, writes: "overwrite" },
      { name: "destination", skPattern: new RegExp(`^DEST#${ID}$`), codec: destinationCodec, writes: "overwrite" },
    ],
  }),
  table("usage", {
    rows: [{ name: "cost_record", skPattern: /^COST#.+$/, codec: costRecordCodec, writes: "append" }],
  }),
  table("audit", {
    ttl: true,
    rows: [{ name: "audit", skPattern: /^\d{4}-\d{2}-\d{2}T.+$/, codec: auditCodec, writes: "append" }],
  }),
  table("idempotency", {
    sortKey: false,
    ttl: true,
    rows: [{ name: "idempotency", skPattern: null, codec: idempotencyCodec, writes: "settle_once" }],
  }),
]);

// 行の種類の名前から RowCodec を引く
export const ROW_CODECS: Readonly<Record<string, AnyRowCodec>> = Object.fromEntries(Object.values(TABLES).flatMap((t) => t.rows.map((r) => [r.name, r.codec])));
