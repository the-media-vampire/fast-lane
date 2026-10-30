import fs from "node:fs";
import path from "node:path";
import { MediaError } from "./adapters/media";
import { PRICES, type RefRole } from "./adapters/contract";
import { describeForPrompt } from "./blocking/describe";
import { captureScene } from "./blocking/capture";
import { db, MEDIA_DIR, json, now, id as newId } from "./db";
import { VIDEO_RESOLUTION } from "./env";
import { blackStill, makePreview, probeSize } from "./ffmpeg";
import {
  claim,
  dueJobs,
  enqueue,
  fail,
  getJob,
  hashKey,
  holdJob,
  jobInput,
  jobRef,
  leasePoll,
  markAmbiguous,
  markSubmitted,
  releaseLease,
  reschedule,
  spendClassOf,
  succeed,
  type JobRow,
} from "./jobs";
import { authCovers, authRemaining, chooseAuthorization, getAuthorization, openModelReservations, release, reserve, settle, spendGate, SpendBlocked } from "./billing";
import { absPath, downloadToMedia, getMedia, registerMedia, saveMedia, setPublicUrl, type MediaRow } from "./media";
import { freeMedia, mediaFor } from "./providers";
import {
  conceptImagePrompt,
  clipPrompt,
  interpretBrief,
  planAssets,
  proposeConcepts,
  proposeShots,
  storyboardPrompt,
  writePlan,
} from "./creative";
import {
  addMessage,
  createAsset,
  getAsset,
  getAssetVersion,
  getCut,
  getFrame,
  getProject,
  latestScene,
  listAssets,
  sceneById,
  setAssetVersion,
  setFrameMeta,
  updateAudio,
  updateCut,
  updateFrame,
  updateProject,
  updateTake,
  writeDoc,
  frameInputs,
  takesForProject,
  assetVersions,
} from "./repo";
import { advance, announceOnce, frameSize, REVIEW_CENTS } from "./pipeline";
import {
  assetIdentities,
  briefDoc,
  chosenConcept,
  conceptsDoc,
  pipelineOf,
  planDoc,
  setPipeline,
  shotAssetIds,
  shotsDoc,
} from "./state";
import { reviewCut, reviewFrame, reviewTake } from "./review";
import type { Bill } from "./llm";
import type { Brief, ConceptSet, CutManifest } from "./types";
import type { AssembleRequest } from "./adapters/contract";

/**
 * The production worker. Runs inside the server process (instrumentation.ts), so closing the
 * browser never stops a job. Before a billable job is dispatched it passes the spending gate
 * and must have an approval with room, so a restart can never drain a queue while spending is
 * off. Paid submissions are two-phase (see lib/jobs.ts); polling is leased so only one process
 * settles a result.
 */

type Outcome =
  | { done: Record<string, unknown>; cents?: number | null }
  | { failed: string; charged?: boolean }
  | { pending: number }
  | { submitted: string; provider: string; meta?: Record<string, unknown> }
  | { ambiguous: string }
  /** Not allowed to spend right now: wait, with the reason shown, instead of failing. */
  | { held: string };

type Handler = {
  /** True when an interrupted call may already have cost money. */
  paid: boolean;
  group: keyof typeof LIMITS;
  run(job: JobRow): Promise<Outcome>;
  poll?(job: JobRow): Promise<Outcome>;
  onFail?(job: JobRow, error: string): void;
};

const LIMITS = { think: 3, image: 6, video: 4, audio: 4, capture: 1, assemble: 1, review: 3 } as const;

/** How long to wait on a provider task before asking a person. */
const CEILING_MINUTES: Record<keyof typeof LIMITS, number> = { think: 15, image: 20, video: 45, audio: 25, capture: 10, assemble: 30, review: 15 };

/** The room a planning step needs before it starts (one bounded model call). */
const MODEL_STEP_CENTS = 40;

const bill = (job: JobRow, purpose: string): Bill => ({ projectId: job.project_id, purpose, jobId: job.id, authId: job.auth_id });

/* ---------------- helpers ---------------- */

async function publicUrl(m: MediaRow): Promise<string> {
  if (m.public_url) return m.public_url;
  const ext = m.path.split(".").pop() ?? "bin";
  const { url } = await mediaFor(m.project_id).publish({ absPath: absPath(m), pathname: `fast-lane/${m.project_id}/${m.id}.${ext}`, contentType: m.mime });
  setPublicUrl(m.id, url, null);
  return url;
}

async function storeImage(projectId: string, url: string, name: string, meta: Record<string, unknown>): Promise<MediaRow> {
  const row = await downloadToMedia({ projectId, url, provenance: "live", name, fallbackMime: "image/png", meta });
  await attachPreview(row);
  return row;
}

/** A 960 px JPEG preview next to the original; the media route serves it with ?v=preview. */
export async function attachPreview(row: MediaRow) {
  const abs = absPath(row);
  const previewRel = row.path.replace(/\.[a-z0-9]+$/i, ".preview.jpg");
  const ok = await makePreview(abs, path.join(MEDIA_DIR, previewRel), 960);
  const size = await probeSize(abs);
  const meta = { ...json<Record<string, unknown>>(row.meta, {}), ...(ok ? { previewPath: previewRel } : {}) };
  db().prepare("update media set meta = ?, width = coalesce(?, width), height = coalesce(?, height), duration = coalesce(?, duration) where id = ?").run(JSON.stringify(meta), size?.width ?? null, size?.height ?? null, row.kind === "video" ? (size?.duration ?? null) : null, row.id);
}

type KiePoll = Awaited<ReturnType<ReturnType<typeof freeMedia>["kiePoll"]>>;

function kieOutcome(p: KiePoll): Outcome | { url: string; cents: number | null } {
  if (p.state === "pending") return { pending: 6 };
  if (p.state === "fail") return p.transient ? { pending: 15 } : { failed: p.error };
  if (!p.urls[0]) return { failed: "The provider finished without a result." };
  return { url: p.urls[0], cents: p.cents };
}

type ImageRequest = { prompt: string; aspect: "16:9" | "9:16"; references: { url: string; role: RefRole; label: string }[] };

