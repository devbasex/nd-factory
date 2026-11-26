// 書き込みの操作の、つながっていないときの扱いの 3 つの区分（画面の文書の「操作の 3 つの区分」。#12 の決定 5）。
// 冪等キーを受けるかは操作の表が正で、ここには写さない

export type OperationClass =
  | { class: "queued"; resendableWithoutKey: boolean; keepsInput: boolean }
  | { class: "confirm"; check: readonly ("version" | "material_digest")[] }
  | { class: "online" };

const ONLINE: OperationClass = { class: "online" };
const CONFIRM: OperationClass = { class: "confirm", check: ["version"] };
const queued = (resendableWithoutKey: boolean, keepsInput: boolean): OperationClass => ({
  class: "queued",
  resendableWithoutKey,
  keepsInput,
});

/** @internal */
export const OPERATION_CLASSES: Record<string, OperationClass> = {
  "users.update": queued(true, true),
  "notices.mark_read": queued(true, false),
  "organizer_messages.create": queued(false, true),
  "organizer_messages.withdraw": queued(true, false),

  "approvals.answer": { class: "confirm", check: ["version", "material_digest"] },
  "questions.answer": CONFIRM,
  "sprints.cancel": CONFIRM,
  "project_transfers.create": CONFIRM,
  "project_transfers.accept": CONFIRM,
  "project_transfers.delete": CONFIRM,
  "projects.close": CONFIRM,

  "sessions.create": ONLINE,
  "sessions.delete": ONLINE,
  "login_links.create": ONLINE,
  "logins.create": ONLINE,
  "logins.delete": ONLINE,
  "teams.create": ONLINE,
  "teams.update": ONLINE,
  "seats.update": ONLINE,
  "seats.delete": ONLINE,
  "invitations.create": ONLINE,
  "invitations.accept": ONLINE,
  "invitations.delete": ONLINE,
  "projects.create": ONLINE,
  "projects.update": ONLINE,
  "github_installations.link": ONLINE,
  "repositories.add": ONLINE,
  "repositories.remove": ONLINE,
  "sprints.create": ONLINE,
  "notification_targets.authorize": ONLINE,
  "notification_targets.create": ONLINE,
  "notification_targets.test": ONLINE,
  "notification_targets.delete": ONLINE,
  "delegations.create": ONLINE,
  "delegations.revoke": ONLINE,
  "execution_settings.update": ONLINE,
  "model_keys.create": ONLINE,
  "model_keys.delete": ONLINE,
  "machines.create": ONLINE,
  "machines.delete": ONLINE,
  "spend_caps.update": ONLINE,
  "organizers.create": ONLINE,
  "organizers.close": ONLINE,
  "organizers.resume": ONLINE,
  "issue_requests.create": ONLINE,
};

// 表に無い操作は、つながっていないと押せない側に倒す
export function operationClassOf(operation: string): OperationClass {
  return Object.hasOwn(OPERATION_CLASSES, operation) ? OPERATION_CLASSES[operation]! : ONLINE;
}
