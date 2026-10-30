import { autoBlock } from "./blocking/auto";
import { applyCommands } from "./blocking/commands";
import { buildSet, setPresetFor } from "./blocking/sets";
import type { Scene, SceneCommand } from "./blocking/types";
import { PRICES, type Resolution } from "./adapters/contract";
import { hashKey, enqueue, jobKey, type JobRow } from "./jobs";
import { allowanceOf, authRemaining, getAuthorization, SpendBlocked, spend } from "./billing";
import { VIDEO_RESOLUTION } from "./env";
import { db, json, tx } from "./db";
import {
  addAssetVersion,
  addAudio,
  addCut,
  addFrame,
  addMessage,
  addTake,
  assetVersions,
  findAudio,
  frameHistory,
  frameInputs,
  getProject,
  latestScene,
  listMessages,
  takesForShot,
  updateCut,
  updateFrame,
  writeDoc,
  writeScene,
  type ProjectRow,
} from "./repo";
import {
  activeJobs,
  assetIdentities,
  briefDoc,
  briefInterpreted,
  chosenConcept,
  clipSeconds,
  conceptsDoc,
  hasActive,
  identityMap,
  pipelineOf,
  planDoc,
  setPipeline,
  shotAssetIds,
  shotStates,
  shotsDoc,
  type AssetIdentity,
  type ShotState,
} from "./state";
import { DEFAULT_NARRATOR, castVoices, narratorFor } from "./voices";
import { LIMITS, type Brief, type CutManifest, type Plan, type Shot } from "./types";
import { assetReferencePrompt, assetViewPrompt } from "./creative";

/**
 * The studio's forward motion. `advance` looks at a project and enqueues whatever the current
 * phase still needs. It is idempotent: every job is keyed by its project and inputs, so calling
 * it twice never buys anything twice. Phases stop at the default checkpoints: the creative
 * direction, the storyboard preview, and the cut. Every purchase happens under an approval the
 * person gave; when one runs out, the work pauses and says what it needs.
 */

/* ---------------- model steps ---------------- */

/** A planning step. Its model calls reserve and settle per response under the planning allowance. */
export function thinkJob(pid: string, kind: string, input: Record<string, unknown>, nonce?: string) {
  return enqueue({ projectId: pid, kind, key: { input, nonce }, input: { ...input, projectId: pid }, estCents: 0, provider: "anthropic", authId: allowanceOf(pid)?.id ?? null });
}

/** The automatic version: never re-run a step that already failed on the same inputs (a person retries it). */
function thinkOnce(pid: string, kind: string, input: Record<string, unknown>) {
  if (hasActive(pid, kind) || failedBefore(pid, kind, { input, nonce: undefined })) return;
  thinkJob(pid, kind, input);
}

/* ---------------- per-project serialisation ---------------- */

type G = typeof globalThis & { __fastLaneAdvance?: Map<string, Promise<void>> };
const chains = ((globalThis as G).__fastLaneAdvance ??= new Map());

export function advance(pid: string): Promise<void> {
  const prev = chains.get(pid) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => advanceNow(pid))
    .catch((err: unknown) => {
      if (err instanceof SpendBlocked) {
        pause(pid, err);
        return;
      }
      console.error("[advance]", pid, err);
    });
  chains.set(pid, next);
  return next;
}

/** Stop driving forward and say plainly what is needed. Nothing already made is touched. */
function pause(pid: string, err: SpendBlocked) {
  const p = getProject(pid);
  if (!p) return;
  const pipe = pipelineOf(p);
  const phase = pipe.produce ? "production" : "preview";
  setPipeline(pid, { develop: false, produce: false, paused: { code: err.code, reason: err.message, phase, needCents: err.needCents } });
  if (err.code === "sample" || err.code === "off") return;
  announceOnce(pid, `paused:${phase}:${err.code}:${Math.round(Date.now() / 600_000)}`, {
    text: phase === "production" ? `Production paused: ${err.message} Everything made so far is kept.` : `Paused: ${err.message}`,
  });
}

