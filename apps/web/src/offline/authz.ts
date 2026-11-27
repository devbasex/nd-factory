// 見られるプロジェクトの記録の判定と作り直しと錠（#12 の設計書の「段 1 の後の表示の無効化」）。端末の保存は読まない

export type AuthzRecord = {
  generation: number;
  allowedProjectIds: string[];
  listedSeq: number;
  mismatchProjectIds: string[];
  mismatchSeq: number | null;
  allowedTeamIds?: string[];
  teamsSeq?: number;
  denied: { id: string; deniedSeq: number }[];
};

export type Target = { project: string } | { team: string };

// 記録との照合の表。上の行から順に当てる。hold は権限の喪失を確かめるまでの保留
export function judgeVisibility(record: AuthzRecord | null, target: Target, fetchSeq: number): "show" | "drop" | "hold" {
  if (record === null) return "show";
  const id = "project" in target ? target.project : target.team;
  if (record.denied.some((d) => d.id === id)) return "hold";
  const after = (seq: number) => (fetchSeq > seq ? "show" : "drop");
  if ("team" in target) {
    if (record.allowedTeamIds === undefined || record.allowedTeamIds.includes(id)) return "show";
    return after(record.teamsSeq ?? 0);
  }
  if (record.allowedProjectIds.includes(id)) return "show";
  if (record.mismatchProjectIds.includes(id)) return after(record.mismatchSeq ?? record.listedSeq);
  return after(record.listedSeq);
}

export type ListsRead = {
  projects: { id: string; teamId: string }[];
  // projects.list の 1 ページ目の前と、最後のページの後に取った番号
  projectsStartSeq: number;
  listedSeq: number;
  // teams.list が一時の失敗なら null
  teams: { ids: string[]; startSeq: number; endSeq: number } | null;
  // 両方の最後のページの後に取った番号
  mismatchSeq: number;
};

export function nextAuthz(prev: AuthzRecord | null, read: ListsRead): AuthzRecord {
  const { teams } = read;
  const mismatch = new Set(prev?.mismatchProjectIds);
  if (teams !== null) {
    for (const project of read.projects) {
      if (teams.ids.includes(project.teamId)) mismatch.delete(project.id);
      else mismatch.add(project.id);
    }
  }
  const allowed = read.projects.map((p) => p.id).filter((id) => !mismatch.has(id));
  // 403・404 より前に始めた読み出しの結果では除かない
  const confirmed = (d: { id: string; deniedSeq: number }) =>
    (allowed.includes(d.id) && read.projectsStartSeq > d.deniedSeq) ||
    (teams !== null && teams.ids.includes(d.id) && teams.startSeq > d.deniedSeq);
  return {
    generation: (prev?.generation ?? 0) + 1,
    allowedProjectIds: allowed,
    listedSeq: read.listedSeq,
    mismatchProjectIds: [...mismatch],
    mismatchSeq: mismatch.size === 0 ? null : teams === null ? read.listedSeq : read.mismatchSeq,
    allowedTeamIds: teams?.ids ?? prev?.allowedTeamIds,
    teamsSeq: teams?.endSeq ?? prev?.teamsSeq,
    denied: (prev?.denied ?? []).filter((d) => !confirmed(d)),
  };
}

export function addDenied(prev: AuthzRecord, id: string, deniedSeq: number): AuthzRecord {
  return {
    ...prev,
    generation: prev.generation + 1,
    denied: [...prev.denied.filter((d) => d.id !== id), { id, deniedSeq }],
  };
}

// 記録を書き換える側は exclusive、画面へ反映する側は shared。持つ間はほかの錠を取らず、ネットワークを待たない
export async function withAuthzLock<T>(mode: "shared" | "exclusive", fn: () => Promise<T>): Promise<T> {
  return await navigator.locks.request("nd-authz", { mode }, fn);
}
