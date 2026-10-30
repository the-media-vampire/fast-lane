import { db, id, json, now, tx } from "./db";
import { hashKey } from "./jobs";
import type { Scene } from "./blocking/types";
import type { AssetData, AssetKind, Kind, Aspect, Stage } from "./types";

/**
 * Data access for project state. Outputs are append-only: a revision writes a new row and
 * records the input versions it was made from, so nothing accepted is ever overwritten.
 */

/* ---------------- projects ---------------- */

export type ProjectRow = {
  id: string;
  title: string;
  kind: Kind;
  duration: number;
  aspect: Aspect;
  sample: number;
  autopilot: number;
  budget_cents: number;
  stage: Stage;
  pipeline: string;
  reviewer: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
};

export function createProject(p: { title: string; kind: Kind; duration: number; aspect: Aspect; sample?: boolean; budgetCents?: number; id?: string }): string {
  const pid = p.id ?? id("prj");
  const t = now();
  db()
    .prepare("insert into projects (id, title, kind, duration, aspect, sample, budget_cents, stage, rev, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 'brief', 1, ?, ?)")
    .run(pid, p.title, p.kind, p.duration, p.aspect, p.sample ? 1 : 0, p.budgetCents ?? defaultBudgetCents(p.duration), t, t);
  return pid;
}

/** Run budget: references, video at 480p, sound and two repairs' headroom. */
export function defaultBudgetCents(duration: number) {
  return Math.ceil(duration * 14 * 1.6 + 300);
}

export function getProject(projectId: string): ProjectRow | null {
  return (db().prepare("select * from projects where id = ?").get(projectId) as ProjectRow | undefined) ?? null;
}

export function listProjects(): ProjectRow[] {
  return db().prepare("select * from projects order by updated_at desc").all() as ProjectRow[];
}

export function updateProject(projectId: string, fields: Partial<Pick<ProjectRow, "title" | "kind" | "duration" | "aspect" | "autopilot" | "budget_cents" | "stage" | "reviewer">>) {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  db()
    .prepare(`update projects set ${keys.map((k) => `${k} = ?`).join(", ")}, rev = rev + 1, updated_at = ? where id = ?`)
    .run(...keys.map((k) => fields[k] as string | number), now(), projectId);
}

/** Every write bumps the project revision; the studio polls it to know when to refresh. */
export function bump(projectId: string) {
  db().prepare("update projects set rev = rev + 1, updated_at = ? where id = ?").run(now(), projectId);
}

export function deleteProject(projectId: string) {
  tx(() => {
    for (const t of ["docs", "assets", "asset_versions", "scenes", "frames", "takes", "audio", "cuts", "media", "jobs", "ledger", "messages", "authorizations", "quotes", "approvals"]) {
      db().prepare(`delete from ${t} where project_id = ?`).run(projectId);
    }
    db().prepare("delete from projects where id = ?").run(projectId);
  });
}

/* ---------------- versioned documents ---------------- */

export type DocKind = "brief" | "concepts" | "plan" | "shots";
export type Doc<T> = { id: string; version: number; data: T; inputs: Record<string, unknown>; author: string; note: string | null; created_at: string };

type DocRow = { id: string; version: number; data: string; inputs: string; author: string; note: string | null; created_at: string };

function toDoc<T>(row: DocRow | undefined): Doc<T> | null {
  if (!row) return null;
  return { id: row.id, version: row.version, data: json<T>(row.data, null as T), inputs: json(row.inputs, {}), author: row.author, note: row.note, created_at: row.created_at };
}

export function latestDoc<T>(projectId: string, kind: DocKind): Doc<T> | null {
  return toDoc<T>(db().prepare("select * from docs where project_id = ? and kind = ? order by version desc limit 1").get(projectId, kind) as DocRow | undefined);
}

export function docAt<T>(projectId: string, kind: DocKind, version: number): Doc<T> | null {
  return toDoc<T>(db().prepare("select * from docs where project_id = ? and kind = ? and version = ?").get(projectId, kind, version) as DocRow | undefined);
}