async function advanceNow(pid: string) {
  const p = getProject(pid);
  if (!p) return;
  if (p.sample) {
    // The sample never buys anything, but its grey captures follow live blocking edits.
    const sampleShots = shotsDoc(pid);
    if (sampleShots) for (const s of shotStates(pid, sampleShots.data.shots)) queueCapture(p, s);
    return;
  }
  const pipe = pipelineOf(p);
  const brief = briefDoc(pid);
  if (!brief) return;

  if (!briefInterpreted(brief)) {
    thinkOnce(pid, "think.brief", { briefVersion: brief.version });
    return;
  }

  const concepts = conceptsDoc(pid);
  if (!concepts) {
    if (pipe.concepts) thinkOnce(pid, "think.concepts", { briefVersion: brief.version });
    return;
  }
  // Even a recommended direction waits for the person to review its complete story.
  if (!concepts.data.chosenId) return;
  if (!pipe.develop && !pipe.produce && !pipe.drawShots?.length) return;

  const concept = chosenConcept(pid)!;
  const plan = planDoc(pid);
  if (!plan || plan.inputs.conceptId !== concept.id || (pipe.storyKey && plan.inputs.storyKey !== pipe.storyKey)) {
    thinkOnce(pid, "think.plan", { conceptId: concept.id, briefVersion: brief.version, ...(pipe.storyKey ? { storyKey: pipe.storyKey, conceptVersion: concepts.version } : {}) });
    return;
  }

  if (pipe.assetsForPlan == null) {
    thinkOnce(pid, "think.assets", { planVersion: plan.version });
    return;
  }

  let identities = assetIdentities(pid);
  for (const id of identities) {
    if (!assetVersions(id.asset.id).length) queueAssetImage(p, brief.data, id, concept.look);
  }
  identities = assetIdentities(pid);

  const shots = shotsDoc(pid);
  if (!shots || (pipe.storyKey && shots.inputs.plan !== plan.version)) {
    thinkOnce(pid, "think.shots", { planVersion: plan.version });
    return;
  }

  // Blocking for any shot that has none yet (deterministic, free).
  for (const shot of shots.data.shots) ensureScene(p, shot, identities);

  const states = shotStates(pid, shots.data.shots, identities);
  for (const s of states) queueCapture(p, s);

  // Individual frames asked for outside the preview phase (a newly added shot), once their capture exists.
  if (!pipe.develop && pipe.drawShots?.length) {
    const left: { id: string; note?: string | null }[] = [];
    for (const entry of pipe.drawShots) {
      const want = typeof entry === "string" ? { id: entry, note: null } : entry;
      const s = states.find((x) => x.shot.id === want.id);
      if (!s || (s.storyboardCurrent && !want.note)) continue;
      const r = queueStoryboard(p, s, identities, { note: want.note ?? null });
      if (r === "waiting") left.push(want);
    }
    setPipeline(pid, { drawShots: left.length ? left : null });
  }

  // Never draw frames for a shot list that is about to be replaced.
  const replanning = hasActive(pid, "think.shots") || hasActive(pid, "think.plan") || hasActive(pid, "think.assets");
  if (pipe.develop && replanning) return;

  if (pipe.develop) {
    let waiting = 0;
    for (const s of states) {
      if (s.storyboardCurrent) {
        if (s.storyboard?.status === "pending") waiting++;
        continue;
      }
      waiting++;
      queueStoryboard(p, s, identities);
    }
    if (waiting === 0) {
      setPipeline(pid, { develop: false, paused: null, storyKey: undefined });
      announceOnce(pid, `preview:${shots.version}`, {
        text: `The storyboard is ready: ${states.length} shots. Review it, then approve the sequence for production.`,
        stage: "shots",
      });
    }
  }

  if (pipe.produce) await advanceProduction(p, states, plan.data, identities);
}

/* ---------------- develop ---------------- */

export function chooseConcept(pid: string, conceptId: string, author: "user" | "agent") {
  const c = conceptsDoc(pid);
  if (!c) throw new Error("There are no directions yet.");
  const selected = c.data.concepts.find((k) => k.id === conceptId);
  if (!selected) throw new Error("Unknown direction.");
  if (c.data.chosenId === conceptId && !selected.storyDraft) return;
  const story = selected.storyDraft ?? selected.story;
  writeDoc(pid, "concepts", { ...c.data, concepts: c.data.concepts.map((k) => k.id === conceptId ? { ...k, story, storyDraft: undefined } : k), chosenId: conceptId }, { author, note: "Approved story and direction", inputs: c.inputs });
  setPipeline(pid, { develop: true, produce: false, paused: null, assetsForPlan: undefined, storyKey: story ? hashKey(story) : undefined });
}

function queueAssetImage(p: ProjectRow, brief: Brief, id: AssetIdentity, look: string) {
  const prompt = assetReferencePrompt(id.asset.kind, id.asset.name, id.data, look);
  tx(() => {
    const versionId = addAssetVersion({ assetId: id.asset.id, projectId: p.id, prompt, source: "generated", status: "pending", label: id.asset.kind === "character" ? "Full body" : id.asset.kind === "location" ? "Establishing" : "Product", role: "primary" });
    const { job } = enqueue({
      projectId: p.id,
      kind: "image.asset",
      key: { versionId },
      input: { projectId: p.id, assetId: id.asset.id, versionId, prompt, aspect: id.asset.kind === "character" ? "9:16" : brief.aspect },
      estCents: PRICES.imageCents.gptImage,
      provider: "kie",
    });
    linkJob("asset_versions", versionId, job);
  });
}