async function submitImage(pid: string, req: ImageRequest, engine: "gptImage" | "seedream" = "gptImage", extra: Record<string, unknown> = {}): Promise<Outcome> {
  const r = await mediaFor(pid).imageSubmit({ engine, ...req });
  return { submitted: r.taskId, provider: "kie", meta: { ...extra, model: r.model, engine, request: req } };
}

/**
 * Poll an image task. A provider-side failure on GPT Image 2 falls back once to Seedream.
 * The fallback is a new purchase: it passes the gate and reserves
 * the price difference under the same approval, or the job fails instead.
 */
async function pollImage(job: JobRow): Promise<Outcome | { url: string; cents: number | null }> {
  const o = kieOutcome(await freeMedia().kiePoll(job.provider_task_id!));
  if (!("failed" in o)) return o;
  const meta = json<{ submittedMeta?: { engine?: string; request?: ImageRequest } }>(job.output, {}).submittedMeta;
  if (meta?.engine !== "gptImage" || !meta.request) return o;
  const extra = PRICES.imageCents.seedream - PRICES.imageCents.gptImage;
  const ref = `${jobRef(job)}:fallback`;
  try {
    if (extra > 0) reserve(job.project_id, { cls: "image", cents: extra, ref, jobId: job.id, authId: job.auth_id, note: `${job.kind} fallback to Seedream` });
  } catch (err) {
    return { failed: `${o.failed} The fallback wasn't bought: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return await submitImage(job.project_id, meta.request, "seedream", { fellBackFrom: job.provider_task_id, firstError: o.failed, fallbackRef: extra > 0 ? ref : null });
  } catch (err) {
    const out = errorOutcome(err, true);
    if ("failed" in out) release(ref, "fallback not accepted");
    return out;
  }
}

function errorOutcome(err: unknown, paid: boolean): Outcome {
  if (err instanceof SpendBlocked) return { held: err.message };
  if (err instanceof MediaError) {
    if (err.kind === "ambiguous") return { ambiguous: `${err.message} The provider may have accepted this request; check before retrying.` };
    if (err.kind === "credits") return { failed: "The provider account is out of credits. Top it up, then retry." };
    if (err.transient && !paid) return { pending: 20 };
    if (err.transient && paid) return { ambiguous: err.message };
    return { failed: err.message };
  }
  return { failed: err instanceof Error ? err.message : String(err) };
}

/** Settle the Seedream fallback's extra reservation alongside the job. */
function settleFallback(job: JobRow, charged: boolean) {
  const ref = json<{ submittedMeta?: { fallbackRef?: string | null } }>(job.output, {}).submittedMeta?.fallbackRef;
  if (!ref) return;
  if (charged) settle(ref, { cents: PRICES.imageCents.seedream - PRICES.imageCents.gptImage, basis: "estimate", note: "Seedream fallback" });
  else release(ref, "fallback not charged");
}

/* ---------------- handlers ---------------- */

const handlers: Record<string, Handler> = {
  "think.brief": {
    paid: true,
    group: "think",
    async run(job) {
      const pid = job.project_id;
      const brief = briefDoc(pid);
      if (!brief) return { failed: "No brief." };
      const b = brief.data;
      const answers = b.questions.filter((q) => q.answer).map((q) => ({ question: q.question, answer: q.answer! }));
      const { data, cents } = await interpretBrief({ idea: b.idea, kind: b.kind, duration: b.duration, aspect: b.aspect, uploads: b.uploads, script: b.script, answers, bill: bill(job, "Reading the brief") });
      const next: Brief = {
        ...b,
        title: b.title && b.title !== "Untitled" ? b.title : data.title,
        summary: data.summary,
        purpose: data.purpose,
        audience: data.audience,
        tone: data.tone,
        pacing: data.pacing,
        supplied: data.supplied,
        facts: data.facts,
        assumptions: data.assumptions,
        needsProductImage: data.needsProductImage,
        // Keep answered questions; add new ones.
        questions: [...b.questions.filter((q) => q.answer), ...data.questions.filter((q) => !b.questions.some((o) => o.answer && o.question === q.question))].slice(0, 3),
      };
      writeDoc(pid, "brief", next, { author: "agent", note: "Interpreted the idea", inputs: { brief: brief.version } });
      updateProject(pid, { title: next.title });
      const q = next.questions.find((x) => !x.answer);
      addMessage(pid, "agent", {
        text: `${data.summary.trim()}${q ? `\n\n${q.question}` : ""}`,
        choices: q?.choices,
        questionId: q?.id,
        stage: "brief",
      });
      if (!pipelineOf(getProject(pid)!).concepts && !conceptsDoc(pid)) setPipeline(pid, { concepts: true });
      return { done: { version: brief.version + 1 }, cents };
    },
  },

  "think.concepts": {
    paid: true,
    group: "think",
    async run(job) {
      const pid = job.project_id;
      const input = jobInput<{ direction?: string }>(job);
      const brief = briefDoc(pid)!;
      const prev = conceptsDoc(pid);
      const { concepts, cents } = await proposeConcepts({ brief: brief.data, direction: input.direction, previous: prev?.data.concepts, bill: bill(job, "Developing directions") });
      for (const c of concepts) {
        const prompt = conceptImagePrompt(c, brief.data);
        try {
          const { job: img } = enqueue({ projectId: pid, kind: "image.concept", key: { prompt, aspect: brief.data.aspect }, input: { projectId: pid, conceptId: c.id, prompt, aspect: brief.data.aspect }, estCents: PRICES.imageCents.gptImage, provider: "kie" });
          c.jobId = img.id;
        } catch (err) {
          console.warn("[concept image]", (err as Error).message);
        }
      }
      const set: ConceptSet = { concepts, chosenId: null, direction: input.direction };
      writeDoc(pid, "concepts", set, { author: "agent", note: input.direction ? `New directions: ${input.direction}` : "Three directions", inputs: { brief: brief.version } });
      setPipeline(pid, { concepts: false });
      const rec = concepts.find((c) => c.recommended)!;
      addMessage(pid, "agent", {
        text: `Three directions. I'd start with ${rec.title}.`,
        choices: concepts.map((c) => ({ id: c.id, label: c.title, recommended: c.recommended })),
        stage: "concept",
      });
      return { done: { count: concepts.length }, cents };
    },
  },

  "think.plan": {
    paid: true,
    group: "think",
    async run(job) {
      const pid = job.project_id;
      const input = jobInput<{ note?: string }>(job);
      const brief = briefDoc(pid)!;
      const concept = chosenConcept(pid);
      if (!concept) return { failed: "No direction has been chosen." };
      const current = planDoc(pid);
      const keep = current && current.inputs.conceptId === concept.id ? current.data : null;
      const { plan, cents } = await writePlan({ brief: brief.data, concept, current: input.note ? keep : null, note: input.note, bill: bill(job, "Writing the plan") });
      // A newer instruction for the plan supersedes this one: never overwrite it with an older answer.
      if (newerStep(job)) return { done: { superseded: true }, cents };
      if (keep?.voice.voiceId) plan.voice.voiceId = keep.voice.voiceId;
      if (keep?.voice.cast) plan.voice.cast = keep.voice.cast;
      writeDoc(pid, "plan", plan, { author: "agent", note: input.note ? `Revised: ${input.note}` : "First draft", inputs: { brief: brief.version, concepts: conceptsDoc(pid)!.version, conceptId: concept.id, ...(concept.story ? { storyKey: hashKey(concept.story) } : {}) } });
      addMessage(pid, "agent", { text: input.note ? "Sequence revised. Shots it affects are marked." : "Preparing your cast, places and props.", stage: input.note ? "shots" : "assets" });
      return { done: {}, cents };
    },
  },

  "think.assets": {
    paid: true,
    group: "think",
    async run(job) {
      const pid = job.project_id;
      const brief = briefDoc(pid)!;
      const concept = chosenConcept(pid)!;
      const plan = planDoc(pid)!;
      const existing = listAssets(pid);
      const { assets, cents } = await planAssets({
        brief: brief.data,
        concept,
        plan: plan.data,
        existing: existing.map((a) => ({ kind: a.kind, name: a.name, description: json<{ description: string }>(a.data, { description: "" }).description })),
        bill: bill(job, "Planning the cast"),
      });
      let created = 0;
      for (const a of assets) {
        const match = existing.find((e) => e.kind === a.kind && e.name.toLowerCase() === a.name.toLowerCase());
        if (match) continue;
        createAsset({ projectId: pid, kind: a.kind, name: a.name, data: a.data });
        created++;
      }
      setPipeline(pid, { assetsForPlan: plan.version });
      addMessage(pid, "agent", { text: created ? `Cast and places proposed: ${describeList(assets.map((a) => a.name))}.` : "Your existing assets cover it.", stage: "assets" });
      return { done: { created }, cents };
    },
  },

  "think.shots": {
    paid: true,
    group: "think",
    async run(job) {
      const pid = job.project_id;
      const input = jobInput<{ note?: string }>(job);
      const brief = briefDoc(pid)!;
      const concept = chosenConcept(pid)!;
      const plan = planDoc(pid)!;
      const current = shotsDoc(pid);
      const assets = listAssets(pid).map((a) => ({ id: a.id, kind: a.kind, name: a.name }));
      const { shots, cents } = await proposeShots({ brief: brief.data, concept, plan: plan.data, assets, note: input.note, current: input.note ? current?.data.shots : undefined, bill: bill(job, "Planning the shots") });
      if (newerStep(job)) return { done: { superseded: true }, cents };
      // Shots whose content is unchanged keep their revision so their footage stays current.
      const prevById = new Map((current?.data.shots ?? []).map((s) => [s.id, s]));
      for (const s of shots) {
        const prev = prevById.get(s.id);
        if (prev && samePicture(prev, s)) s.rev = prev.rev;
        if (prev?.direction) s.direction = prev.direction;
      }
      writeDoc(pid, "shots", { shots }, { author: "agent", note: input.note ? `Revised: ${input.note}` : "Shot plan", inputs: { plan: plan.version } });
      addMessage(pid, "agent", { text: `${shots.length} shots, ${brief.data.duration} seconds. Blocking and storyboard frames next.`, stage: "shots" });
      return { done: { count: shots.length }, cents };
    },
  },

  "image.concept": {
    paid: true,
    group: "image",
    async run(job) {
      const i = jobInput<{ prompt: string; aspect: "16:9" | "9:16" }>(job);
      return submitImage(job.project_id, { prompt: i.prompt, aspect: i.aspect, references: [] });
    },
    async poll(job) {
      const o = await pollImage(job);
      if (!("url" in o)) return o;
      const m = await storeImage(job.project_id, o.url, "concept", { jobId: job.id });
      return { done: { mediaId: m.id }, cents: o.cents };
    },
  },

  "image.asset": {
    paid: true,
    group: "image",
    async run(job) {
      const i = jobInput<{ assetId: string; versionId: string; prompt: string; aspect: "16:9" | "9:16"; identityVersionId?: string | null }>(job);
      const asset = getAsset(i.assetId);
      if (!asset) return { failed: "The asset no longer exists." };
      const role: RefRole = asset.kind === "location" ? "location" : asset.kind === "prop" ? "prop" : "character";
      const references: { url: string; role: RefRole; label: string }[] = [];
      // A supplied photo anchors the identity of any generated view; otherwise the approved primary image does.
      const upload = assetVersions(asset.id).find((v) => v.source === "upload" && v.status === "ready" && v.media_id);
      const identity = i.identityVersionId ? getAssetVersion(i.identityVersionId) : null;
      if (upload) references.push({ url: await publicUrl(getMedia(upload.media_id)!), role, label: `${asset.name}, as supplied by the client: keep this exact identity` });
      else if (identity?.media_id) references.push({ url: await publicUrl(getMedia(identity.media_id)!), role, label: `${asset.name}, the approved look: keep this exact identity` });
      setAssetVersion(i.versionId, { status: "pending", jobId: job.id });
      return submitImage(job.project_id, { prompt: i.prompt, aspect: i.aspect, references });
    },
    async poll(job) {
      const i = jobInput<{ versionId: string }>(job);
      const o = await pollImage(job);
      if (!("url" in o)) return o;
      const m = await storeImage(job.project_id, o.url, "asset", { versionId: i.versionId });
      setAssetVersion(i.versionId, { mediaId: m.id, status: "ready" });
      // A reference that came back as a contact sheet is separated into single images (free).
      const ver = getAssetVersion(i.versionId);
      if (ver && (ver.role ?? "primary") === "primary") {
        try {
          const { separateSheet } = await import("./collage");
          await separateSheet(job.project_id, ver.asset_id, ver.id);
        } catch (err) {
          console.warn("[collage]", (err as Error).message);
        }
      }
      return { done: { mediaId: m.id }, cents: o.cents };
    },
    onFail(job) {
      setAssetVersion(jobInput<{ versionId: string }>(job).versionId, { status: "failed" });
    },
  },

  capture: {
    paid: false,
    group: "capture",
    async run(job) {
      const i = jobInput<{ frameId: string; sceneId: string; t: number }>(job);
      const p = getProject(job.project_id)!;
      const { width, height } = p.aspect === "16:9" ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
      const shots = await captureScene({ sceneRowId: i.sceneId, shots: [{ t: i.t, view: "camera" }], width, height });
      const png = shots[0]?.png;
      if (!png) return { failed: "The blocking renderer returned nothing." };
      const m = saveMedia({ projectId: job.project_id, bytes: png, mime: "image/png", provenance: "blocking", width, height, name: "capture", meta: { sceneId: i.sceneId, t: i.t } });
      updateFrame(i.frameId, { mediaId: m.id, status: "ready" });
      return { done: { mediaId: m.id } };
    },
    onFail(job) {
      updateFrame(jobInput<{ frameId: string }>(job).frameId, { status: "failed" });
    },
  },

  "image.storyboard": {
    paid: true,
    group: "image",
    async run(job) {
      const i = jobInput<{ frameId: string; shotId: string; sceneId: string; note?: string | null; previousId?: string | null }>(job);
      const pid = job.project_id;
      const p = getProject(pid)!;
      const frame = getFrame(i.frameId);
      const shot = shotsDoc(pid)?.data.shots.find((s) => s.id === i.shotId);
      const scene = sceneById(i.sceneId);
      if (!frame || !shot || !scene) return { failed: "The shot changed before its frame was drawn." };
      const fi = frameInputs(frame);
      const identities = assetIdentities(pid);
      const references: { url: string; role: RefRole; label: string }[] = [];
      // In a detail or hands shot a portrait reference must not pull the face into frame.
      const tight = shot.framing === "detail" || scene.data.camera.focus === "hands" || scene.data.camera.focus === "prop";
      for (const aid of shotAssetIds(shot)) {
        const id = identities.find((x) => x.asset.id === aid);
        const vid = fi.assets?.[aid];
        const version = vid ? getAssetVersion(vid) : null;
        const m = getMedia(version?.media_id);
        if (!id || !m) continue;
        const role: RefRole = id.asset.kind === "location" ? "location" : id.asset.kind === "prop" ? "prop" : "character";
        const label =
          role === "character"
            ? tight
              ? `${id.asset.name}: only hands, sleeves and clothing appear in this frame; match the skin and clothing, and keep the face out of frame`
              : `${id.asset.name}: keep this person's face, hair, build and wardrobe exactly`
            : role === "location"
              ? `${id.asset.name}: the same place, its architecture, materials and light`
              : `${id.asset.name}: the same object, shape, colour and material`;
        references.push({ url: await publicUrl(m), role, label });
      }
      const capture = getFrame(fi.captureId ?? null);
      const capMedia = getMedia(capture?.media_id);
      if (capMedia) references.push({ url: await publicUrl(capMedia), role: "layout", label: "Grey blocking render of this exact shot" });
      const previous = getMedia(getFrame(i.previousId ?? null)?.media_id);
      if (previous) references.push({ url: await publicUrl(previous), role: "style", label: "The current version of this frame: keep everything the requested change doesn't mention" });
      const { camera, staging } = describeForPrompt(scene.data);
      const names = {
        characters: shot.characterIds.map((c) => identities.find((x) => x.asset.id === c)?.asset.name).filter(Boolean) as string[],
        location: identities.find((x) => x.asset.id === shot.locationId)?.asset.name ?? null,
        props: shot.propIds.map((c) => identities.find((x) => x.asset.id === c)?.asset.name).filter(Boolean) as string[],
      };
      const look = chosenConcept(pid)?.look ?? briefDoc(pid)!.data.tone;
      const prompt = `${tight ? "Composition: a tight close-up detail; the action described fills the frame, no faces, no full figures.\n" : ""}${storyboardPrompt({ shot, staging, camera, look, names, note: i.note ?? null, keepPrevious: !!previous })}`;
      updateFrame(i.frameId, { status: "pending", jobId: job.id });
      return submitImage(pid, { prompt, aspect: p.aspect, references });
    },
    async poll(job) {
      const i = jobInput<{ frameId: string; note?: string | null }>(job);
      const o = await pollImage(job);
      if (!("url" in o)) return o;
      const m = await storeImage(job.project_id, o.url, "storyboard", { frameId: i.frameId });
      updateFrame(i.frameId, { mediaId: m.id, status: "ready" });
      // A redraw made from a note is checked for drift against the approved references.
      if (i.note) enqueue({ projectId: job.project_id, kind: "review.frame", key: { frameId: i.frameId }, input: { projectId: job.project_id, frameId: i.frameId }, estCents: 0, provider: "anthropic", authId: job.auth_id });
      return { done: { mediaId: m.id }, cents: o.cents };
    },
    onFail(job) {
      updateFrame(jobInput<{ frameId: string }>(job).frameId, { status: "failed" });
    },
  },

  "video.clip": {
    paid: true,
    group: "video",
    async run(job) {
      const i = jobInput<{ shotId: string; frameId: string; sceneId: string; seconds: number; note: string | null }>(job);
      const pid = job.project_id;
      const p = getProject(pid)!;
      const frame = getFrame(i.frameId);
      const m = getMedia(frame?.media_id);
      const shot = shotsDoc(pid)?.data.shots.find((s) => s.id === i.shotId);
      const scene = sceneById(i.sceneId) ?? latestScene(pid, i.shotId);
      if (!m || !shot || !scene) return { failed: "The storyboard frame is missing." };
      const { camera, staging } = describeForPrompt(scene.data);
      const look = chosenConcept(pid)?.look ?? "";
      const prompt = `${clipPrompt({ shot, camera, staging, look })}${i.note ? `\nDirection: ${i.note}` : ""}`;
      const r = await mediaFor(pid).clipSubmit({
        frameUrl: await publicUrl(m),
        prompt,
        seconds: i.seconds,
        aspect: p.aspect,
        resolution: VIDEO_RESOLUTION,
        cameraFixed: scene.data.camera.move === "static",
        pathname: `fast-lane/${pid}/takes/${job.id}.mp4`,
      });
      return { submitted: r.handle, provider: "kie", meta: { providerTaskId: r.providerTaskId, model: r.model, prompt } };
    },
    async poll(job) {
      const r = await freeMedia().clipPoll(job.provider_task_id!);
      if (r.status === "pending") return { pending: 12 };
      if (r.status === "failed") return { failed: r.rejected ? `The provider refused this shot: ${r.error}` : r.error, charged: false };
      const m = await downloadToMedia({ projectId: job.project_id, url: r.url, provenance: "live", name: "take", fallbackMime: "video/mp4", meta: { jobId: job.id } });
      await attachPreview(m);
      for (const take of takesForJob(job.id)) {
        updateTake(take, { mediaId: m.id, status: "ready" });
        // Reviews run under the same approval as the take they check.
        enqueue({ projectId: job.project_id, kind: "review.take", key: { takeId: take }, input: { projectId: job.project_id, takeId: take }, estCents: 0, provider: "anthropic", authId: job.auth_id });
      }
      return { done: { mediaId: m.id }, cents: r.cents };
    },
    onFail(job) {
      for (const take of takesForJob(job.id)) updateTake(take, { status: "failed" });
    },
  },

  "review.take": {
    paid: true,
    group: "review",
    async run(job) {
      const { takeId } = jobInput<{ takeId: string }>(job);
      const review = await reviewTake(takeId, bill(job, "Reviewing a take"));
      updateTake(takeId, { review });
      return { done: { usable: review.usable }, cents: review.cents };
    },
  },

  "review.frame": {
    paid: true,
    group: "review",
    async run(job) {
      const { frameId } = jobInput<{ frameId: string }>(job);
      const r = await reviewFrame(frameId, bill(job, "Checking a redrawn frame"));
      setFrameMeta(frameId, { drift: r.drift, followedNote: r.followedNote, check: r.summary });
      return { done: { drift: r.drift }, cents: r.cents };
    },
  },

  "audio.voice": {
    paid: true,
    group: "audio",
    async run(job) {
      const i = jobInput<{ lineId: string; text: string; voiceId: string }>(job);
      const dir = path.join(MEDIA_DIR, job.project_id, "voice");
      fs.mkdirSync(dir, { recursive: true });
      const rel = path.join(job.project_id, "voice", `${i.lineId}-${job.id}.mp3`);
      const r = await mediaFor(job.project_id).speak({ text: i.text, voiceId: i.voiceId, outPath: path.join(MEDIA_DIR, rel) });
      const m = registerMedia({ projectId: job.project_id, relPath: rel, mime: "audio/mpeg", provenance: "live", duration: r.durationMs / 1000, meta: { words: r.words } });
      // Every line record waiting on this recording receives it.
      for (const audio of audioForJob(job.id)) updateAudio(audio, { mediaId: m.id, status: "ready", data: { durationMs: r.durationMs, words: r.words } });
      return { done: { mediaId: m.id, durationMs: r.durationMs }, cents: r.cents };
    },
    onFail(job) {
      for (const audio of audioForJob(job.id)) updateAudio(audio, { status: "failed" });
    },
  },

  "audio.music": {
    paid: true,
    group: "audio",
    async run(job) {
      const i = jobInput<{ mood: string; seconds: number; title: string }>(job);
      const r = await mediaFor(job.project_id).musicSubmit({ style: i.mood, title: i.title, seconds: i.seconds });
      return { submitted: r.taskId, provider: "kie" };
    },
    async poll(job) {
      const i = jobInput<{ seconds: number }>(job);
      const media = freeMedia();
      const r = await media.musicPoll(job.provider_task_id!);
      if (r.state === "pending") return { pending: 10 };
      if (r.state === "fail") return { failed: r.error };
      const dir = path.join(MEDIA_DIR, job.project_id, "music");
      fs.mkdirSync(dir, { recursive: true });
      const done = await media.musicFinish({ trackUrls: r.trackUrls, seconds: i.seconds, outDir: dir, name: `bed-${job.id}` });
      const m = registerMedia({ projectId: job.project_id, relPath: path.relative(MEDIA_DIR, done.path), mime: "audio/mpeg", provenance: "live", duration: done.durationMs / 1000 });
      for (const audio of audioForJob(job.id)) updateAudio(audio, { mediaId: m.id, status: "ready", data: { durationMs: done.durationMs } });
      return { done: { mediaId: m.id, durationMs: done.durationMs }, cents: r.cents };
    },
    onFail(job) {
      for (const audio of audioForJob(job.id)) updateAudio(audio, { status: "failed" });
    },
  },

  assemble: {
    paid: false,
    group: "assemble",
    async run(job) {
      const { cutId } = jobInput<{ cutId: string }>(job);
      const cut = getCut(cutId);
      if (!cut) return { failed: "The cut no longer exists." };
      const manifest = json<CutManifest>(cut.manifest, null as unknown as CutManifest);
      const pid = job.project_id;
      const p = getProject(pid)!;
      const media = freeMedia();
      const workDir = path.join(MEDIA_DIR, pid, "cuts");
      fs.mkdirSync(workDir, { recursive: true });
      const { width, height } = frameSize(manifest.aspect);
      const black = await blackStill(path.join(workDir, `black-${width}x${height}.png`), width, height);

      const clips: AssembleRequest["clips"] = manifest.shots.map((s) => {
        const m = getMedia(s.mediaId);
        if (!m) return { path: black, trimInMs: 0, durationMs: Math.round(s.duration * 1000), still: true };
        return { path: absPath(m), trimInMs: Math.round(s.trimIn * 1000), durationMs: Math.round(s.duration * 1000), still: m.kind === "image" };
      });
      const overlays: AssembleRequest["overlays"] = [];
      const overlayDir = path.join(MEDIA_DIR, pid, "overlays");
      fs.mkdirSync(overlayDir, { recursive: true });
      for (const s of manifest.supers) {
        const out = path.join(overlayDir, `${hashText(`${s.text}|${s.style}|${width}x${height}`)}.png`);
        if (!fs.existsSync(out)) await media.renderOverlay({ width, height, text: s.text, style: s.style, outPath: out });
        overlays.push({ pngPath: out, startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000) });
      }
      if (manifest.endCard) {
        const e = manifest.endCard;
        const out = path.join(overlayDir, `${hashText(`${e.line}|${e.detail ?? ""}|end-v3|${width}x${height}`)}.png`);
        if (!fs.existsSync(out)) await media.renderOverlay({ width, height, text: e.line, detail: e.detail, style: "end", outPath: out });
        overlays.push({ pngPath: out, startMs: Math.round(e.start * 1000), endMs: Math.round(manifest.duration * 1000) });
      }
      const voice = manifest.voice.map((v) => ({ path: absPath(getMedia(v.mediaId)!), startMs: Math.round(v.start * 1000) }));
      const musicMedia = manifest.music ? getMedia(manifest.music.mediaId) : null;
      const live = manifest.shots.every((s) => s.takeId);
      const label = live ? "" : "-preview";
      const rel = path.join(pid, "cuts", `${p.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${String(cut.version).padStart(2, "0")}${label}-${cut.id.slice(-6)}.mp4`);
      const result = await media.assemble({
        width,
        height,
        fps: 30,
        clips,
        overlays,
        voice,
        music: musicMedia ? { path: absPath(musicMedia), gainDb: manifest.music!.gainDb } : null,
        outPath: path.join(MEDIA_DIR, rel),
        loudnessTarget: -14,
      });
      const m = registerMedia({ projectId: pid, relPath: rel, mime: "video/mp4", provenance: p.sample ? "sample" : live ? "assembled" : "blocking", width: result.width, height: result.height, duration: result.durationMs / 1000, meta: { cutId } });
      await attachPreview(m);
      const review = await reviewCut(manifest, result);
      updateCut(cutId, { mediaId: m.id, status: "ready", review });
      const failing = review.checks.filter((c) => !c.ok && c.label !== "Footage");
      const standIns = review.standIns;
      announceOnce(pid, `cut:${cutId}`, {
        text: `Version ${String(cut.version).padStart(2, "0")} is ready: ${standIns === manifest.shots.length ? "a storyboard animatic" : standIns ? `${manifest.shots.length - standIns} of ${manifest.shots.length} shots are footage` : "all footage"}.${failing.length ? ` Check: ${failing.map((c) => c.label.toLowerCase()).join(", ")}.` : ""}`,
        stage: "cut",
      });
      return { done: { mediaId: m.id } };
    },
    onFail(job) {
      updateCut(jobInput<{ cutId: string }>(job).cutId, { status: "failed" });
    },
  },
};

