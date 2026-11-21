import type { z } from "zod";
import type { RowKey } from "../../src/rows/common.ts";
import { auditKey, auditRow } from "../../src/rows/audit.ts";
import { answerKey, answerRow, approvalKey, approvalRow, questionKey, questionRow } from "../../src/rows/decisions.ts";
import { progressEventKey, progressEventRow } from "../../src/rows/events.ts";
import { idempotencyKey, idempotencyRow } from "../../src/rows/idempotency.ts";
import { destinationKey, destinationRow, noticeKey, noticeRow } from "../../src/rows/notices.ts";
import { assignmentKey, assignmentRow, githubTokenKey, githubTokenRow, projectKey, projectRow, repositoryKey, repositoryRow } from "../../src/rows/projects.ts";
import { laneKey, laneRow, segmentIdOf, segmentKey, segmentRow, sprintKey, sprintRow } from "../../src/rows/sprints.ts";
import { invitationKey, invitationRow, machineKey, machineRow, seatKey, seatRow, teamKey, teamRow, usageMonthKey, usageMonthRow } from "../../src/rows/teams.ts";
import { costRecordKey, costRecordRow } from "../../src/rows/usage.ts";
import { cognitoSubjectKey, cognitoSubjectRow, delegationKey, delegationRow, loginKey, loginRow, loginSubjectKey, loginSubjectRow, userKey, userRow } from "../../src/rows/users.ts";

// 行の種類ごとの作り物の行（空を許す列を欠いた最小の行）。値は作り物だけ

export const id = (kind: string, n: number): string => `${kind}_01935b4e-7c2a-7d10-8f3e-${n.toString(16).padStart(12, "0")}`;

export const AT = "2026-11-17T03:04:05.123Z";
const SHA = "a".repeat(64);
const UUID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

export const USR = id("usr", 1);
export const TEAM = id("team", 2);
export const PRJ = id("prj", 3);
export const SPR = id("spr", 4);
export const LANE = id("lane", 5);
export const APR = id("apr", 6);

export type RowCase = {
  readonly schema: z.ZodType;
  readonly keyOf: (row: never) => RowKey;
  // 上書きの行（version を持つ）か
  readonly overwrite: boolean;
  readonly sample: Readonly<Record<string, unknown>>;
};