/**
 * Another image of an asset. `primary` proposes a new main image (it never replaces an
 * approved one by itself); `reference` adds a separate gallery view. Unless the request is for
 * a different identity, the current primary image travels as the identity reference.
 */
export function requestAssetImage(pid: string, assetId: string, opts: { note?: string; role: "primary" | "reference"; label?: string; keepIdentity?: boolean; authId?: string | null }) {
  const p = getProject(pid)!;
  const brief = briefDoc(pid)!.data;
  const concept = chosenConcept(pid);
  const id = assetIdentities(pid).find((i) => i.asset.id === assetId);
  if (!id) throw new Error("Unknown asset.");
  const look = concept?.look ?? brief.tone;
  const keep = opts.keepIdentity !== false && !!id.mediaId;
  const prompt = keep
    ? assetViewPrompt(id.asset.kind, id.asset.name, id.data, look, opts.note ? `${opts.label ?? "Another view"}: ${opts.note}` : (opts.label ?? "Another view"))
    : `${assetReferencePrompt(id.asset.kind, id.asset.name, id.data, look)}${opts.note ? `\nDirection for this version: ${opts.note}` : ""}`;
  return tx(() => {
    const versionId = addAssetVersion({ assetId, projectId: pid, prompt, source: "generated", status: "pending", label: opts.label ?? (opts.role === "primary" ? "Proposed" : "Reference"), note: opts.note ?? null, role: opts.role });
    const { job } = enqueue({
      projectId: pid,
      kind: "image.asset",
      key: { versionId },
      input: { projectId: pid, assetId, versionId, prompt, aspect: id.asset.kind === "character" ? "9:16" : p.aspect, note: opts.note ?? null, identityVersionId: keep ? id.version?.id ?? null : null },
      estCents: PRICES.imageCents.gptImage,
      provider: "kie",
      authId: opts.authId ?? null,
    });
    linkJob("asset_versions", versionId, job);
    return { versionId, jobId: job.id };
  });
}

function linkJob(table: "asset_versions" | "frames", rowId: string, job: JobRow) {
  db().prepare(`update ${table} set job_id = ? where id = ?`).run(job.id, rowId);
}

export function ensureScene(p: ProjectRow, shot: Shot, identities: AssetIdentity[], force = false): void {
  if (latestScene(p.id, shot.id) && !force) return;
  writeScene(p.id, shot.id, blockShot(p, shot, identities), "system", "Automatic blocking from the shot plan");
}

export function blockShot(p: ProjectRow, shot: Shot, identities: AssetIdentity[]): Scene {
  const location = identities.find((i) => i.asset.id === shot.locationId);
  const preset = location?.data.set ?? setPresetFor(`${location?.asset.name ?? ""} ${location?.data.description ?? ""} ${shot.description}`);
  return autoBlock({
    shotId: shot.id,
    duration: shot.duration,
    aspect: p.aspect,
    framing: shot.framing,
    move: shot.move,
    lens: shot.lens,
    action: shot.action,
    description: shot.description,
    set: buildSet(preset),
    characters: shot.characterIds.map((cid) => {
      const c = identities.find((i) => i.asset.id === cid);
      return { id: cid, name: c?.asset.name ?? "Actor", height: c?.data.height };
    }),
    props: shot.propIds.map((pid) => {
      const prop = identities.find((i) => i.asset.id === pid);
      return { id: pid, name: prop?.asset.name ?? "Prop", size: prop?.data.size ?? propSizeFor(`${prop?.asset.name ?? ""} ${prop?.data.description ?? ""}`) };
    }),
    speakerId: shot.speakerId,
  });
}

/** Size class from words, for props planned before sizes were recorded. */
export function propSizeFor(text: string): "small" | "medium" | "large" {
  const t = text.toLowerCase();
  if (/\b(bike|bicycle|car|van|scooter|motorbike|bench|sofa|couch|piano|stand|cart|trolley|boat)\b/.test(t)) return "large";
  if (/\b(bag|box|lamp|guitar|suitcase|basket|crate|chair|plant|toolbox|backpack|helmet)\b/.test(t)) return "medium";
  return "small";
}

/** Re-apply the shot's camera intent to its current blocking, keeping actor staging. */
export function syncSceneToShot(p: ProjectRow, shot: Shot, scene: Scene, previous: Shot): Scene {
  const commands: SceneCommand[] = [];
  if (shot.duration !== previous.duration) commands.push({ op: "set_duration", seconds: shot.duration });
  if (shot.framing !== previous.framing) commands.push({ op: "frame", framing: shot.framing });
  if (shot.lens !== previous.lens) commands.push({ op: "set_lens", mm: shot.lens });
  if (shot.move !== previous.move || shot.framing !== previous.framing) commands.push({ op: "camera_move", move: shot.move });
  if (!commands.length) return scene;
  return applyCommands(scene, commands).scene;
}