export function docVersions(projectId: string, kind: DocKind): { version: number; author: string; note: string | null; created_at: string }[] {
  return db().prepare("select version, author, note, created_at from docs where project_id = ? and kind = ? order by version desc").all(projectId, kind) as never;
}

export function writeDoc<T>(projectId: string, kind: DocKind, data: T, opts: { inputs?: Record<string, unknown>; author: "user" | "agent" | "system"; note?: string }): Doc<T> {
  return tx(() => {
    const prev = db().prepare("select max(version) as v from docs where project_id = ? and kind = ?").get(projectId, kind) as { v: number | null };
    const version = (prev.v ?? 0) + 1;
    const docId = id("doc");
    const t = now();
    db()
      .prepare("insert into docs (id, project_id, kind, version, data, inputs, author, note, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(docId, projectId, kind, version, JSON.stringify(data), JSON.stringify(opts.inputs ?? {}), opts.author, opts.note ?? null, t);
    bump(projectId);
    return { id: docId, version, data, inputs: opts.inputs ?? {}, author: opts.author, note: opts.note ?? null, created_at: t };
  });
}

/* ---------------- assets ---------------- */

export type AssetRow = {
  id: string;
  project_id: string;
  kind: AssetKind;
  name: string;
  data: string;
  kept_version_id: string | null;
  approved_version_id: string | null;
  position: number;
  archived: number;
  created_at: string;
};

export type AssetVersionRow = {
  id: string;
  asset_id: string;
  project_id: string;
  version: number;
  media_id: string | null;
  prompt: string | null;
  source: "generated" | "upload" | "sample" | "derived";
  job_id: string | null;
  status: "pending" | "ready" | "failed";
  label: string | null;
  note: string | null;
  role: "primary" | "reference" | "sheet" | null;
  created_at: string;
};

export function listAssets(projectId: string, includeArchived = false): AssetRow[] {
  return db()
    .prepare(`select * from assets where project_id = ? ${includeArchived ? "" : "and archived = 0"} order by case kind when 'character' then 0 when 'location' then 1 else 2 end, position, created_at`)
    .all(projectId) as AssetRow[];
}

export function getAsset(assetId: string): AssetRow | null {
  return (db().prepare("select * from assets where id = ?").get(assetId) as AssetRow | undefined) ?? null;
}

export function assetData(a: AssetRow): AssetData {
  return json<AssetData>(a.data, { description: "", look: "", role: "" });
}

export function createAsset(p: { projectId: string; kind: AssetKind; name: string; data: AssetData }): string {
  const aid = id("ast");
  const pos = (db().prepare("select count(*) as n from assets where project_id = ? and kind = ?").get(p.projectId, p.kind) as { n: number }).n;
  db()
    .prepare("insert into assets (id, project_id, kind, name, data, position, created_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run(aid, p.projectId, p.kind, p.name, JSON.stringify(p.data), pos, now());
  bump(p.projectId);
  return aid;
}

export function updateAsset(assetId: string, fields: { name?: string; data?: AssetData; archived?: boolean }) {
  const a = getAsset(assetId);
  if (!a) return;
  db()
    .prepare("update assets set name = ?, data = ?, archived = ? where id = ?")
    .run(fields.name ?? a.name, fields.data ? JSON.stringify(fields.data) : a.data, fields.archived === undefined ? a.archived : fields.archived ? 1 : 0, assetId);
  bump(a.project_id);
}

export function assetVersions(assetId: string): AssetVersionRow[] {
  return db().prepare("select * from asset_versions where asset_id = ? order by version desc").all(assetId) as AssetVersionRow[];
}

export function getAssetVersion(versionId: string | null | undefined): AssetVersionRow | null {
  if (!versionId) return null;
  return (db().prepare("select * from asset_versions where id = ?").get(versionId) as AssetVersionRow | undefined) ?? null;
}

export function addAssetVersion(p: { assetId: string; projectId: string; mediaId?: string | null; prompt?: string | null; source: AssetVersionRow["source"]; jobId?: string | null; status: AssetVersionRow["status"]; label?: string | null; note?: string | null; role?: AssetVersionRow["role"] }): string {
  return tx(() => {
    const prev = db().prepare("select max(version) as v from asset_versions where asset_id = ?").get(p.assetId) as { v: number | null };
    const vid = id("asv");
    db()
      .prepare("insert into asset_versions (id, asset_id, project_id, version, media_id, prompt, source, job_id, status, label, note, role, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(vid, p.assetId, p.projectId, (prev.v ?? 0) + 1, p.mediaId ?? null, p.prompt ?? null, p.source, p.jobId ?? null, p.status, p.label ?? null, p.note ?? null, p.role ?? "primary", now());
    bump(p.projectId);
    return vid;
  });
}

export function setAssetVersion(versionId: string, fields: { mediaId?: string | null; status: AssetVersionRow["status"]; jobId?: string }) {
  const v = getAssetVersion(versionId);
  if (!v) return;
  db().prepare("update asset_versions set media_id = coalesce(?, media_id), status = ?, job_id = coalesce(?, job_id) where id = ?").run(fields.mediaId ?? null, fields.status, fields.jobId ?? null, versionId);
  bump(v.project_id);
}

/** "Keep this look": the version every shot will reference from now on. */
export function keepAssetVersion(assetId: string, versionId: string | null) {
  const a = getAsset(assetId);
  if (!a) return;
  db().prepare("update assets set kept_version_id = ? where id = ?").run(versionId, assetId);
  bump(a.project_id);
}

/** The identity a shot uses: the kept version, else the newest ready primary image. Gallery references never become it silently. */
export function effectiveVersion(asset: AssetRow): AssetVersionRow | null {
  if (asset.kept_version_id) return getAssetVersion(asset.kept_version_id);
  return (db().prepare("select * from asset_versions where asset_id = ? and status = 'ready' and coalesce(role, 'primary') = 'primary' order by version desc limit 1").get(asset.id) as AssetVersionRow | undefined) ?? null;
}

/* ---------------- blocking scenes ---------------- */

export type SceneRow = { id: string; project_id: string; shot_id: string; rev: number; data: string; author: string; note: string | null; created_at: string };
export type SceneDoc = { id: string; rev: number; data: Scene; author: string; note: string | null; created_at: string; pictureKey: string };

/**
 * Picture key: a hash of the scene with times normalised to the shot length. Rescaling a
 * shot's duration leaves it unchanged, so timing edits never mark footage outdated; moving
 * an actor or changing the camera does.
 */
export function pictureKey(scene: Scene): string {
  const d = scene.duration || 1;
  const n = (t: number) => Math.round((t / d) * 1000) / 1000;
  return hashKey({
    set: scene.set.preset,
    features: scene.set.features,
    aspect: scene.aspect,
    actors: scene.actors.map((a) => ({ id: a.id, h: a.height, marks: a.marks.map((m) => ({ ...m, t: n(m.t) })) })),
    props: scene.props.map((p) => ({ ...p, holds: p.holds.map((h) => ({ ...h, t: n(h.t) })) })),
    camera: { ...scene.camera, keys: scene.camera.keys.map((k) => ({ ...k, t: n(k.t) })) },
  });
}

/**
 * The same picture, ignoring how long the shot runs: everything equal, and every time equal as
 * a fraction of the shot within a small tolerance. Used where a hash alone would treat a
 * re-timed shot as a new picture because of rounding.
 */
export function samePictureScene(a: Scene, b: Scene, tol = 0.003): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= 1e-6;
  const nt = (s: Scene, t: number) => t / (s.duration || 1);
  const ct = (x: number, y: number) => Math.abs(x - y) <= tol;
  if (a.aspect !== b.aspect || a.set.preset !== b.set.preset || JSON.stringify(a.set.features) !== JSON.stringify(b.set.features)) return false;
  if (a.actors.length !== b.actors.length || a.props.length !== b.props.length) return false;
  for (let i = 0; i < a.actors.length; i++) {
    const x = a.actors[i];
    const y = b.actors[i];
    if (x.id !== y.id || x.height !== y.height || x.marks.length !== y.marks.length) return false;
    for (let j = 0; j < x.marks.length; j++) {
      const m = x.marks[j];
      const n = y.marks[j];
      if (m.pose !== n.pose || !close(m.x, n.x) || !close(m.z, n.z) || !close(m.facing, n.facing) || !ct(nt(a, m.t), nt(b, n.t))) return false;
    }
  }
  for (let i = 0; i < a.props.length; i++) {
    const x = a.props[i];
    const y = b.props[i];
    const { holds: hx, ...px } = x;
    const { holds: hy, ...py } = y;
    if (JSON.stringify(px) !== JSON.stringify(py) || (hx ?? []).length !== (hy ?? []).length) return false;
    for (let j = 0; j < (hx ?? []).length; j++) if (hx![j].actorId !== hy![j].actorId || !ct(nt(a, hx![j].t), nt(b, hy![j].t))) return false;
  }
  const { keys: ka, ...ca } = a.camera;
  const { keys: kb, ...cb } = b.camera;
  if (JSON.stringify(ca) !== JSON.stringify(cb) || ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const p = ka[i];
    const q = kb[i];
    if (!close(p.lens, q.lens) || !close(p.pos.x, q.pos.x) || !close(p.pos.y, q.pos.y) || !close(p.pos.z, q.pos.z) || !close(p.target.x, q.target.x) || !close(p.target.y, q.target.y) || !close(p.target.z, q.target.z) || !ct(nt(a, p.t), nt(b, q.t))) return false;
  }
  return true;
}

/** Was a frame made from this picture? Exact key first, then the scene it was made from. */
export function pictureMatches(frameKey: string, frameSceneId: string | null | undefined, current: SceneDoc): boolean {
  if (frameKey === current.pictureKey) return true;
  if (!frameSceneId || frameSceneId === current.id) return false;
  const old = sceneById(frameSceneId);
  return !!old && samePictureScene(old.data, current.data);
}

function toScene(row: SceneRow | undefined): SceneDoc | null {
  if (!row) return null;
  const data = json<Scene>(row.data, null as unknown as Scene);
  return { id: row.id, rev: row.rev, data, author: row.author, note: row.note, created_at: row.created_at, pictureKey: pictureKey(data) };
}

export function latestScene(projectId: string, shotId: string): SceneDoc | null {
  return toScene(db().prepare("select * from scenes where project_id = ? and shot_id = ? order by rev desc limit 1").get(projectId, shotId) as SceneRow | undefined);
}

export function sceneById(sceneId: string): SceneDoc | null {
  return toScene(db().prepare("select * from scenes where id = ?").get(sceneId) as SceneRow | undefined);
}

export function sceneHistory(projectId: string, shotId: string): { id: string; rev: number; author: string; note: string | null; created_at: string }[] {
  return db().prepare("select id, rev, author, note, created_at from scenes where project_id = ? and shot_id = ? order by rev desc").all(projectId, shotId) as never;
}

export function writeScene(projectId: string, shotId: string, scene: Scene, author: "user" | "agent" | "system", note?: string): SceneDoc {
  return tx(() => {
    const prev = db().prepare("select max(rev) as r from scenes where project_id = ? and shot_id = ?").get(projectId, shotId) as { r: number | null };
    const rev = (prev.r ?? 0) + 1;
    const sid = id("scn");
    const t = now();
    db().prepare("insert into scenes (id, project_id, shot_id, rev, data, author, note, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)").run(sid, projectId, shotId, rev, JSON.stringify(scene), author, note ?? null, t);
    bump(projectId);
    return { id: sid, rev, data: scene, author, note: note ?? null, created_at: t, pictureKey: pictureKey(scene) };
  });
}

/* ---------------- frames (captures and storyboards) ---------------- */

export type FrameKind = "capture" | "overhead" | "storyboard";
export type FrameInputs = { shotRev: number; pictureKey: string; sceneId: string; assets?: Record<string, string>; captureId?: string | null; previousId?: string | null };
export type FrameRow = { id: string; project_id: string; shot_id: string; kind: FrameKind; media_id: string | null; job_id: string | null; status: "pending" | "ready" | "failed"; inputs: string; note: string | null; meta: string | null; created_at: string };

export function addFrame(p: { projectId: string; shotId: string; kind: FrameKind; mediaId?: string | null; jobId?: string | null; status: FrameRow["status"]; inputs: FrameInputs; note?: string | null }): string {
  const fid = id("frm");
  db()
    .prepare("insert into frames (id, project_id, shot_id, kind, media_id, job_id, status, inputs, note, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(fid, p.projectId, p.shotId, p.kind, p.mediaId ?? null, p.jobId ?? null, p.status, JSON.stringify(p.inputs), p.note ?? null, now());
  bump(p.projectId);
  return fid;
}

export function setFrameMeta(frameId: string, meta: Record<string, unknown>) {
  const f = getFrame(frameId);
  if (!f) return;
  db().prepare("update frames set meta = ? where id = ?").run(JSON.stringify({ ...json<Record<string, unknown>>(f.meta, {}), ...meta }), frameId);
  bump(f.project_id);
}

export function frameHistory(projectId: string, shotId: string, kind: FrameKind = "storyboard"): FrameRow[] {
  return db().prepare("select * from frames where project_id = ? and shot_id = ? and kind = ? order by created_at desc").all(projectId, shotId, kind) as FrameRow[];
}

export function updateFrame(frameId: string, fields: { mediaId?: string | null; status: FrameRow["status"]; jobId?: string }) {
  const f = db().prepare("select project_id from frames where id = ?").get(frameId) as { project_id: string } | undefined;
  db().prepare("update frames set media_id = coalesce(?, media_id), status = ?, job_id = coalesce(?, job_id) where id = ?").run(fields.mediaId ?? null, fields.status, fields.jobId ?? null, frameId);
  if (f) bump(f.project_id);
}

export function getFrame(frameId: string | null | undefined): FrameRow | null {
  if (!frameId) return null;
  return (db().prepare("select * from frames where id = ?").get(frameId) as FrameRow | undefined) ?? null;
}

export function latestFrame(projectId: string, shotId: string, kind: FrameKind, readyOnly = false): FrameRow | null {
  return (
    (db()
      .prepare(`select * from frames where project_id = ? and shot_id = ? and kind = ? ${readyOnly ? "and status = 'ready'" : ""} order by created_at desc limit 1`)
      .get(projectId, shotId, kind) as FrameRow | undefined) ?? null
  );
}

export function frameInputs(f: FrameRow): FrameInputs {
  return json<FrameInputs>(f.inputs, { shotRev: 0, pictureKey: "", sceneId: "" });
}

/* ---------------- takes ---------------- */

export type TakeInputs = { shotRev: number; pictureKey: string; frameId: string; prompt: string; seconds: number; resolution: string };
export type TakeRow = {
  id: string;
  project_id: string;
  shot_id: string;
  job_id: string | null;
  media_id: string | null;
  inputs: string;
  inputs_hash: string;
  status: "pending" | "ready" | "failed";
  verdict: "none" | "accepted" | "rejected";
  review: string | null;
  attempt: number;
  source: "generated" | "upload";
  created_at: string;
};

export function addTake(p: { projectId: string; shotId: string; jobId: string | null; inputs: TakeInputs; attempt: number; source?: TakeRow["source"]; mediaId?: string | null; status?: TakeRow["status"] }): string {
  const tid = id("tak");
  db()
    .prepare("insert into takes (id, project_id, shot_id, job_id, media_id, inputs, inputs_hash, status, attempt, source, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(tid, p.projectId, p.shotId, p.jobId, p.mediaId ?? null, JSON.stringify(p.inputs), hashKey(p.inputs), p.status ?? "pending", p.attempt, p.source ?? "generated", now());
  bump(p.projectId);
  return tid;
}

export function updateTake(takeId: string, fields: { mediaId?: string | null; status?: TakeRow["status"]; review?: unknown; verdict?: TakeRow["verdict"] }) {
  const t = getTake(takeId);
  if (!t) return;
  db()
    .prepare("update takes set media_id = coalesce(?, media_id), status = coalesce(?, status), review = coalesce(?, review), verdict = coalesce(?, verdict) where id = ?")
    .run(fields.mediaId ?? null, fields.status ?? null, fields.review === undefined ? null : JSON.stringify(fields.review), fields.verdict ?? null, takeId);
  bump(t.project_id);
}

export function getTake(takeId: string | null | undefined): TakeRow | null {
  if (!takeId) return null;
  return (db().prepare("select * from takes where id = ?").get(takeId) as TakeRow | undefined) ?? null;
}

export function takesForShot(projectId: string, shotId: string): TakeRow[] {
  return db().prepare("select * from takes where project_id = ? and shot_id = ? order by created_at desc").all(projectId, shotId) as TakeRow[];
}

export function takesForProject(projectId: string): TakeRow[] {
  return db().prepare("select * from takes where project_id = ? order by created_at desc").all(projectId) as TakeRow[];
}

export function takeInputs(t: TakeRow): TakeInputs {
  return json<TakeInputs>(t.inputs, { shotRev: 0, pictureKey: "", frameId: "", prompt: "", seconds: 0, resolution: "" });
}

/** Accepting a take un-accepts the shot's other takes (they stay playable). */
export function acceptTake(takeId: string) {
  const t = getTake(takeId);
  if (!t) return;
  tx(() => {
    db().prepare("update takes set verdict = 'none' where project_id = ? and shot_id = ? and verdict = 'accepted'").run(t.project_id, t.shot_id);
    db().prepare("update takes set verdict = 'accepted' where id = ?").run(takeId);
  });
  bump(t.project_id);
}

/* ---------------- audio ---------------- */

export type AudioRow = { id: string; project_id: string; kind: "voice" | "music"; line_key: string; text_hash: string; media_id: string | null; job_id: string | null; status: "pending" | "ready" | "failed"; data: string; created_at: string };

export function addAudio(p: { projectId: string; kind: AudioRow["kind"]; lineKey: string; textHash: string; jobId: string | null; data?: Record<string, unknown> }): string {
  const aid = id("aud");
  db()
    .prepare("insert into audio (id, project_id, kind, line_key, text_hash, job_id, status, data, created_at) values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
    .run(aid, p.projectId, p.kind, p.lineKey, p.textHash, p.jobId, JSON.stringify(p.data ?? {}), now());
  bump(p.projectId);
  return aid;
}

export function updateAudio(audioId: string, fields: { mediaId?: string; status: AudioRow["status"]; data?: Record<string, unknown> }) {
  const a = db().prepare("select * from audio where id = ?").get(audioId) as AudioRow | undefined;
  if (!a) return;
  db()
    .prepare("update audio set media_id = coalesce(?, media_id), status = ?, data = ? where id = ?")
    .run(fields.mediaId ?? null, fields.status, JSON.stringify({ ...json(a.data, {}), ...(fields.data ?? {}) }), audioId);
  bump(a.project_id);
}

export function findAudio(projectId: string, kind: AudioRow["kind"], lineKey: string, textHash: string): AudioRow | null {
  return (
    (db()
      .prepare("select * from audio where project_id = ? and kind = ? and line_key = ? and text_hash = ? and status != 'failed' order by created_at desc limit 1")
      .get(projectId, kind, lineKey, textHash) as AudioRow | undefined) ?? null
  );
}

export function audioForProject(projectId: string): AudioRow[] {
  return db().prepare("select * from audio where project_id = ? order by created_at desc").all(projectId) as AudioRow[];
}

/* ---------------- cuts ---------------- */

export type CutRow = { id: string; project_id: string; version: number; manifest: string; media_id: string | null; job_id: string | null; status: "pending" | "ready" | "failed"; accepted: number; acceptance: "animatic" | "final" | null; accepted_by: string | null; accepted_at: string | null; review: string | null; note: string | null; created_at: string };

export function addCut(p: { projectId: string; manifest: unknown; jobId: string | null; note?: string }): { id: string; version: number } {
  return tx(() => {
    const prev = db().prepare("select max(version) as v from cuts where project_id = ?").get(p.projectId) as { v: number | null };
    const cid = id("cut");
    const version = (prev.v ?? 0) + 1;
    db()
      .prepare("insert into cuts (id, project_id, version, manifest, job_id, status, note, created_at) values (?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(cid, p.projectId, version, JSON.stringify(p.manifest), p.jobId, p.note ?? null, now());
    bump(p.projectId);
    return { id: cid, version };
  });
}

export function updateCut(cutId: string, fields: { mediaId?: string; status?: CutRow["status"]; review?: unknown; accepted?: boolean; jobId?: string }) {
  const c = getCut(cutId);
  if (!c) return;
  db()
    .prepare("update cuts set media_id = coalesce(?, media_id), status = coalesce(?, status), review = coalesce(?, review), accepted = coalesce(?, accepted), job_id = coalesce(?, job_id) where id = ?")
    .run(fields.mediaId ?? null, fields.status ?? null, fields.review === undefined ? null : JSON.stringify(fields.review), fields.accepted === undefined ? null : fields.accepted ? 1 : 0, fields.jobId ?? null, cutId);
  bump(c.project_id);
}

export function getCut(cutId: string | null | undefined): CutRow | null {
  if (!cutId) return null;
  return (db().prepare("select * from cuts where id = ?").get(cutId) as CutRow | undefined) ?? null;
}

export function listCuts(projectId: string): CutRow[] {
  return db().prepare("select * from cuts where project_id = ? order by version desc").all(projectId) as CutRow[];
}

/* ---------------- conversation ---------------- */

export type MessageContent = {
  text: string;
  /** What the person had selected when this was said (shot, asset, moment in the cut). */
  focus?: { kind: string; id?: string; label: string; time?: number };
  /** A reply replayed from a recording (the sample project), not a live model answer. */
  recorded?: boolean;
  choices?: { id: string; label: string; detail?: string; recommended?: boolean }[];
  /** Concrete results of agent actions: what changed, job ids, costs. */
  results?: { label: string; detail?: string; ok: boolean }[];
  stage?: Stage;
  questionId?: string;
};
export type MessageRow = { id: string; project_id: string; role: "user" | "agent" | "system"; content: string; created_at: string };

export function addMessage(projectId: string, role: MessageRow["role"], content: MessageContent): string {
  const mid = id("msg");
  db().prepare("insert into messages (id, project_id, role, content, created_at) values (?, ?, ?, ?, ?)").run(mid, projectId, role, JSON.stringify(content), now());
  bump(projectId);
  return mid;
}

export function listMessages(projectId: string, limit = 80): { id: string; role: MessageRow["role"]; content: MessageContent; created_at: string }[] {
  const rows = db().prepare("select * from messages where project_id = ? order by created_at desc limit ?").all(projectId, limit) as MessageRow[];
  return rows.reverse().map((r) => ({ id: r.id, role: r.role, content: json<MessageContent>(r.content, { text: "" }), created_at: r.created_at }));
}