/** Was a later step of the same kind asked for in this project (queued, running or done)? */
function newerStep(job: JobRow): boolean {
  return !!db().prepare("select 1 from jobs where project_id = ? and kind = ? and created_at > ? and id != ? and status in ('queued', 'running', 'succeeded') limit 1").get(job.project_id, job.kind, job.created_at, job.id);
}

function takesForJob(jobId: string): string[] {
  return (db().prepare("select id from takes where job_id = ?").all(jobId) as { id: string }[]).map((r) => r.id);
}

function audioForJob(jobId: string): string[] {
  return (db().prepare("select id from audio where job_id = ?").all(jobId) as { id: string }[]).map((r) => r.id);
}

function hashText(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function describeList(names: string[]) {
  if (names.length <= 1) return names[0] ?? "nobody";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function samePicture(a: { description: string; action: string; framing: string; move: string; lens: number; characterIds: string[]; propIds: string[]; locationId: string | null }, b: typeof a) {
  return a.description === b.description && a.action === b.action && a.framing === b.framing && a.move === b.move && a.lens === b.lens && a.locationId === b.locationId && a.characterIds.join() === b.characterIds.join() && a.propIds.join() === b.propIds.join();
}

/* ---------------- dispatch gate ---------------- */

/**
 * May this queued job start now? Billable work needs the spending gate and an approval with
 * room; a job whose reservation was already made at enqueue has its room. Free work always may.
 */
export function dispatchGate(job: JobRow): { ok: true } | { ok: false; reason: string } {
  const cls = spendClassOf(job.kind);
  if (!cls) return { ok: true };
  const gate = spendGate(job.project_id);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  if (job.est_cents > 0) {
    const a = getAuthorization(job.auth_id);
    if (!a || a.status !== "active") return { ok: false, reason: "The approval this work was bought under has been closed." };
    return { ok: true };
  }
  // Model steps reserve per call; make sure one bounded call fits before starting.
  try {
    const room = job.kind.startsWith("review.") ? REVIEW_CENTS.bound : MODEL_STEP_CENTS;
    const a = chooseAuthorization(job.project_id, cls, room, job.auth_id && getAuthorization(job.auth_id)?.status === "active" ? job.auth_id : null);
    if (!job.auth_id || job.auth_id !== a.id) db().prepare("update jobs set auth_id = ? where id = ?").run(a.id, job.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/* ---------------- loop ---------------- */

type WorkerState = { started: boolean; running: Set<string>; timer?: NodeJS.Timeout; sweep?: NodeJS.Timeout; lastTick?: string };
const state: WorkerState = ((globalThis as typeof globalThis & { __fastLaneWorker?: WorkerState }).__fastLaneWorker ??= { started: false, running: new Set() });

export function workerStatus() {
  return { started: state.started, running: [...state.running], lastTick: state.lastTick ?? null };
}

export function startWorker() {
  if (state.started) return;
  state.started = true;
  recover();
  state.timer = setInterval(() => void tick(), 1500);
  state.sweep = setInterval(() => void sweep(), 15_000);
  setTimeout(() => void sweep(), 2000);
  console.log("[worker] started");
}

/** Wake the loop now instead of waiting for the next tick. */
export function kick() {
  if (!state.started) return;
  setTimeout(() => void tick(), 50);
}

/**
 * After a restart: a paid submission caught mid-call becomes ambiguous (its money stays
 * reserved); a model step caught mid-call is re-run, and the interrupted call's possible
 * charge is recorded rather than forgotten.
 */
export function recover() {
  const stuck = db().prepare("select * from jobs where status in ('submitting', 'running')").all() as JobRow[];
  for (const job of stuck) {
    const h = handlers[job.kind];
    if (h?.paid && job.status === "submitting") {
      markAmbiguous(job, "The server stopped while this request was being sent. It may or may not have reached the provider.");
      continue;
    }
    if (spendClassOf(job.kind) === "model") {
      const open = openModelReservations(job.id);
      for (const r of open) settle(r.ref, { cents: r.cents, basis: "uncertain", note: `${r.note} (interrupted by a restart; may have been billed)` });
      if (open.length) addMessage(job.project_id, "system", { text: `${labelFor(job.kind)} was interrupted by a restart. Running it again may repeat a model charge of up to ${centsText(open.reduce((a, r) => a + r.cents, 0))}.` });
    }
    db().prepare("update jobs set status = 'queued', next_run_at = ?, updated_at = ? where id = ? and status in ('submitting', 'running')").run(now(), now(), job.id);
  }
}

function centsText(c: number) {
  return `$${(c / 100).toFixed(2)}`;
}

async function sweep() {
  const rows = db().prepare("select id, pipeline from projects where sample = 0").all() as { id: string; pipeline: string }[];
  for (const r of rows) {
    const pipe = json<Record<string, unknown>>(r.pipeline, {});
    if (pipe.concepts || pipe.develop || pipe.produce) await advance(r.id);
  }
}

export async function tick() {
  state.lastTick = now();
  let due: JobRow[];
  try {
    due = dueJobs(24);
  } catch (err) {
    console.error("[worker] tick", err);
    return;
  }
  const counts: Record<string, number> = {};
  for (const id of state.running) {
    const j = getJob(id);
    const g = j ? handlers[j.kind]?.group : undefined;
    if (g) counts[g] = (counts[g] ?? 0) + 1;
  }
  for (const job of due) {
    if (state.running.has(job.id)) continue;
    const h = handlers[job.kind];
    if (!h) {
      fail(job, `No handler for ${job.kind}`);
      continue;
    }
    if (job.status === "queued") {
      const gate = dispatchGate(job);
      if (!gate.ok) {
        if (job.hold !== gate.reason) holdJob(job.id, gate.reason);
        else reschedule(job.id, 120);
        continue;
      }
    }
    if ((counts[h.group] ?? 0) >= LIMITS[h.group]) continue;
    counts[h.group] = (counts[h.group] ?? 0) + 1;
    state.running.add(job.id);
    void processJob(job, h).finally(() => state.running.delete(job.id));
  }
}

export async function processJob(job: JobRow, h: Handler = handlers[job.kind]) {
  let outcome: Outcome;
  if (job.status === "queued") {
    if (!claim(job.id, ["queued"], h.paid && !job.kind.startsWith("think.") && !job.kind.startsWith("review.") ? "submitting" : "running")) return;
    const fresh = getJob(job.id)!;
    try {
      outcome = await h.run(fresh);
    } catch (err) {
      outcome = errorOutcome(err, h.paid && !job.kind.startsWith("think.") && !job.kind.startsWith("review."));
    }
  } else if (job.status === "submitted" && h.poll) {
    if (!leasePoll(job.id)) return;
    const minutes = (Date.now() - Date.parse(job.started_at ?? job.created_at)) / 60_000;
    if (minutes > CEILING_MINUTES[h.group]) {
      // The provider may still finish (and charge), so this is a person's call, never a blind re-buy.
      markAmbiguous(job, `No result after ${Math.round(minutes)} minutes (task ${job.provider_task_id}). It may still finish at the provider.`);
      addMessage(job.project_id, "system", { text: `${labelFor(job.kind)} is taking far longer than usual. I've stopped waiting; check it under Jobs.` });
      return;
    }
    try {
      outcome = await h.poll(job);
    } catch (err) {
      // Polling never buys anything, so any error here is safe to retry later.
      const msg = err instanceof Error ? err.message : String(err);
      outcome = job.attempts > 120 ? { failed: msg } : { pending: 20 };
      db().prepare("update jobs set attempts = attempts + 1 where id = ?").run(job.id);
    }
  } else return;

  const current = getJob(job.id)!;
  try {
    if ("submitted" in outcome) {
      markSubmitted(job.id, outcome.provider, outcome.submitted);
      if (outcome.meta) db().prepare("update jobs set output = ? where id = ?").run(JSON.stringify({ submittedMeta: outcome.meta }), job.id);
    } else if ("pending" in outcome) {
      if (current.status === "submitting" || current.status === "running") db().prepare("update jobs set status = 'queued' where id = ? and status in ('submitting', 'running')").run(job.id);
      reschedule(job.id, outcome.pending);
    } else if ("done" in outcome) {
      const prevMeta = json<{ submittedMeta?: unknown }>(current.output, {}).submittedMeta;
      // Model steps were charged per response; only provider purchases settle here.
      const providerCents = spendClassOf(job.kind) === "model" ? null : (outcome.cents ?? null);
      if (succeed(current, { ...outcome.done, ...(prevMeta ? { submittedMeta: prevMeta } : {}) }, providerCents)) settleFallback(current, true);
      await advance(job.project_id);
    } else if ("ambiguous" in outcome) {
      if (markAmbiguous(current, outcome.ambiguous)) addMessage(job.project_id, "system", { text: `A ${labelFor(job.kind).toLowerCase()} request may or may not have reached the provider. I won't resend it on my own; check it under Jobs.` });
    } else if ("held" in outcome) {
      db().prepare("update jobs set status = 'queued' where id = ? and status in ('submitting', 'running')").run(job.id);
      holdJob(job.id, outcome.held);
    } else {
      if (fail(current, outcome.failed, outcome.charged)) {
        settleFallback(current, !!outcome.charged);
        try {
          h.onFail?.(current, outcome.failed);
        } catch (err) {
          console.error("[worker] onFail", err);
        }
        if (!job.kind.startsWith("review")) addMessage(job.project_id, "system", { text: `${labelFor(job.kind)} failed: ${outcome.failed}` });
      }
      await advance(job.project_id);
    }
  } finally {
    releaseLease(job.id);
  }
}

export function labelFor(kind: string): string {
  return (
    {
      "think.brief": "Reading the brief",
      "think.concepts": "Developing directions",
      "think.plan": "Writing the plan",
      "think.assets": "Planning the cast",
      "think.shots": "Planning the shots",
      "image.concept": "Concept frame",
      "image.asset": "Reference image",
      "image.storyboard": "Storyboard frame",
      capture: "Blocking capture",
      "video.clip": "Video take",
      "review.take": "Take review",
      "review.frame": "Frame check",
      "audio.voice": "Voice line",
      "audio.music": "Music bed",
      assemble: "Assembly",
    }[kind] ?? kind
  );
}

/**
 * Try failed work again. Money for it is reserved afresh under an approval with room (the job's
 * own, or one that covers it); with no room it is refused and the person is asked for an
 * estimate instead. Uncertain work is never re-bought here: see checkAgain and buyAgain.
 */
export function retryJob(jobId: string): { ok: boolean; summary: string } {
  const job = getJob(jobId);
  if (!job || job.status !== "failed") return { ok: false, summary: "Only failed work can be retried." };
  const cls = spendClassOf(job.kind);
  const seq = (job.charge_seq ?? 1) + 1;
  try {
    let authId = job.auth_id;
    if (job.est_cents > 0 && cls) {
      const a = getAuthorization(job.auth_id);
      const usable = a && a.status === "active" && authCovers(a).includes(cls) && authRemaining(a) >= job.est_cents ? a.id : null;
      authId = reserve(job.project_id, { cls, cents: job.est_cents, ref: `job:${job.id}:${seq}`, jobId: job.id, authId: usable, note: `${job.kind} retry` }).authId;
    } else if (cls) {
      const gate = spendGate(job.project_id);
      if (!gate.ok) return { ok: false, summary: gate.reason };
    }
    db().prepare("update jobs set status = 'queued', error = null, provider_task_id = null, output = null, charge_seq = ?, auth_id = ?, hold = null, next_run_at = ?, updated_at = ? where id = ? and status = 'failed'").run(seq, authId, now(), now(), jobId);
  } catch (err) {
    return { ok: false, summary: err instanceof Error ? err.message : String(err) };
  }
  resetTargets(jobId);
  kick();
  return { ok: true, summary: `Retrying${job.est_cents ? ` (about ${centsText(job.est_cents)})` : ""}.` };
}

/** Uncertain work with a provider task id: ask the provider again (free; keeps the hold). */
export function checkAgain(jobId: string): { ok: boolean; summary: string } {
  const job = getJob(jobId);
  if (!job || job.status !== "ambiguous") return { ok: false, summary: "Nothing uncertain to check." };
  if (!job.provider_task_id) return { ok: false, summary: "This request never received a provider task id, so it can't be looked up. Check the provider's dashboard, then mark it." };
  db().prepare("update jobs set status = 'submitted', started_at = ?, next_run_at = ?, updated_at = ? where id = ? and status = 'ambiguous'").run(now(), now(), now(), jobId);
  kick();
  return { ok: true, summary: "Checking with the provider again. Nothing is bought." };
}

/**
 * Uncertain work bought again on a person's explicit instruction. The old request keeps its
 * hold (it may still be charged) and the new attempt reserves its own money.
 */
export function buyAgain(jobId: string): { ok: boolean; summary: string; jobId?: string } {
  const job = getJob(jobId);
  if (!job || job.status !== "ambiguous") return { ok: false, summary: "Only uncertain work can be bought again." };
  const cls = spendClassOf(job.kind);
  try {
    const jid = newId("job");
    const t = now();
    const idem = `${job.idem_key}:again:${jid}`;
    db()
      .prepare("insert into jobs (id, project_id, kind, idem_key, status, provider, input, est_cents, next_run_at, created_at, updated_at, charge_seq) values (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 1)")
      .run(jid, job.project_id, job.kind, idem, job.provider, job.input, job.est_cents, t, t, t);
    try {
      if (job.est_cents > 0 && cls) {
        const { authId } = reserve(job.project_id, { cls, cents: job.est_cents, ref: `job:${jid}:1`, jobId: jid, authId: null, note: `${job.kind} bought again` });
        db().prepare("update jobs set auth_id = ? where id = ?").run(authId, jid);
      }
    } catch (err) {
      db().prepare("delete from jobs where id = ?").run(jid);
      throw err;
    }
    // Records waiting on the uncertain request now wait on the new one.
    for (const table of ["frames", "takes", "asset_versions", "audio", "cuts"]) db().prepare(`update ${table} set job_id = ? where job_id = ?`).run(jid, jobId);
    resetTargets(jid);
    kick();
    return { ok: true, summary: `Bought again (about ${centsText(job.est_cents)}). The first request's ${centsText(job.est_cents)} stays held until you mark it.`, jobId: jid };
  } catch (err) {
    return { ok: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

function resetTargets(jobId: string) {
  // Rows that showed "failed" go back to pending.
  for (const table of ["frames", "takes", "asset_versions", "audio", "cuts"]) db().prepare(`update ${table} set status = 'pending' where job_id = ? and status = 'failed'`).run(jobId);
  const j = getJob(jobId);
  if (j) db().prepare("update projects set rev = rev + 1 where id = ?").run(j.project_id);
}

export { takesForProject, REVIEW_CENTS };