/** Grey captures for every shot (free). Used outside the develop phase, e.g. text-only runs. */
export function queueCaptures(pid: string) {
  const p = getProject(pid);
  const shots = shotsDoc(pid);
  if (!p || !shots) return;
  for (const s of shotStates(pid, shots.data.shots)) queueCapture(p, s);
}

function queueCapture(p: ProjectRow, s: ShotState) {
  if (!s.scene || s.captureCurrent) return;
  const inputs = { shotRev: s.shot.rev, pictureKey: s.scene.pictureKey, sceneId: s.scene.id };
  const key = { kind: "capture", sceneKey: s.scene.pictureKey, shotId: s.shot.id };
  if (hasActiveKeyed(p.id, "capture", key) || failedBefore(p.id, "capture", key)) return;
  const frameId = addFrame({ projectId: p.id, shotId: s.shot.id, kind: "capture", status: "pending", inputs });
  const { job } = enqueue({ projectId: p.id, kind: "capture", key, input: { projectId: p.id, frameId, sceneId: s.scene.id, t: 0 }, estCents: 0, provider: "local" });
  linkJob("frames", frameId, job);
}

/**
 * Draw (or redraw) one shot's storyboard frame. A plain redraw whose exact inputs were drawn
 * before reuses that picture for free. A redraw with a note keeps the previous frame as a
 * reference so details the note doesn't mention survive.
 */
export function queueStoryboard(p: ProjectRow, s: ShotState, identities: AssetIdentity[], opts: { note?: string | null; authId?: string | null } = {}): "queued" | "reused" | "waiting" | "skipped" {
  if (!s.scene) return "waiting";
  // Wait for the layout capture and for every identity the shot uses.
  if (!s.captureCurrent || s.capture?.status !== "ready") return "waiting";
  const ids = shotAssetIds(s.shot);
  const pendingIdentity = ids.some((aid) => {
    const i = identities.find((x) => x.asset.id === aid);
    return !!i && !i.version && assetVersions(aid)[0]?.status === "pending";
  });
  if (pendingIdentity) return "waiting";
  const assets = identityMap(identities, ids);
  const note = opts.note?.trim() || null;
  const previous = note ? frameHistory(p.id, s.shot.id).find((f) => f.status === "ready" && f.media_id) ?? null : null;
  const inputs = { shotRev: s.shot.rev, pictureKey: s.scene.pictureKey, sceneId: s.scene.id, assets, captureId: s.capture.id, previousId: previous?.id ?? null };

  if (!note) {
    // The same picture inputs were drawn before (e.g. a change that was reverted): reuse it.
    const same = frameHistory(p.id, s.shot.id).find((f) => {
      if (f.status !== "ready" || !f.media_id || f.note) return false;
      const fi = frameInputs(f);
      return fi.shotRev === s.shot.rev && fi.pictureKey === s.scene!.pictureKey && JSON.stringify(fi.assets ?? {}) === JSON.stringify(assets);
    });
    if (same && same.id !== s.storyboard?.id) {
      addFrame({ projectId: p.id, shotId: s.shot.id, kind: "storyboard", status: "ready", mediaId: same.media_id, inputs: { ...inputs, previousId: null } });
      return "reused";
    }
  }

  const key = { kind: "storyboard", shotId: s.shot.id, rev: s.shot.rev, pictureKey: s.scene.pictureKey, assets, captureId: s.capture.id, note, previousId: previous?.id ?? null };
  if (hasActiveKeyed(p.id, "image.storyboard", key)) return "queued";
  if (!note && failedBefore(p.id, "image.storyboard", key)) return "skipped";
  return tx(() => {
    const frameId = addFrame({ projectId: p.id, shotId: s.shot.id, kind: "storyboard", status: "pending", inputs, note });
    const { job, reused } = enqueue({
      projectId: p.id,
      kind: "image.storyboard",
      key,
      input: { projectId: p.id, frameId, shotId: s.shot.id, sceneId: s.scene!.id, note, previousId: previous?.id ?? null },
      estCents: PRICES.imageCents.gptImage,
      provider: "kie",
      authId: opts.authId ?? null,
    });
    linkJob("frames", frameId, job);
    if (reused && job.status === "succeeded") {
      const out = json<{ mediaId?: string }>(job.output, {});
      updateFrame(frameId, { mediaId: out.mediaId ?? null, status: out.mediaId ? "ready" : "failed" });
      return "reused" as const;
    }
    return "queued" as const;
  });
}

function hasActiveKeyed(pid: string, kind: string, key: unknown): boolean {
  const idem = jobKey(pid, kind, key, 1);
  return activeJobs(pid).some((j) => j.idem_key === idem);
}