export const ROW_CASES: Readonly<Record<string, RowCase>> = {
  user: { schema: userRow, keyOf: userKey, overwrite: true, sample: { schema_version: 1, version: 1, user_id: USR, display_name: "acme の人", created_at: AT } },
  login: { schema: loginRow, keyOf: loginKey, overwrite: false, sample: { schema_version: 1, user_id: USR, idp: "google", subject: "1234567890", linked_at: AT } },
  login_subject: { schema: loginSubjectRow, keyOf: loginSubjectKey, overwrite: false, sample: { schema_version: 1, user_id: USR, idp: "github", subject: "42" } },
  cognito_subject: { schema: cognitoSubjectRow, keyOf: cognitoSubjectKey, overwrite: false, sample: { schema_version: 1, cognito_sub: UUID, user_id: USR, idp: "github", subject: "42" } },
  delegation: {
    schema: delegationRow,
    keyOf: delegationKey,
    overwrite: true,
    sample: {
      schema_version: 1,
      version: 1,
      delegation_id: id("dlg", 7),
      user_id: USR,
      client_name: "acme-cli",
      scope_project_ids: [PRJ],
      scope_kind: "run",
      secret_sha256: SHA,
      expires_at: AT,
      created_at: AT,
    },
  },
  team: {
    schema: teamRow,
    keyOf: teamKey,
    overwrite: true,
    sample: { schema_version: 1, version: 1, team_id: TEAM, name: "acme", plan: "unlimited", currency: "JPY", default_place: "hosted", default_inference: "managed", created_at: AT },
  },
  seat: { schema: seatRow, keyOf: seatKey, overwrite: true, sample: { schema_version: 1, version: 1, team_id: TEAM, user_id: USR, role: "owner", added_at: AT } },
  invitation: {
    schema: invitationRow,
    keyOf: invitationKey,
    overwrite: true,
    sample: { schema_version: 1, version: 1, invitation_id: id("inv", 8), team_id: TEAM, role: "member", created_by: USR, created_at: AT, expires_at: AT },
  },
  machine: {
    schema: machineRow,
    keyOf: machineKey,
    overwrite: true,
    sample: { schema_version: 1, version: 1, machine_id: id("mch", 9), team_id: TEAM, name: "acme-mac", token_sha256: SHA, token_expires_at: AT, created_at: AT },
  },
  usage_month: {
    schema: usageMonthRow,
    keyOf: usageMonthKey,
    overwrite: true,
    sample: { schema_version: 1, version: 1, team_id: TEAM, month: "2026-11", used_amount_minor: 1200, used_currency: "JPY" },
  },
  project: {
    schema: projectRow,
    keyOf: projectKey,
    overwrite: true,
    sample: {
      schema_version: 1,
      version: 1,
      project_id: PRJ,
      name: "acme-app",
      progress_db_state: "absent",
      progress_db_rotation_seq: 0,
      progress_db_rotation_pending: false,
      progress_db_rotation_attempts: 0,
      gh_token_generation: 0,
      created_at: AT,
    },
  },
  assignment: { schema: assignmentRow, keyOf: assignmentKey, overwrite: false, sample: { schema_version: 1, assign_id: "asg-1", project_id: PRJ, team_id: TEAM, confirmed_by: USR, confirmed_at: AT } },
  repository: {
    schema: repositoryRow,
    keyOf: repositoryKey,
    overwrite: true,
    sample: { schema_version: 1, version: 1, repo_id: id("repo", 10), project_id: PRJ, github_repo: "acme/app", installation_id: 1, primary: true, added_at: AT },
  },
  github_token: { schema: githubTokenRow, keyOf: githubTokenKey, overwrite: false, sample: { schema_version: 1, project_id: PRJ, lane_id: LANE, generation: 1, expires_at: AT, expire_at: 1795000000 } },
  sprint: {
    schema: sprintRow,
    keyOf: sprintKey,
    overwrite: true,
    sample: {
      schema_version: 1,
      version: 1,
      sprint_id: SPR,
      project_id: PRJ,
      title: "acme の課題",
      issues: ["acme/app#1"],
      place: "hosted",
      inference: "managed",
      state: "running",
      started_by: USR,
      started_at: AT,
    },
  },
  lane: {
    schema: laneRow,
    keyOf: laneKey,
    overwrite: true,
    sample: {
      schema_version: 1,
      version: 1,
      lane_id: LANE,
      project_id: PRJ,
      sprint_id: SPR,
      repo_id: id("repo", 10),
      after: [],
      place: "hosted",
      inference: "managed",
      generation: 0,
      state: "waiting",
      last_seq: 0,
    },
  },
  segment: { schema: segmentRow, keyOf: segmentKey, overwrite: true, sample: { schema_version: 1, version: 1, project_id: PRJ, sprint_id: SPR, lane_id: LANE, seq: 1, started_at: AT } },
  progress_event: {
    schema: progressEventRow,
    keyOf: progressEventKey,
    overwrite: false,
    sample: { schema_version: 1, project_id: PRJ, lane_id: LANE, seq: 1, generation: 1, kind: "segment_started", occurred_at: AT, body: {} },
  },
  approval: {
    schema: approvalRow,
    keyOf: approvalKey,
    overwrite: true,
    sample: { schema_version: 1, version: 1, approval_id: APR, project_id: PRJ, sprint_id: SPR, lane_id: LANE, gate: "design", material_digest: SHA, state: "waiting", waiting_since: AT },
  },
  question: {
    schema: questionRow,
    keyOf: questionKey,
    overwrite: true,
    sample: {
      schema_version: 1,
      version: 1,
      question_id: id("qst", 11),
      project_id: PRJ,
      sprint_id: SPR,
      lane_id: LANE,
      category: "ndf-ask:human-action",
      human_only: true,
      state: "waiting",
      body: "acme の確認",
    },
  },
  answer: {
    schema: answerRow,
    keyOf: answerKey,
    overwrite: false,
    sample: { schema_version: 1, answer_id: UUID, project_id: PRJ, parent_id: APR, word: "approved", answered_by: { kind: "human", user_id: USR }, answered_at: AT },
  },
  notice: {
    schema: noticeRow,
    keyOf: noticeKey,
    overwrite: true,
    sample: { schema_version: 1, version: 1, notice_id: id("ntc", 12), user_id: USR, project_id: PRJ, kind: "approval", target_id: APR, occurred_at: AT, deliveries: {} },
  },
  destination: {
    schema: destinationRow,
    keyOf: destinationKey,
    overwrite: true,
    sample: {
      schema_version: 1,
      version: 1,
      destination_id: id("dst", 13),
      user_id: USR,
      kind: "web_push",
      secret_name: "acme/dest",
      fingerprint: SHA,
      last4: "abcd",
      state: "active",
      created_at: AT,
    },
  },
  cost_record: {
    schema: costRecordRow,
    keyOf: costRecordKey,
    overwrite: false,
    sample: {
      schema_version: 1,
      project_id: PRJ,
      sprint_id: SPR,
      lane_id: LANE,
      segment_id: segmentIdOf(LANE, 1),
      kind: "compute",
      quantity: [{ unit: "seconds", value: 60 }],
      amount: { amount_minor: 0, currency: "JPY" },
      occurred_at: AT,
    },
  },
  audit: {
    schema: auditRow,
    keyOf: auditKey,
    overwrite: false,
    sample: {
      schema_version: 1,
      audit_id: id("aud", 14),
      request_id: "req-1",
      at: AT,
      actor: { kind: "human", user_id: USR },
      channel: "screen",
      operation: "sprints.create",
      target_ids: [SPR],
      result: { outcome: "ok", status: 200, reasons: [] },
      expire_at: 1795000000,
    },
  },
  idempotency: {
    schema: idempotencyRow,
    keyOf: idempotencyKey,
    overwrite: false,
    sample: {
      schema_version: 1,
      principal_key: `usr#${USR}`,
      operation: "sprints.create",
      key: UUID,
      fingerprint: SHA,
      state: "leased",
      owner_request_id: "req-1",
      lease_until: AT,
      expire_at: 1795000000,
    },
  },
};
