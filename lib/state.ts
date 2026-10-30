import { db, json } from "./db";
import { getJob, jobOutput, type JobRow } from "./jobs";
import {
  assetData,
  effectiveVersion,
  frameInputs,
  getProject,
  latestDoc,
  latestFrame,
  latestScene,
  listAssets,
  pictureMatches,
  takeInputs,
  takesForShot,
  type AssetRow,
  type AssetVersionRow,
  type Doc,
  type FrameRow,
  type ProjectRow,
  type SceneDoc,
  type TakeRow,
} from "./repo";
import type { AssetData, Brief, Concept, ConceptSet, Plan, Shot, ShotList } from "./types";
import { CLIP_MAX_SECONDS, CLIP_MIN_SECONDS } from "./adapters/contract";

/**
 * Read-side rules: what is current, what is outdated, and what a shot will play. An upstream
 * change only ever marks dependent outputs outdated; it never deletes or un-accepts them.
 */

export type Pipeline = {
  /** Brief interpreted → three directions proposed. */
  concepts?: boolean;
  /** Direction chosen → plan, assets, shots, blocking, storyboards (stops at the preview). */
  develop?: boolean;
  /** Preview approved and paid run confirmed → takes, sound, assembly (stops at the cut). */
  produce?: boolean;
  /** The authorization production spends under (the person's approved quote). */
  produceAuth?: string | null;
  /** The shots that production run covers. */
  produceShots?: string[] | null;
  /** Shots that used up their repairs without a usable take: a person's call. */
  attention?: string[] | null;
  /** Why forward motion stopped (an approval ran out, spending is off). */
  paused?: { code: string; reason: string; phase: string; needCents?: number } | null;
  /** Frames to draw as soon as their shot's capture is ready (a new shot, or a redraw asked for mid-render). */
  drawShots?: (string | { id: string; note?: string | null })[] | null;
  /** Plan version the asset list was made for. */
  assetsForPlan?: number;
  /** An explicitly approved story being developed; absent for existing legacy runs. */
  storyKey?: string;
};

export function pipelineOf(p: ProjectRow): Pipeline {
  return json<Pipeline>(p.pipeline, {});
}

export function setPipeline(projectId: string, patch: Partial<Pipeline>) {
  const p = getProject(projectId);
  if (!p) return;
  const next = { ...pipelineOf(p), ...patch };
  db().prepare("update projects set pipeline = ?, rev = rev + 1 where id = ?").run(JSON.stringify(next), projectId);
}

/* ---------------- documents ---------------- */

export const briefDoc = (pid: string) => latestDoc<Brief>(pid, "brief");
export const conceptsDoc = (pid: string) => latestDoc<ConceptSet>(pid, "concepts");
export const planDoc = (pid: string) => latestDoc<Plan>(pid, "plan");
export const shotsDoc = (pid: string) => latestDoc<ShotList>(pid, "shots");

export function chosenConcept(pid: string): Concept | null {
  const c = conceptsDoc(pid);
  if (!c?.data.chosenId) return null;
  return c.data.concepts.find((k) => k.id === c.data.chosenId) ?? null;
}

/** A brief is "interpreted" once the agent has filled purpose/audience; the opening only stores the idea. */
export function briefInterpreted(b: Doc<Brief> | null): boolean {
  return !!b && !!b.data.purpose;
}

/* ---------------- assets ---------------- */

export type AssetIdentity = { asset: AssetRow; data: AssetData; version: AssetVersionRow | null; mediaId: string | null };

export function assetIdentities(pid: string): AssetIdentity[] {
  return listAssets(pid).map((asset) => {
    const version = effectiveVersion(asset);
    return { asset, data: assetData(asset), version, mediaId: version?.status === "ready" ? version.media_id : null };
  });
}

export function shotAssetIds(shot: Shot): string[] {
  return [shot.locationId, ...shot.characterIds, ...shot.propIds].filter((x): x is string => !!x);
}

/** Asset id → version id each shot currently depends on. */
export function identityMap(identities: AssetIdentity[], ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const v = identities.find((i) => i.asset.id === id)?.version;
    if (v) out[id] = v.id;
  }
  return out;
}

/* ---------------- shots ---------------- */

export function clipSeconds(shotDuration: number): number {
  return Math.min(CLIP_MAX_SECONDS, Math.max(CLIP_MIN_SECONDS, Math.ceil(shotDuration)));
}