/** A job with these exact inputs already failed in this project: wait for a person instead of looping. */
export function failedBefore(pid: string, kind: string, key: unknown): boolean {
  const idem = jobKey(pid, kind, key, 1);
  return !!db().prepare("select 1 from jobs where idem_key = ? and status in ('failed', 'ambiguous')").get(idem);
}

/* ---------------- produce ---------------- */

export const RESOLUTION: Resolution = VIDEO_RESOLUTION;

/** What still stands between the shots and a finished cut. */
export type ProductionCheck = { outstanding: number; exhausted: string[]; reviewing: number };

async function advanceProduction(p: ProjectRow, states: ShotState[], plan: Plan, identities: AssetIdentity[]) {
  const pipe = pipelineOf(p);
  const authId = pipe.produceAuth ?? null;
  const auth = getAuthorization(authId);
  if (!auth || auth.status !== "active") {
    setPipeline(p.id, { produce: false });
    return;
  }
  const scope = new Set(pipe.produceShots ?? states.map((s) => s.shot.id));
  let outstanding = 0;
  const exhausted: string[] = [];
  for (const s of states) {
    if (!scope.has(s.shot.id)) continue;
    // A reviewed or explicitly chosen take completes this shot. Don't buy another review
    // after a person has made that decision, or let abandoned alternatives stall production.
    if (!s.needsTake) continue;
    const unreviewed = s.takes.filter((t) => t.current && t.status === "ready" && !t.review);
    if (unreviewed.length) {
      outstanding++;
      for (const t of unreviewed) enqueue({ projectId: p.id, kind: "review.take", key: { takeId: t.id }, input: { projectId: p.id, takeId: t.id }, estCents: 0, provider: "anthropic", authId });
      continue;
    }
    if (s.pendingTake) {
      outstanding++;
      continue;
    }
    if (!s.storyboardCurrent || s.storyboard?.status !== "ready") {
      if (s.storyboard?.status !== "failed") {
        outstanding++;
        queueStoryboard(p, s, identities, { authId });
      } else exhausted.push(s.shot.id);
      continue;
    }
    const tried = s.takes.filter((t) => t.current && t.source !== "upload");
    if (tried.length >= 1 + LIMITS.repairAttempts) {
      exhausted.push(s.shot.id);
      continue;
    }
    // A repair carries the reviewer's direction into the retake.
    const hint = tried.map((t) => (t.review ? json<{ repairHint?: string }>(t.review, {}).repairHint : "")).find((h) => h);
    queueTake(p, s, plan, tried.length + 1, hint || undefined, authId);
    outstanding++;
  }

  outstanding += queueSound(p, plan, identities, authId);

  if (outstanding === 0 && !hasActive(p.id, "assemble")) {
    const total = [...scope].length;
    setPipeline(p.id, { produce: false, attention: exhausted.length ? exhausted : null, paused: null });
    if (exhausted.length) {
      const cut = queueCut(p.id, `Review cut · ${exhausted.length} shot${exhausted.length === 1 ? "" : "s"} need${exhausted.length === 1 ? "s" : ""} attention`);
      const names = exhausted.map((id) => shotTitle(states.map((x) => x.shot), id).split(" · ")[0]).join(", ");
      announceOnce(p.id, `attention:${cut.id}`, {
        text: `${total - exhausted.length} of ${total} shots have usable takes. ${names} still need${exhausted.length === 1 ? "s" : ""} your call: accept a flagged take, retake with a note, or change the shot. This review cut shows stand-ins there.`,
        stage: "cut",
      });
    } else {
      const cut = queueCut(p.id, "Production cut");
      announceOnce(p.id, `assembling:${cut.id}`, { text: `All ${total} shots have usable takes. Assembling the cut with sound for your review.`, stage: "cut" });
    }
  }
}

export function queueTake(p: ProjectRow, s: ShotState, plan: Plan, attempt: number, note?: string, authId?: string | null) {
  const seconds = clipSeconds(s.shot.duration);
  const frame = s.storyboard!;
  const inputs = { shotRev: s.shot.rev, pictureKey: s.scene!.pictureKey, frameId: frame.id, prompt: note ?? "", seconds, resolution: RESOLUTION };
  const est = Math.ceil(seconds * PRICES.videoCentsPerSecond[RESOLUTION]);
  return tx(() => {
    const { job, reused } = enqueue({
      projectId: p.id,
      kind: "video.clip",
      key: { frameId: frame.id, seconds, resolution: RESOLUTION, note: note ?? null },
      attempt,
      input: { projectId: p.id, shotId: s.shot.id, frameId: frame.id, sceneId: s.scene!.id, seconds, note: note ?? null, attempt },
      estCents: est,
      provider: "kie",
      authId: authId ?? null,
    });
    if (reused) return job;
    addTake({ projectId: p.id, shotId: s.shot.id, jobId: job.id, inputs, attempt });
    void plan;
    return job;
  });
}

