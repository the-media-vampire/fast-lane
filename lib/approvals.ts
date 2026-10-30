import { db, id, json, now } from "./db";
import { getProject, pictureMatches } from "./repo";
import { shotStates, shotsDoc, type ShotState } from "./state";

/**
 * Creative sign-off, kept separate from permission to spend. "Approve sequence for
 * production" records, per shot, exactly which storyboard and blocking were approved. A later
 * change reopens approval only for the shots it touched.
 */

export type ApprovalKind = "sequence" | "asset" | "animatic" | "final";
type ApprovalRow = { id: string; project_id: string; kind: ApprovalKind; target: string | null; fingerprint: string; reviewer: string | null; note: string | null; created_at: string };

export type ShotPrint = { rev: number; pictureKey: string; storyboardId: string | null; sceneId?: string | null };

export function shotPrint(s: ShotState): ShotPrint {
  return { rev: s.shot.rev, pictureKey: s.scene?.pictureKey ?? "", storyboardId: s.storyboard?.id ?? null, sceneId: s.scene?.id ?? null };
}

/** Approved as it is now: same shot, same frame, and the same picture (a re-timing alone doesn't reopen it). */
function samePrint(a: ShotPrint | undefined, b: ShotPrint, s: ShotState) {
  if (!a || a.rev !== b.rev || a.storyboardId !== b.storyboardId) return false;
  return a.pictureKey === b.pictureKey || (!!s.scene && pictureMatches(a.pictureKey, a.sceneId, s.scene));
}

export function reviewerOf(projectId: string): string | null {
  return getProject(projectId)?.reviewer ?? null;
}

function record(projectId: string, kind: ApprovalKind, target: string | null, fingerprint: unknown, note?: string) {
  db()
    .prepare("insert into approvals (id, project_id, kind, target, fingerprint, reviewer, note, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id("apr"), projectId, kind, target, JSON.stringify(fingerprint), reviewerOf(projectId), note ?? null, now());
  db().prepare("update projects set rev = rev + 1 where id = ?").run(projectId);
}

function latest(projectId: string, kind: ApprovalKind, target?: string | null): ApprovalRow | null {
  const row = target === undefined
    ? db().prepare("select * from approvals where project_id = ? and kind = ? order by created_at desc limit 1").get(projectId, kind)
    : db().prepare("select * from approvals where project_id = ? and kind = ? and target is ? order by created_at desc limit 1").get(projectId, kind, target);
  return (row as ApprovalRow | undefined) ?? null;
}

/* ---------------- the sequence ---------------- */

export type SequenceStatus = {
  approvedAt: string | null;
  reviewer: string | null;
  /** Per shot: approved as it is now, changed since approval, or never approved. */
  shots: Record<string, "approved" | "changed" | "new">;
  allApproved: boolean;
  changed: string[];
  /** Why the sequence can't be approved yet (frames missing, drawing, outdated). */
  blockers: string[];
};

export function sequenceStatus(projectId: string, states?: ShotState[]): SequenceStatus {
  const list = states ?? shotStates(projectId, shotsDoc(projectId)?.data.shots ?? []);
  const a = latest(projectId, "sequence");
  const prints = a ? json<Record<string, ShotPrint>>(a.fingerprint, {}) : {};
  const shots: SequenceStatus["shots"] = {};
  const changed: string[] = [];
  for (const s of list) {
    const now = shotPrint(s);
    if (!a || !prints[s.shot.id]) shots[s.shot.id] = "new";
    else if (samePrint(prints[s.shot.id], now, s) && s.storyboardCurrent) shots[s.shot.id] = "approved";
    else {
      shots[s.shot.id] = "changed";
      changed.push(s.shot.id);
    }
  }
  const blockers: string[] = [];
  const missing = list.filter((s) => !s.storyboard || s.storyboard.status === "failed").length;
  const drawing = list.filter((s) => s.storyboard?.status === "pending").length;
  const outdated = list.filter((s) => s.storyboard && s.storyboard.status === "ready" && !s.storyboardCurrent).length;
  if (!list.length) blockers.push("There are no shots yet.");
  if (missing) blockers.push(`${missing} shot${missing === 1 ? " has" : "s have"} no storyboard frame`);
  if (drawing) blockers.push(`${drawing} frame${drawing === 1 ? " is" : "s are"} still drawing`);
  if (outdated) blockers.push(`${outdated} frame${outdated === 1 ? " is" : "s are"} outdated`);
  return {
    approvedAt: a?.created_at ?? null,
    reviewer: a?.reviewer ?? null,
    shots,
    allApproved: !!list.length && list.every((s) => shots[s.shot.id] === "approved"),
    changed,
    blockers,
  };
}

/** The person approves every current storyboard and blocking for production. */
export function approveSequence(projectId: string, note?: string): { ok: boolean; summary: string } {
  const states = shotStates(projectId, shotsDoc(projectId)?.data.shots ?? []);
  const st = sequenceStatus(projectId, states);
  if (st.blockers.length) return { ok: false, summary: `Not yet: ${st.blockers.join(", ")}.` };
  const prints = Object.fromEntries(states.map((s) => [s.shot.id, shotPrint(s)]));
  record(projectId, "sequence", null, prints, note);
  return { ok: true, summary: `Sequence approved for production: ${states.length} shots.` };
}

/* ---------------- assets ---------------- */

export function approveAssetVersion(projectId: string, assetId: string, versionId: string) {
  db().prepare("update assets set approved_version_id = ?, kept_version_id = ? where id = ? and project_id = ?").run(versionId, versionId, assetId, projectId);
  record(projectId, "asset", assetId, { versionId });
}

/* ---------------- cuts ---------------- */

export function approveCut(projectId: string, cutId: string, kind: "animatic" | "final", fingerprint: unknown) {
  db().prepare("update cuts set acceptance = ?, accepted = 1, accepted_by = ?, accepted_at = ? where id = ? and project_id = ?").run(kind, reviewerOf(projectId), now(), cutId, projectId);
  record(projectId, kind, cutId, fingerprint);
}
