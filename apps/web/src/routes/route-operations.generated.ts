// 画面の文書の「画面一覧」の表から scripts/build-route-operations.ts が作る。手で直さない

export const ROUTE_OPERATIONS = {
  R1: ["sessions.create"],
  R2: ["organizers.list", "organizers.create", "organizers.close", "organizers.resume", "organizer_messages.list", "organizer_messages.create", "organizer_messages.withdraw", "waiting_counts.get", "teams.list", "projects.list"],
  R3: ["projects.get", "sprints.list"],
  R4: ["issue_candidates.list", "usage.get", "execution_settings.get", "sprints.create"],
  R5: ["sprints.get", "lanes.list", "progress_events.list", "usage_records.list", "approvals.list", "questions.list", "sprints.cancel"],
  R6: ["approvals.get", "approvals.answer", "notices.mark_read"],
  R7: ["questions.get", "questions.answer", "notices.mark_read"],
  R8: ["projects.get", "projects.update", "repositories.list", "repositories.add", "repositories.remove", "github_installations.list", "project_transfers.list", "project_transfers.create", "project_transfers.delete", "projects.close"],
  R9: ["teams.get", "teams.update", "teams.create", "seats.list", "seats.update", "seats.delete", "invitations.list", "invitations.create", "invitations.delete", "invitations.accept", "projects.list", "project_transfers.list", "project_transfers.accept"],
  R10: ["github_installations.list", "github_installations.link", "projects.create"],
  R11: ["execution_settings.get", "execution_settings.update", "model_keys.list", "model_keys.create", "model_keys.delete", "machines.list", "machines.create", "machines.delete"],
  R12: ["usage.get", "usage_records.list", "spend_caps.update"],
  R13: ["audit_records.list"],
  R14: ["users.get", "users.update", "login_links.create", "logins.create", "logins.delete", "notification_targets.list", "notification_targets.authorize", "notification_targets.create", "notification_targets.test", "notification_targets.delete", "delegations.list", "delegations.create", "delegations.revoke", "sessions.delete"],
  R15: ["organizers.get", "organizer_messages.list", "organizer_messages.create", "organizer_messages.withdraw", "organizers.close", "organizers.resume", "notices.mark_read"],
  R16: ["organizers.list", "approvals.list", "questions.list", "sprints.list", "waiting_counts.get", "notices.list", "notices.mark_read"],
} as const;