/**
 * Voice lines and the music bed. Returns how many are still outstanding. Identical lines in
 * one project share one recording; every line's own record receives it.
 */
function queueSound(p: ProjectRow, plan: Plan, identities: AssetIdentity[], authId?: string | null): number {
  let outstanding = 0;
  const narrator = plan.voice.voiceId ?? narratorFor(plan.voice.style).id;
  const cast = { ...castVoices(identities.filter((i) => i.asset.kind === "character").map((i) => ({ id: i.asset.id, text: `${i.data.look} ${i.data.description}` })), narrator), ...(plan.voice.cast ?? {}) };
  for (const beat of plan.beats) {
    for (const line of beat.lines) {
      if (line.kind === "super") continue;
      const speaker = line.kind === "dialogue" ? identities.find((i) => i.asset.kind === "character" && i.asset.name.toLowerCase() === (line.speaker ?? "").toLowerCase()) : null;
      const voiceId = speaker ? (cast[speaker.asset.id] ?? narrator) : narrator;
      const textHash = hashKey({ text: line.text, voiceId });
      const existing = findAudio(p.id, "voice", line.id, textHash);
      if (existing?.status === "ready") continue;
      if (existing) {
        outstanding++;
        continue;
      }
      if (failedBefore(p.id, "audio.voice", { text: line.text, voiceId })) continue; // surfaced in Jobs
      const est = Math.max(1, Math.ceil((line.text.length / 1000) * PRICES.voiceCentsPer1000Chars));
      tx(() => {
        const { job, reused } = enqueue({ projectId: p.id, kind: "audio.voice", key: { text: line.text, voiceId }, input: { projectId: p.id, lineId: line.id, text: line.text, voiceId }, estCents: est, provider: "elevenlabs", authId: authId ?? null });
        const rowId = addAudio({ projectId: p.id, kind: "voice", lineKey: line.id, textHash, jobId: job.id, data: { voiceId, text: line.text } });
        if (reused && job.status === "succeeded") attachAudioResult(rowId, job);
        else outstanding++;
      });
    }
  }
  const musicHash = hashKey({ mood: plan.music.mood, seconds: p.duration });
  const bed = findAudio(p.id, "music", "bed", musicHash);
  const bedKey = { mood: plan.music.mood, seconds: p.duration };
  if (bed?.status !== "ready" && !(!bed && failedBefore(p.id, "audio.music", bedKey))) {
    if (!bed) {
      tx(() => {
        const { job, reused } = enqueue({ projectId: p.id, kind: "audio.music", key: bedKey, input: { projectId: p.id, mood: plan.music.mood, seconds: p.duration, title: plan.title }, estCents: PRICES.musicCents, provider: "kie", authId: authId ?? null });
        const rowId = addAudio({ projectId: p.id, kind: "music", lineKey: "bed", textHash: musicHash, jobId: job.id, data: { mood: plan.music.mood } });
        if (reused && job.status === "succeeded") attachAudioResult(rowId, job);
        else outstanding++;
      });
    } else outstanding++;
  }
  return outstanding;
}

/** A recording that already exists is attached to a new record immediately. */
function attachAudioResult(audioId: string, job: JobRow) {
  const out = json<{ mediaId?: string; durationMs?: number; words?: unknown }>(job.output, {});
  if (!out.mediaId) return;
  const m = db().prepare("select duration, meta from media where id = ?").get(out.mediaId) as { duration: number | null; meta: string } | undefined;
  const meta = json<{ words?: unknown }>(m?.meta, {});
  const row = db().prepare("select data from audio where id = ?").get(audioId) as { data: string } | undefined;
  const data = { ...json<Record<string, unknown>>(row?.data, {}), durationMs: out.durationMs ?? Math.round((m?.duration ?? 0) * 1000), words: out.words ?? meta.words ?? [] };
  db().prepare("update audio set media_id = ?, status = 'ready', data = ? where id = ?").run(out.mediaId, JSON.stringify(data), audioId);
}

export function startSound(pid: string, authId?: string | null) {
  const p = getProject(pid)!;
  const plan = planDoc(pid);
  if (!plan) throw new Error("There is no plan yet.");
  return queueSound(p, plan.data, assetIdentities(pid), authId);
}

/* ---------------- the cut ---------------- */

export function queueCut(pid: string, note: string) {
  const manifest = buildManifest(pid);
  const cut = addCut({ projectId: pid, manifest, jobId: null, note });
  const { job } = enqueue({ projectId: pid, kind: "assemble", key: { cutId: cut.id }, input: { projectId: pid, cutId: cut.id }, estCents: 0, provider: "local" });
  updateCut(cut.id, { jobId: job.id });
  return { ...cut, jobId: job.id };
}

export function frameSize(aspect: "16:9" | "9:16") {
  return aspect === "16:9" ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
}