export type ShotState = {
  shot: Shot;
  start: number;
  scene: SceneDoc | null;
  capture: FrameRow | null;
  captureCurrent: boolean;
  storyboard: FrameRow | null;
  storyboardCurrent: boolean;
  /** Why the storyboard is outdated, in plain words. */
  storyboardReasons: string[];
  takes: (TakeRow & { current: boolean; seconds: number })[];
  /** What the cut will play for this slot. */
  pick: { kind: "take"; take: TakeRow } | { kind: "storyboard"; frame: FrameRow } | { kind: "capture"; frame: FrameRow } | null;
  pendingTake: TakeRow | null;
  needsTake: boolean;
};

export function shotStates(pid: string, shots: Shot[], identities = assetIdentities(pid)): ShotState[] {
  let start = 0;
  return shots.map((shot) => {
    const s = shotState(pid, shot, start, identities);
    start += shot.duration;
    return s;
  });
}

export function shotState(pid: string, shot: Shot, start: number, identities: AssetIdentity[]): ShotState {
  const scene = latestScene(pid, shot.id);
  const capture = latestFrame(pid, shot.id, "capture");
  const captureCurrent = !!capture && !!scene && pictureMatches(frameInputs(capture).pictureKey, frameInputs(capture).sceneId, scene) && capture.status !== "failed";

  const storyboard = latestFrame(pid, shot.id, "storyboard");
  const reasons: string[] = [];
  if (storyboard && scene) {
    const fi = frameInputs(storyboard);
    if (fi.shotRev !== shot.rev) reasons.push("the shot changed");
    if (!pictureMatches(fi.pictureKey, fi.sceneId, scene)) reasons.push("the blocking changed");
    const want = identityMap(identities, shotAssetIds(shot));
    const changed = Object.entries(want).filter(([aid, vid]) => fi.assets?.[aid] !== vid);
    for (const [aid] of changed) reasons.push(`${identities.find((i) => i.asset.id === aid)?.asset.name ?? "an asset"} has a new look`);
  }
  const storyboardCurrent = !!storyboard && !!scene && reasons.length === 0 && storyboard.status !== "failed";

  const takes = takesForShot(pid, shot.id).map((t) => {
    const ti = takeInputs(t);
    // Footage the person supplied for a shot stays current: it is their material, not a render of the frame.
    const current = t.source === "upload" || (storyboardCurrent && storyboard!.status === "ready" && ti.frameId === storyboard!.id);
    return { ...t, current, seconds: ti.seconds };
  });
  const playable = (t: (typeof takes)[number]) => t.status === "ready" && t.verdict !== "rejected" && t.seconds >= shot.duration - 0.05;
  const reviewOk = (t: TakeRow) => json<{ usable?: boolean }>(t.review, {}).usable === true;
  const chosen =
    takes.find((t) => t.verdict === "accepted" && t.current && playable(t)) ??
    takes.find((t) => t.current && playable(t) && reviewOk(t)) ??
    takes.find((t) => t.verdict === "accepted" && playable(t)) ??
    takes.find((t) => t.current && playable(t)) ??
    null;
  const pendingTake = takes.find((t) => t.status === "pending") ?? null;

  let pick: ShotState["pick"] = null;
  if (chosen) pick = { kind: "take", take: chosen };
  else if (storyboard?.status === "ready") pick = { kind: "storyboard", frame: storyboard };
  else if (capture?.status === "ready") pick = { kind: "capture", frame: capture };

  // A person's acceptance overrides an automated flag.
  const hasCurrentGood = takes.some((t) => t.current && playable(t) && (reviewOk(t) || t.verdict === "accepted"));
  return {
    shot,
    start,
    scene,
    capture,
    captureCurrent,
    storyboard,
    storyboardCurrent,
    storyboardReasons: reasons,
    takes,
    pick,
    pendingTake,
    needsTake: !hasCurrentGood,
  };
}

/* ---------------- jobs ---------------- */

export function activeJobs(pid: string): JobRow[] {
  return db().prepare("select * from jobs where project_id = ? and status in ('queued', 'submitting', 'submitted', 'running') order by created_at").all(pid) as JobRow[];
}

export function hasActive(pid: string, kind: string): boolean {
  return !!db().prepare("select 1 from jobs where project_id = ? and kind = ? and status in ('queued', 'submitting', 'submitted', 'running') limit 1").get(pid, kind);
}

export function jobMedia(jobId: string | null | undefined): string | null {
  const job = getJob(jobId);
  if (!job || job.status !== "succeeded") return null;
  return jobOutput<{ mediaId?: string }>(job)?.mediaId ?? null;
}