export function buildManifest(pid: string): CutManifest {
  const p = getProject(pid)!;
  const plan = planDoc(pid)?.data ?? null;
  const shots = shotsDoc(pid)?.data.shots ?? [];
  const identities = assetIdentities(pid);
  const states = shotStates(pid, shots, identities);
  const { width, height } = frameSize(p.aspect);

  const slots: CutManifest["shots"] = states.map((s) => {
    if (s.pick?.kind === "take") return { shotId: s.shot.id, takeId: s.pick.take.id, fallback: null, mediaId: s.pick.take.media_id, start: s.start, duration: s.shot.duration, trimIn: 0 };
    if (s.pick?.kind === "storyboard") return { shotId: s.shot.id, takeId: null, fallback: "storyboard" as const, mediaId: s.pick.frame.media_id, start: s.start, duration: s.shot.duration, trimIn: 0 };
    if (s.pick?.kind === "capture") return { shotId: s.shot.id, takeId: null, fallback: "capture" as const, mediaId: s.pick.frame.media_id, start: s.start, duration: s.shot.duration, trimIn: 0 };
    return { shotId: s.shot.id, takeId: null, fallback: "black" as const, mediaId: null, start: s.start, duration: s.shot.duration, trimIn: 0 };
  });
  const total = slots.reduce((a, s) => a + s.duration, 0);

  const voice: CutManifest["voice"] = [];
  const supers: CutManifest["supers"] = [];
  if (plan) {
    const narrator = plan.voice.voiceId ?? narratorFor(plan.voice.style).id ?? DEFAULT_NARRATOR.id;
    const cast = { ...castVoices(identities.filter((i) => i.asset.kind === "character").map((i) => ({ id: i.asset.id, text: `${i.data.look} ${i.data.description}` })), narrator), ...(plan.voice.cast ?? {}) };
    let cursor = 0;
    for (const beat of plan.beats) {
      const shotForLine = (lineId: string) => states.find((s) => s.shot.lineIds.includes(lineId));
      for (const line of beat.lines) {
        const anchor = shotForLine(line.id)?.start ?? beat.start;
        if (line.kind === "super") {
          const start = Math.min(total - 1.5, anchor + 0.4);
          const words = line.text.split(/\s+/).length;
          supers.push({ lineId: line.id, text: line.text, start, end: Math.min(total, Math.max(start + 2.2, Math.min(beat.end, start + 1.2 + words * 0.45))), style: "lower" });
          continue;
        }
        const speaker = line.kind === "dialogue" ? identities.find((i) => i.asset.kind === "character" && i.asset.name.toLowerCase() === (line.speaker ?? "").toLowerCase()) : null;
        const voiceId = speaker ? (cast[speaker.asset.id] ?? narrator) : narrator;
        const audio = findAudio(pid, "voice", line.id, hashKey({ text: line.text, voiceId }));
        if (audio?.status !== "ready" || !audio.media_id) continue;
        const durationMs = Number(JSON.parse(audio.data || "{}").durationMs ?? 0);
        const start = Math.max(anchor + 0.3, cursor + 0.25);
        if (start + durationMs / 1000 > total) continue;
        voice.push({ lineId: line.id, audioId: audio.id, mediaId: audio.media_id, start });
        cursor = start + durationMs / 1000;
      }
    }
  }
  const musicHash = hashKey({ mood: plan?.music.mood ?? "", seconds: p.duration });
  const bed = findAudio(pid, "music", "bed", musicHash);
  const endCard = plan?.endCard ? { line: plan.endCard.line, detail: plan.endCard.detail, start: Math.max(0, total - 3.2) } : null;
  // Supers never repeat or collide with the end card, and never sit on top of each other.
  const norm = (t: string) => t.trim().toLowerCase().replace(/[.!?]+$/, "");
  const endWords = endCard ? [endCard.line, endCard.detail ?? ""].filter(Boolean).map(norm) : [];
  const supersClear: CutManifest["supers"] = [];
  for (const sp of supers.filter((x) => !endWords.includes(norm(x.text))).sort((a, b) => a.start - b.start)) {
    const prev = supersClear[supersClear.length - 1];
    const start = prev && sp.start < prev.end + 0.2 ? prev.end + 0.2 : sp.start;
    const limit = endCard ? endCard.start - 0.2 : total;
    const end = Math.min(limit, start + Math.max(1.8, sp.end - sp.start));
    if (end - start >= 1.5) supersClear.push({ ...sp, start, end });
  }
  return {
    aspect: p.aspect,
    width,
    height,
    duration: total,
    shots: slots,
    voice,
    music: bed?.status === "ready" && bed.media_id ? { audioId: bed.id, mediaId: bed.media_id, gainDb: voice.length ? -9 : -4 } : null,
    supers: supersClear,
    endCard,
  };
}

/* ---------------- estimates ---------------- */

/** A take review is one vision call; its usual cost, and the most one can cost. */
export const REVIEW_CENTS = { typical: 6, bound: 16 };

export type Estimate = {
  shots: { shotId: string; title: string; seconds: number; cents: number; reason: string }[];
  storyboardCents: number;
  videoCents: number;
  soundCents: number;
  reviewCents: number;
  repairReserveCents: number;
  totalCents: number;
  ceilingCents: number;
  remainingCents: number;
  reusedTakes: number;
};

export function estimateProduction(pid: string, onlyShots?: string[]): Estimate {
  const shots = shotsDoc(pid)?.data.shots ?? [];
  const states = shotStates(pid, shots).filter((s) => !onlyShots || onlyShots.includes(s.shot.id));
  const plan = planDoc(pid)?.data;
  const list: Estimate["shots"] = [];
  let storyboardCents = 0;
  let reused = 0;
  for (const s of states) {
    if (!s.needsTake) {
      reused++;
      continue;
    }
    if (s.pendingTake) continue;
    if (!s.storyboardCurrent) storyboardCents += PRICES.imageCents.gptImage;
    const seconds = clipSeconds(s.shot.duration);
    list.push({ shotId: s.shot.id, title: s.shot.title, seconds, cents: Math.ceil(seconds * PRICES.videoCentsPerSecond[RESOLUTION]), reason: s.takes.length ? "outdated or rejected take" : "no take yet" });
  }
  const videoCents = list.reduce((a, s) => a + s.cents, 0);
  const p = getProject(pid)!;
  const lines = plan?.beats.flatMap((b) => b.lines.filter((l) => l.kind !== "super")) ?? [];
  const voiceMissing = lines.filter((l) => !db().prepare("select 1 from audio where project_id = ? and kind = 'voice' and line_key = ? and status = 'ready'").get(pid, l.id));
  const musicHash = hashKey({ mood: plan?.music.mood ?? "", seconds: p.duration });
  const bedReady = !!findAudio(pid, "music", "bed", musicHash) && findAudio(pid, "music", "bed", musicHash)!.status === "ready";
  const soundCents = voiceMissing.reduce((a, l) => a + Math.max(1, Math.ceil((l.text.length / 1000) * PRICES.voiceCentsPer1000Chars)), 0) + (bedReady ? 0 : PRICES.musicCents);
  const reviewCents = list.length * REVIEW_CENTS.typical;
  // Retry allowance: about one repair in three, each with its review, plus the reservation headroom of one review.
  const repairReserveCents = Math.ceil(videoCents * 0.35) + Math.ceil(list.length * 0.35) * REVIEW_CENTS.typical + (list.length ? REVIEW_CENTS.bound : 0);
  const totalCents = videoCents + storyboardCents + soundCents + reviewCents;
  const s = spend(pid);
  return { shots: list, storyboardCents, videoCents, soundCents, reviewCents, repairReserveCents, totalCents, ceilingCents: totalCents + repairReserveCents, remainingCents: s.remainingCents, reusedTakes: reused };
}

export function startProduction(pid: string, authId: string, shotIds: string[]) {
  setPipeline(pid, { produce: true, develop: false, produceAuth: authId, produceShots: shotIds, attention: null, paused: null });
  return advance(pid);
}

/** Retake one shot (optionally with a note folded into the prompt). Only that shot is regenerated. */
export function retakeShot(pid: string, shotId: string, note: string | undefined, authId: string) {
  const p = getProject(pid)!;
  const shots = shotsDoc(pid)?.data.shots ?? [];
  const plan = planDoc(pid)?.data;
  if (!plan) throw new Error("There is no plan yet.");
  const s = shotStates(pid, shots).find((x) => x.shot.id === shotId);
  if (!s) throw new Error("Unknown shot.");
  if (!s.storyboardCurrent || s.storyboard?.status !== "ready") throw new Error("This shot's storyboard frame needs to be drawn first.");
  const attempt = takesForShot(pid, shotId).length + 1;
  const job = queueTake(p, s, plan, attempt, note, authId);
  return job;
}

/** Does the planning allowance have room for roughly this much? */
export function allowanceRoom(pid: string): number {
  const a = allowanceOf(pid);
  return a ? Math.max(0, authRemaining(a)) : 0;
}

/* ---------------- announcements ---------------- */

export function announceOnce(pid: string, key: string, content: { text: string; stage?: import("./types").Stage }) {
  const seen = listMessages(pid, 200).some((m) => (m.content as { key?: string }).key === key);
  if (seen) return;
  addMessage(pid, "agent", { ...content, key } as never);
}

export function shotTitle(shots: Shot[], shotId: string) {
  const i = shots.findIndex((s) => s.id === shotId);
  return i < 0 ? "a shot" : `Shot ${String(i + 1).padStart(2, "0")} · ${shots[i].title}`;
}
