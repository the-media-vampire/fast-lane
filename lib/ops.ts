import { z } from "zod";
import { applyCommands } from "./blocking/commands";
import { SceneCommand } from "./blocking/types";
import { getJob, hashKey, cancel, resolveUncertain } from "./jobs";
import { allowanceOf, authCovers, authRemaining, closeAuthorization, createAuthorization, money, spend, spendGate, SpendBlocked, type AuthKind, type SpendClass } from "./billing";
import { createQuote, getQuote, markQuote, quoteView, takeQuote, type QuoteDetail, type QuoteView } from "./quotes";
import { approveAssetVersion, approveCut, approveSequence, sequenceStatus, shotPrint } from "./approvals";
import { reviseShot, fitDurations } from "./creative";
import { db, tx } from "./db";
import {
  acceptTake,
  addMessage,
  addTake,
  assetData,
  assetVersions,
  getAsset,
  getAssetVersion,
  getCut,
  getProject,
  getTake,
  keepAssetVersion,
  latestScene,
  sceneHistory,
  sceneById,
  updateAsset,
  updateProject,
  updateTake,
  writeDoc,
  writeScene,
  type MessageContent,
} from "./repo";
import {
  advance,
  blockShot,
  buildManifest,
  chooseConcept,
  estimateProduction,
  queueCut,
  queueStoryboard,
  requestAssetImage,
  retakeShot,
  shotTitle,
  startProduction,
  startSound,
  syncSceneToShot,
  thinkJob,
  RESOLUTION,
  REVIEW_CENTS,
} from "./pipeline";
import { activeJobs, assetIdentities, briefDoc, conceptsDoc, pipelineOf, planDoc, setPipeline, shotAssetIds, shotStates, shotsDoc, clipSeconds } from "./state";
import { retryJob, checkAgain, buyAgain, kick } from "./worker";
import { getMedia } from "./media";
import { VOICES } from "./voices";
import { Aspect, ConceptStory, Framing, Kind, LIMITS, Move, STAGES, type Shot, type Stage } from "./types";
import { PRICES } from "./adapters/contract";

/**
 * Validated operations. The studio UI and Astra change project state only through these, so
 * conversational text never becomes an arbitrary write. Each returns a concrete result: what
 * changed, what it affects, and what it costs.
 *
 * Paid work: an operation that buys something runs only under an approval the person gave —
 * the planning allowance for small planning work, or a quote they accepted. Otherwise it
 * returns a quote and buys nothing. No input any agent can supply authorizes payment, and
 * person-only operations (approvals, allowances, budgets, uncertain-job rulings) refuse the
 * agent outright.
 */

export type Author = "user" | "agent";
export type OpContext = { authId?: string | null };
export type OpResult = {
  ok: boolean;
  summary: string;
  results?: { label: string; detail?: string; ok: boolean }[];
  navigate?: Stage;
  jobIds?: string[];
  /** A priced offer waiting for the person (rendered as a confirmation card). */
  quote?: QuoteView;
  data?: unknown;
};

type Price = {
  cents: number;
  ceilingCents: number;
  covers: SpendClass[];
  authKind: AuthKind;
  label: string;
  scope: string[];
  lines: { label: string; cents: number }[];
  notes: string[];
  /** Everything the price depends on; a change means a fresh quote. */
  fingerprint: unknown;
  /** Small planning work the person's allowance may pay for without a quote. */
  allowanceOk: boolean;
};

type Op<S extends z.ZodType> = {
  description: string;
  input: S;
  /** Only the person may run it (approvals, permissions, budgets). */
  person?: boolean;
  /** Allowed in the sample project (free, local, reversible). */
  sample?: boolean;
  /** For paid work: the scope and price, computed from current state. */
  price?(pid: string, input: z.infer<S>): Price | { ok: false; summary: string };
  run(pid: string, input: z.infer<S>, author: Author, ctx: OpContext): Promise<OpResult> | OpResult;
};

function op<S extends z.ZodType>(o: Op<S>): Op<S> {
  return o;
}

function needShots(pid: string): Shot[] {
  const s = shotsDoc(pid);
  if (!s) throw new Error("There is no shot list yet.");
  return s.data.shots;
}

function writeShots(pid: string, shots: Shot[], author: Author, note: string) {
  const current = shotsDoc(pid)!;
  return writeDoc(pid, "shots", { shots }, { author, note, inputs: current.inputs });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (shots: Shot[], id: string) => shotTitle(shots, id).split(" · ")[0];

/** Plain-language "what this touches" for a set of shots. Nothing is regenerated here. */
function affected(pid: string, shotIds: string[]) {
  const shots = shotsDoc(pid)?.data.shots ?? [];
  const states = shotStates(pid, shots).filter((s) => shotIds.includes(s.shot.id));
  let cents = 0;
  const lines: string[] = [];
  for (const s of states) {
    const parts: string[] = [];
    if (s.storyboard) {
      parts.push("storyboard");
      cents += PRICES.imageCents.gptImage;
    }
    if (s.takes.some((t) => t.status === "ready" && t.source !== "upload")) {
      parts.push("footage");
      cents += Math.ceil(clipSeconds(s.shot.duration) * PRICES.videoCentsPerSecond[RESOLUTION]);
    }
    if (parts.length) lines.push(`${num(shots, s.shot.id)} ${parts.join(" and ")}`);
  }
  return {
    cents,
    lines,
    text: lines.length ? `Now outdated: ${lines.join(", ")}. Redoing would cost about ${money(cents)}; nothing is redone until you ask.` : "",
  };
}

/* ---------------- operations ---------------- */

const ShotFields = {
  title: z.string().optional(),
  summary: z.string().max(140).optional().describe("What happens, in a few plain words"),
  description: z.string().optional().describe("Detailed picture description used for generation"),
  action: z.string().optional(),
  direction: z.string().optional().describe("Standing direction for this shot only, e.g. 'She wears a dark wool hat.' Empty string clears it."),
  framing: Framing.optional(),
  move: Move.optional(),
  lens: z.number().min(18).max(135).optional(),
  locationId: z.string().nullable().optional(),
  characterIds: z.array(z.string()).max(LIMITS.characters).optional(),
  propIds: z.array(z.string()).optional(),
};

export const OPS = {
  update_brief: op({
    description: "Edit the brief: settings (kind, duration in whole seconds 30–120, aspect 16:9 or 9:16), purpose, audience, tone, pacing, facts, assumptions, or record the answer to an open question.",
    input: z.object({
      idea: z.string().min(3).optional(),
      title: z.string().optional(),
      kind: Kind.optional(),
      duration: z.number().int().min(30).max(120).optional(),
      aspect: Aspect.optional(),
      purpose: z.string().optional(),
      audience: z.string().optional(),
      tone: z.string().optional(),
      pacing: z.string().optional(),
      facts: z.array(z.string()).optional(),
      assumptions: z.array(z.string()).optional(),
      answer: z.object({ questionId: z.string(), answer: z.string() }).optional(),
    }),
    run(pid, i, author) {
      const b = briefDoc(pid);
      if (!b) throw new Error("No brief.");
      const p = getProject(pid)!;
      const hasTakes = shotStates(pid, shotsDoc(pid)?.data.shots ?? []).some((s) => s.takes.some((t) => t.status === "ready"));
      if (i.aspect && i.aspect !== p.aspect && hasTakes) return { ok: false, summary: "The frame is fixed once footage exists. Start a new project for the other format." };
      const { answer, ...fields } = i;
      const next = { ...b.data, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
      if (answer) next.questions = next.questions.map((q) => (q.id === answer.questionId ? { ...q, answer: answer.answer } : q));
      if (i.purpose || i.audience || i.tone) next.supplied = { purpose: !!(i.purpose || b.data.supplied?.purpose), audience: !!(i.audience || b.data.supplied?.audience), tone: !!(i.tone || b.data.supplied?.tone) };
      writeDoc(pid, "brief", next, { author, note: answer ? `Answered: ${answer.answer}` : "Edited the brief", inputs: { brief: b.version } });
      const results: OpResult["results"] = [];
      if (i.title || i.kind || i.duration || i.aspect) updateProject(pid, { ...(i.title ? { title: i.title } : {}), ...(i.kind ? { kind: i.kind } : {}), ...(i.duration ? { duration: i.duration } : {}), ...(i.aspect ? { aspect: i.aspect } : {}) });
      if (i.duration && i.duration !== p.duration && planDoc(pid)) {
        thinkJob(pid, "think.plan", { conceptId: conceptsDoc(pid)?.data.chosenId, note: `Re-time the whole plan to exactly ${i.duration} seconds, keeping what works.` }, `retime-${i.duration}-${Date.now()}`);
        results.push({ label: `Re-timing the plan to ${i.duration} s`, ok: true });
      }
      if (i.aspect && i.aspect !== p.aspect) {
        const ids = assetIdentities(pid);
        for (const shot of shotsDoc(pid)?.data.shots ?? []) writeScene(pid, shot.id, { ...blockShot({ ...p, aspect: i.aspect }, shot, ids) }, "system", `Re-framed for ${i.aspect}`);
        results.push({ label: `Re-blocked every shot for ${i.aspect}`, detail: "Storyboard frames are now outdated.", ok: true });
      }
      if (i.idea && i.idea !== b.data.idea) {
        thinkJob(pid, "think.brief", { briefVersion: b.version + 1 }, `idea-${Date.now()}`);
        results.push({ label: "Re-reading the brief", ok: true });
      }
      kick();
      void advance(pid);
      return { ok: true, summary: answer ? "Noted." : "Brief updated.", results };
    },
  }),

  propose_concepts: op({
    description: "Develop three new creative directions, optionally steered by the person's direction (e.g. 'funnier', 'combine the first two'). Runs in the background under the planning allowance.",
    input: z.object({ direction: z.string().optional() }),
    run(pid, i) {
      const b = briefDoc(pid);
      if (!b?.data.purpose) return { ok: false, summary: "I'm still reading the brief; directions follow automatically." };
      const { job } = thinkJob(pid, "think.concepts", { briefVersion: b.version, direction: i.direction ?? null }, i.direction ? `dir-${Date.now()}` : undefined);
      kick();
      return { ok: true, summary: "Developing three directions (a few cents from the planning allowance).", jobIds: [job.id], navigate: "concept" };
    },
  }),

  choose_concept: op({
    description: "The person approves the complete story preview and starts assets and the storyboard. Merely selecting a card never runs this.",
    input: z.object({ conceptId: z.string(), conceptVersion: z.number().optional() }),
    person: true,
    async run(pid, i, author) {
      const current = conceptsDoc(pid);
      const selected = current?.data.concepts.find((c) => c.id === i.conceptId);
      if (!selected) return { ok: false, summary: "That direction is no longer available." };
      if (i.conceptVersion != null && i.conceptVersion !== current!.version) return { ok: false, summary: "The story changed. Review the updated preview before approving it." };
      if (current!.data.chosenId === i.conceptId && !selected.storyDraft) return { ok: true, summary: "This direction is already chosen.", navigate: "assets" };
      if (!ConceptStory.safeParse(selected.storyDraft ?? selected.story).success) return { ok: false, summary: "Ask Astra to expand this direction into a story preview first." };
      if (activeJobs(pid).some((j) => j.kind !== "image.concept")) return { ok: false, summary: "Let the current work finish before changing the story." };
      chooseConcept(pid, i.conceptId, author);
      await advance(pid);
      kick();
      const c = conceptsDoc(pid)!.data.concepts.find((k) => k.id === i.conceptId)!;
      return { ok: true, summary: `Developing ${c.title}.`, navigate: "assets" };
    },
  }),

  edit_concept_story: op({
    description: "Propose a revised story preview for one concept. Use the complete 4–6 beat story, preserving everything the person did not ask to change. Does not approve it, start assets or alter existing shots. Read get_concepts first.",
    input: z.object({ conceptId: z.string(), story: ConceptStory }),
    sample: true,
    run(pid, i, author) {
      const c = conceptsDoc(pid);
      const selected = c?.data.concepts.find((k) => k.id === i.conceptId);
      if (!c || !selected) return { ok: false, summary: "That direction is no longer available." };
      if (JSON.stringify(selected.storyDraft ?? selected.story) === JSON.stringify(i.story)) return { ok: true, summary: "The story already matches.", navigate: "concept" };
      writeDoc(pid, "concepts", { ...c.data, concepts: c.data.concepts.map((k) => k.id === i.conceptId ? { ...k, storyDraft: i.story } : k) }, { author, note: `Story preview revised: ${selected.title}`, inputs: c.inputs });
      return { ok: true, summary: "Story preview updated. Review it before creating assets.", navigate: "concept" };
    },
  }),

  revise_plan: op({
    description: "Rewrite the plan from a plain-language note (structure, beats, voiceover, on-screen words, dialogue, a new length). Runs in the background. Shots it doesn't affect keep their work.",
    input: z.object({ note: z.string().min(2) }),
    run(pid, i) {
      if (!planDoc(pid)) return { ok: false, summary: "There is no plan yet." };
      const { job } = thinkJob(pid, "think.plan", { note: i.note, conceptId: conceptsDoc(pid)?.data.chosenId }, `note-${Date.now()}`);
      kick();
      return { ok: true, summary: "Revising the sequence (about $0.10 from the planning allowance).", jobIds: [job.id], navigate: "shots" };
    },
  }),

  edit_line: op({
    description: "Change the words of one voiceover, dialogue or on-screen line by id. Footage is reused; only that line's voice and the assembly are redone.",
    input: z.object({ lineId: z.string(), text: z.string().min(1).max(400) }),
    sample: true,
    run(pid, i, author) {
      const plan = planDoc(pid);
      if (!plan) throw new Error("No plan.");
      let found = false;
      const beats = plan.data.beats.map((b) => ({ ...b, lines: b.lines.map((l) => (l.id === i.lineId ? ((found = true), { ...l, text: i.text.trim() }) : l)) }));
      if (!found) return { ok: false, summary: "I couldn't find that line." };
      writeDoc(pid, "plan", { ...plan.data, beats }, { author, note: "Copy edit", inputs: plan.inputs });
      return { ok: true, summary: "Line updated. Footage is reused." };
    },
  }),

  edit_beat: op({
    description: "Edit what we see or hear in one beat of the plan.",
    input: z.object({ beatId: z.string(), visual: z.string().optional(), sound: z.string().optional(), scene: z.string().optional() }),
    sample: true,
    run(pid, i, author) {
      const plan = planDoc(pid);
      if (!plan) throw new Error("No plan.");
      const beats = plan.data.beats.map((b) => (b.id === i.beatId ? { ...b, ...(i.visual ? { visual: i.visual } : {}), ...(i.sound ? { sound: i.sound } : {}), ...(i.scene ? { scene: i.scene } : {}) } : b));
      writeDoc(pid, "plan", { ...plan.data, beats }, { author, note: "Beat edit", inputs: plan.inputs });
      return { ok: true, summary: "Beat updated." };
    },
  }),

  edit_end_card: op({
    description: "Set or clear the closing on-screen line and its small detail line. Never invent brand names, prices or claims.",
    input: z.object({ line: z.string(), detail: z.string().optional() }),
    sample: true,
    run(pid, i, author) {
      const plan = planDoc(pid);
      if (!plan) throw new Error("No plan.");
      writeDoc(pid, "plan", { ...plan.data, endCard: i.line.trim() ? { line: i.line.trim(), detail: i.detail?.trim() || undefined } : undefined }, { author, note: "End card", inputs: plan.inputs });
      return { ok: true, summary: "End card updated. Footage is reused." };
    },
  }),

  set_voice: op({
    description: `Choose the narrator voice, or the voice of one character (characterId). Voices: ${VOICES.map((v) => `${v.id} ${v.name} (${v.tone})`).join("; ")}.`,
    input: z.object({ voiceId: z.string(), characterId: z.string().optional() }),
    run(pid, i, author) {
      const plan = planDoc(pid);
      if (!plan) throw new Error("No plan.");
      if (!VOICES.some((v) => v.id === i.voiceId)) return { ok: false, summary: "Unknown voice." };
      const voice = i.characterId ? { ...plan.data.voice, cast: { ...(plan.data.voice.cast ?? {}), [i.characterId]: i.voiceId } } : { ...plan.data.voice, voiceId: i.voiceId };
      writeDoc(pid, "plan", { ...plan.data, voice }, { author, note: "Voice", inputs: plan.inputs });
      return { ok: true, summary: `Voice set to ${VOICES.find((v) => v.id === i.voiceId)!.name}. Only voice lines are re-recorded.` };
    },
  }),

  set_music: op({
    description: "Change the music direction (mood, genre, tempo). A new bed is made for the next cut; footage is reused.",
    input: z.object({ mood: z.string().min(3) }),
    run(pid, i, author) {
      const plan = planDoc(pid);
      if (!plan) throw new Error("No plan.");
      writeDoc(pid, "plan", { ...plan.data, music: { mood: i.mood } }, { author, note: "Music", inputs: plan.inputs });
      return { ok: true, summary: "Music direction updated. Footage is reused." };
    },
  }),

  plan_assets: op({
    description: "Re-derive the cast, locations and hero props from the current plan, keeping existing assets that still fit.",
    input: z.object({}),
    run(pid) {
      const plan = planDoc(pid);
      if (!plan) return { ok: false, summary: "There is no plan yet." };
      const { job } = thinkJob(pid, "think.assets", { planVersion: plan.version }, `assets-${Date.now()}`);
      setPipeline(pid, { develop: true });
      kick();
      return { ok: true, summary: "Re-planning the cast and places (a few cents from the planning allowance).", jobIds: [job.id], navigate: "assets" };
    },
  }),

  asset_image: op({
    description:
      "Make one more image of an asset. kind 'reference' adds a separate gallery view (another angle, a close portrait, a full-body view, an outfit) made from the approved primary image, keeping identity. kind 'primary' proposes a new main image; it never replaces an approved one until the person approves it. Set keepIdentity false only when the person asks for a different face or a different object. About $0.05.",
    input: z.object({ assetId: z.string(), kind: z.enum(["primary", "reference"]), label: z.string().max(40).optional().describe("Short gallery label, e.g. 'Profile', 'Full body', 'In a hat'"), note: z.string().optional(), keepIdentity: z.boolean().optional() }),
    price(pid, i) {
      const a = getAsset(i.assetId);
      if (!a || a.project_id !== pid) return { ok: false, summary: "Unknown asset." };
      const cents = PRICES.imageCents.gptImage;
      return { cents, ceilingCents: PRICES.imageCents.seedream, covers: ["image"], authKind: "references", label: `${i.kind === "primary" ? "New main image" : (i.label ?? "Another view")} of ${a.name}`, scope: [i.note ?? (i.kind === "primary" ? "A new proposed main image" : "One more reference view")], lines: [{ label: "One image", cents }], notes: ["Fallback to a second image model if the first fails."], fingerprint: { a: a.id, kept: a.kept_version_id, i }, allowanceOk: true };
    },
    run(pid, i, _author, ctx) {
      const { versionId, jobId } = requestAssetImage(pid, i.assetId, { note: i.note, role: i.kind, label: i.label, keepIdentity: i.keepIdentity, authId: ctx.authId });
      kick();
      const a = getAsset(i.assetId)!;
      return { ok: true, summary: i.kind === "primary" ? `Drawing a proposed main image for ${a.name}. The current one stays until you approve the new one.` : `Adding ${i.label ? `a ${i.label.toLowerCase()} view` : "a view"} of ${a.name} to its gallery.`, jobIds: [jobId], data: { versionId }, navigate: "assets" };
    },
  }),

  approve_asset: op({
    description: "The person approves one image as an asset's main image (the identity every shot uses). Shots drawn with an older image are marked outdated, never deleted.",
    input: z.object({ assetId: z.string(), versionId: z.string() }),
    person: true,
    sample: true,
    run(pid, i) {
      const v = getAssetVersion(i.versionId);
      if (!v || v.asset_id !== i.assetId || v.status !== "ready") return { ok: false, summary: "That image isn't ready." };
      const before = getAsset(i.assetId)!;
      approveAssetVersion(pid, i.assetId, i.versionId);
      db().prepare("update asset_versions set role = 'primary' where id = ?").run(i.versionId);
      const shots = shotsDoc(pid)?.data.shots ?? [];
      const using = shots.filter((s) => [s.locationId, ...s.characterIds, ...s.propIds].includes(i.assetId)).map((s) => s.id);
      const changed = before.kept_version_id !== i.versionId && (before.kept_version_id || assetVersions(i.assetId).some((x) => x.status === "ready" && x.id !== i.versionId && (x.role ?? "primary") === "primary"));
      const a = changed ? affected(pid, using) : { text: "" };
      return { ok: true, summary: `${before.name} approved.${a.text ? ` ${a.text}` : ""}` };
    },
  }),

  separate_references: op({
    description: "Split an asset's contact-sheet image (a grid of several views baked into one picture) into separate images: the first view becomes the proposed main image, the others go to its gallery. Free; nothing is regenerated; the person still approves the main image.",
    input: z.object({ assetId: z.string() }),
    async run(pid, i) {
      const a = getAsset(i.assetId);
      if (!a || a.project_id !== pid) return { ok: false, summary: "Unknown asset." };
      const sheet = assetVersions(i.assetId).find((v) => v.status === "ready" && (v.role ?? "primary") === "primary" && v.media_id);
      if (!sheet) return { ok: false, summary: "There's no image to separate." };
      const { separateSheet } = await import("./collage");
      const r = await separateSheet(pid, i.assetId, sheet.id);
      if (!r.tiles) return { ok: false, summary: `${a.name}'s image is a single picture already.` };
      const shots = shotsDoc(pid)?.data.shots ?? [];
      const using = shots.filter((s) => [s.locationId, ...s.characterIds, ...s.propIds].includes(i.assetId)).map((s) => s.id);
      const aff = affected(pid, using);
      return { ok: true, summary: `${a.name}: ${r.tiles} separate images. The first view is the proposed main image.${aff.text ? ` ${aff.text}` : ""}`, navigate: "assets" };
    },
  }),

  edit_asset: op({
    description: "Edit an asset's name, short role, description or look text (does not redraw it; use asset_image for that).",
    input: z.object({ assetId: z.string(), name: z.string().optional(), role: z.string().max(60).optional(), description: z.string().optional(), look: z.string().optional() }),
    run(pid, i) {
      const a = getAsset(i.assetId);
      if (!a || a.project_id !== pid) return { ok: false, summary: "Unknown asset." };
      const d = assetData(a);
      updateAsset(i.assetId, { name: i.name, data: { ...d, ...(i.role ? { role: i.role } : {}), ...(i.description ? { description: i.description } : {}), ...(i.look ? { look: i.look } : {}) } });
      return { ok: true, summary: "Asset updated." };
    },
  }),

  revise_shots: op({
    description: "Re-plan the whole shot list from a note (coverage, pacing, order). Unchanged shots keep their work.",
    input: z.object({ note: z.string().min(2) }),
    run(pid, i) {
      if (!shotsDoc(pid)) return { ok: false, summary: "There is no shot list yet." };
      const { job } = thinkJob(pid, "think.shots", { note: i.note }, `shots-${Date.now()}`);
      setPipeline(pid, { develop: true });
      kick();
      return { ok: true, summary: "Re-planning the shots (about $0.10 from the planning allowance); new frames follow at about $0.05 each.", jobIds: [job.id], navigate: "shots" };
    },
  }),

  revise_shot: op({
    description: "Rewrite one shot from a plain-language note (what it shows, the action, framing, camera move). Uses one model call. Only that shot becomes outdated. Prefer edit_shot when you can state the exact change yourself.",
    input: z.object({ shotId: z.string(), note: z.string().min(2) }),
    async run(pid, i, author) {
      const shots = needShots(pid);
      const idx = shots.findIndex((s) => s.id === i.shotId);
      if (idx < 0) return { ok: false, summary: "Unknown shot." };
      const brief = briefDoc(pid)!.data;
      const assets = assetIdentities(pid).map((x) => ({ id: x.asset.id, kind: x.asset.kind, name: x.asset.name }));
      const { data } = await reviseShot({ brief, shot: shots[idx], note: i.note, assets, bill: { projectId: pid, purpose: "Revising a shot", authId: allowanceOf(pid)?.id ?? null } });
      const prev = shots[idx];
      const next: Shot = { ...prev, title: data.title, summary: data.summary, framing: data.framing as Shot["framing"], move: data.move as Shot["move"], lens: data.lens, description: data.description, action: data.action, rev: prev.rev + 1 };
      return commitShots(pid, shots.map((s, j) => (j === idx ? next : s)), shots, author, `${num(shots, prev.id)} updated.`);
    },
  }),

  edit_shot: op({
    description: "Set fields of one shot directly: title, summary, duration (seconds; the other shots absorb the difference so the film keeps its length), framing, move, lens, description, action, direction (standing direction for this shot only, e.g. wardrobe), location, cast or props. Timing-only edits reuse footage.",
    input: z.object({ shotId: z.string(), duration: z.number().min(LIMITS.shotMin).max(LIMITS.shotMax).optional(), ...ShotFields }),
    sample: true,
    run(pid, i, author) {
      const shots = needShots(pid);
      const idx = shots.findIndex((s) => s.id === i.shotId);
      if (idx < 0) return { ok: false, summary: "Unknown shot." };
      const prev = shots[idx];
      const pictureKeys = ["framing", "move", "lens", "description", "action", "direction", "locationId", "characterIds", "propIds"] as const;
      const picture = pictureKeys.some((k) => i[k] !== undefined && JSON.stringify(i[k]) !== JSON.stringify(prev[k]));
      const fields: Record<string, unknown> = Object.fromEntries(Object.entries(i).filter(([k, v]) => k !== "shotId" && v !== undefined));
      if (fields.direction === "") delete fields.direction;
      const next = { ...prev, ...fields, rev: picture ? prev.rev + 1 : prev.rev } as Shot;
      if (i.direction === "") delete next.direction;
      if (i.duration !== undefined && i.duration !== prev.duration) {
        // Keep the film's total: the other shots absorb the difference proportionally.
        const p = getProject(pid)!;
        const others = shots.filter((_, j) => j !== idx);
        const fitted = fitDurations(others.map((s) => s.duration), p.duration - i.duration);
        let k = 0;
        const rebalanced = shots.map((s, j) => (j === idx ? next : { ...s, duration: fitted[k++] }));
        const longer = i.duration > prev.duration;
        return commitShots(pid, rebalanced, shots, author, `${num(shots, prev.id)} is now ${i.duration} s (${longer ? "+" : "−"}${Math.abs(i.duration - prev.duration)} s); the others adjust to keep ${p.duration} s.`);
      }
      return commitShots(pid, shots.map((s, j) => (j === idx ? next : s)), shots, author, picture ? `${num(shots, prev.id)} updated.` : `${num(shots, prev.id)} updated; footage is reused.`);
    },
  }),

  insert_shot: op({
    description:
      "Add a new shot after an existing one (afterShotId; null for the start). Give a short summary, a detailed description for generation, the action, framing and move. Its length is taken from the neighbouring shots so the film keeps its total. Cast, location and props default to the neighbour's. Its storyboard frame is drawn under the planning allowance (about $0.05) or offered as an estimate.",
    input: z.object({
      afterShotId: z.string().nullable(),
      title: z.string().min(2),
      summary: z.string().max(140),
      description: z.string().min(4),
      action: z.string().min(2),
      framing: Framing,
      move: Move.default("static"),
      lens: z.number().min(18).max(135).optional(),
      duration: z.number().min(LIMITS.shotMin).max(LIMITS.shotMax).optional(),
      locationId: z.string().nullable().optional(),
      characterIds: z.array(z.string()).max(LIMITS.characters).optional(),
      propIds: z.array(z.string()).optional(),
      direction: z.string().optional(),
    }),
    async run(pid, i, author) {
      const shots = needShots(pid);
      if (shots.length >= LIMITS.shots) return { ok: false, summary: `The lane allows ${LIMITS.shots} shots. Remove one first.` };
      const at = i.afterShotId ? shots.findIndex((s) => s.id === i.afterShotId) : -1;
      if (i.afterShotId && at < 0) return { ok: false, summary: "Unknown shot." };
      const near = shots[Math.max(0, at)];
      const p = getProject(pid)!;
      const wanted = i.duration ?? (i.framing === "close" || i.framing === "detail" ? 3 : 4);
      const fitted = fitDurations([...shots.map((s) => s.duration), wanted], p.duration);
      const id = `s${Date.now().toString(36)}n`;
      const shot: Shot = {
        id,
        rev: 1,
        title: i.title,
        summary: i.summary,
        direction: i.direction,
        beatId: near?.beatId ?? null,
        duration: fitted[fitted.length - 1],
        framing: i.framing,
        move: i.move,
        lens: i.lens ?? (i.framing === "close" ? 65 : i.framing === "detail" ? 85 : i.framing === "wide" ? 24 : 35),
        description: i.description,
        action: i.action,
        locationId: i.locationId === undefined ? (near?.locationId ?? null) : i.locationId,
        characterIds: i.characterIds ?? near?.characterIds ?? [],
        propIds: i.propIds ?? near?.propIds ?? [],
        lineIds: [],
        speakerId: null,
      };
      const timed = shots.map((s, j) => ({ ...s, duration: fitted[j] }));
      const next = [...timed.slice(0, at + 1), shot, ...timed.slice(at + 1)];
      const res = commitShots(pid, next, shots, author, `New shot ${String(at + 2).padStart(2, "0")} added; later shots move up one number and the others make room.`);
      writeScene(pid, id, blockShot(p, shot, assetIdentities(pid)), "system", "Automatic blocking from the shot plan");
      // Its frame is drawn under the planning allowance once the grey capture exists; without room it waits for an estimate.
      const allowance = allowanceOf(pid);
      const canDraw = !!allowance && authRemaining(allowance) >= PRICES.imageCents.seedream;
      if (canDraw) setPipeline(pid, { drawShots: [...(pipelineOf(getProject(pid)!).drawShots ?? []), { id, note: null }] });
      void advance(pid);
      kick();
      return { ...res, summary: `${res.summary}${canDraw ? " Its frame is being drawn." : " Its frame needs an estimate to draw."}`, data: { shotId: id }, navigate: "shots" };
    },
  }),

  remove_shot: op({
    description: "Remove one shot from the sequence. Its time goes to the other shots and any words over it move to a neighbour. Its frames and takes are kept, not deleted.",
    input: z.object({ shotId: z.string() }),
    run(pid, i, author) {
      const shots = needShots(pid);
      const idx = shots.findIndex((s) => s.id === i.shotId);
      if (idx < 0) return { ok: false, summary: "Unknown shot." };
      if (shots.length <= 2) return { ok: false, summary: "A sequence needs at least two shots." };
      const gone = shots[idx];
      const p = getProject(pid)!;
      const rest = shots.filter((_, j) => j !== idx);
      const heir = rest[Math.max(0, idx - 1)];
      const fitted = fitDurations(rest.map((s) => s.duration), p.duration);
      const next = rest.map((s, j) => ({ ...s, duration: fitted[j], lineIds: s.id === heir.id ? [...new Set([...s.lineIds, ...gone.lineIds])] : s.lineIds }));
      return commitShots(pid, next, shots, author, `${num(shots, gone.id)} removed; later shots move up one number. Its frames are kept.`);
    },
  }),

  reorder_shots: op({
    description: "Put the shots in a new order (all shot ids, in order). Footage is reused.",
    input: z.object({ order: z.array(z.string()) }),
    run(pid, i, author) {
      const shots = needShots(pid);
      if (i.order.length !== shots.length || !shots.every((s) => i.order.includes(s.id))) return { ok: false, summary: "The order must list every shot exactly once." };
      writeShots(pid, i.order.map((id) => shots.find((s) => s.id === id)!), author, "New order");
      return { ok: true, summary: "Order updated. Every take is reused." };
    },
  }),

  direct_shot: op({
    description:
      "Apply structured blocking commands to one shot's grey 3D scene: place or move actors (by actor id, coordinates or `near` a set feature/prop/actor id), poses (stand, sit, walk, turn, look, reach), facing, props, framing, camera moves (static, push_in, pull_out, pan, track, orbit) with amount, lens and height, duration. Validated against the set and the lane's limits; both camera and overhead views update together. Read the shot first (get_shot).",
    input: z.object({ shotId: z.string(), commands: z.array(SceneCommand).min(1).max(12), summary: z.string().optional() }),
    sample: true,
    run(pid, i, author) {
      const scene = latestScene(pid, i.shotId);
      if (!scene) return { ok: false, summary: "This shot has no blocking yet." };
      const res = applyCommands(scene.data, i.commands);
      if (!res.changes.length) return { ok: false, summary: `Nothing changed. ${res.errors.join(" ")}`.trim(), results: res.errors.map((e) => ({ label: e, ok: false })) };
      const saved = writeScene(pid, i.shotId, res.scene, author, i.summary ?? res.changes.join("; "));
      const pictureChanged = saved.pictureKey !== scene.pictureKey;
      const a = pictureChanged ? affected(pid, [i.shotId]) : { text: "" };
      void advance(pid);
      kick();
      return {
        ok: true,
        summary: `Blocking v${saved.rev}. ${pictureChanged ? a.text || "The capture updates." : "Timing only; footage is reused."}`,
        results: [...res.changes.map((c) => ({ label: c, ok: true })), ...res.errors.map((e) => ({ label: e, ok: false }))],
        navigate: "direct",
        data: { rev: saved.rev },
      };
    },
  }),

  reset_blocking: op({
    description: "Rebuild one shot's blocking automatically from the shot description.",
    input: z.object({ shotId: z.string() }),
    sample: true,
    run(pid, i, author) {
      const shots = needShots(pid);
      const shot = shots.find((s) => s.id === i.shotId);
      if (!shot) return { ok: false, summary: "Unknown shot." };
      const saved = writeScene(pid, shot.id, blockShot(getProject(pid)!, shot, assetIdentities(pid)), author, "Reset to automatic blocking");
      void advance(pid);
      return { ok: true, summary: `Blocking v${saved.rev}: reset to automatic.` };
    },
  }),

  restore_blocking: op({
    description: "Go back to an earlier blocking version of one shot (it becomes the newest version; nothing is deleted).",
    input: z.object({ shotId: z.string(), rev: z.number().int() }),
    sample: true,
    run(pid, i, author) {
      const row = sceneHistory(pid, i.shotId).find((h) => h.rev === i.rev);
      const old = row ? sceneById(row.id) : null;
      if (!old) return { ok: false, summary: "That version doesn't exist." };
      const saved = writeScene(pid, i.shotId, old.data, author, `Restored v${i.rev}`);
      void advance(pid);
      return { ok: true, summary: `Blocking v${saved.rev} restores v${i.rev}.` };
    },
  }),

  redraw_storyboard: op({
    description:
      "Redraw one shot's storyboard frame with the approved references and current blocking, optionally with a note for this version ('match the shop background', 'she wears a hat'). The previous frame is kept for comparison and, with a note, used so unmentioned details stay. A redraw with a note is checked for identity drift. About $0.05.",
    input: z.object({ shotId: z.string(), note: z.string().optional() }),
    price(pid, i) {
      const shots = needShots(pid);
      const s = shots.find((x) => x.id === i.shotId);
      if (!s) return { ok: false, summary: "Unknown shot." };
      const cents = PRICES.imageCents.gptImage + (i.note ? REVIEW_CENTS.typical : 0);
      const st = shotStates(pid, [s])[0];
      return { cents, ceilingCents: PRICES.imageCents.seedream + (i.note ? REVIEW_CENTS.bound : 0), covers: ["image", "model"], authKind: "storyboards", label: `Redraw ${num(shots, s.id)}`, scope: [i.note ? `“${i.note}”` : "With the approved references and current blocking"], lines: [{ label: "Storyboard frame", cents: PRICES.imageCents.gptImage }, ...(i.note ? [{ label: "Drift check", cents: REVIEW_CENTS.typical }] : [])], notes: [], fingerprint: { s: shotPrint(st), note: i.note ?? null }, allowanceOk: true };
    },
    run(pid, i, _author, ctx) {
      const shots = needShots(pid);
      const p = getProject(pid)!;
      const ids = assetIdentities(pid);
      const st = shotStates(pid, shots, ids).find((x) => x.shot.id === i.shotId)!;
      const r = queueStoryboard(p, st, ids, { note: i.note ?? null, authId: ctx.authId });
      kick();
      if (r === "waiting") {
        // The grey capture is still rendering: draw it the moment the capture exists.
        const queue = (pipelineOf(p).drawShots ?? []).filter((e) => (typeof e === "string" ? e : e.id) !== st.shot.id);
        setPipeline(pid, { drawShots: [...queue, { id: st.shot.id, note: i.note ?? null }] });
        void advance(pid);
        return { ok: true, summary: `${num(shots, i.shotId)} will be redrawn as soon as its blocking capture is ready.`, navigate: "shots" };
      }
      if (r === "skipped") return { ok: false, summary: "That exact frame failed before. Retry it from Jobs, or add a note." };
      return { ok: true, summary: r === "reused" ? `${num(shots, i.shotId)}: reused an identical earlier frame (free).` : `Redrawing ${num(shots, i.shotId)}. The previous frame stays for comparison.`, navigate: "shots" };
    },
  }),

  render_storyboards: op({
    description: "Draw every missing or outdated storyboard frame (about $0.05 each) with the approved references and current blocking.",
    input: z.object({}),
    price(pid) {
      const states = shotStates(pid, needShots(pid));
      const todo = states.filter((s) => !s.storyboardCurrent || s.storyboard?.status === "failed");
      if (!todo.length) return { ok: false, summary: "Every storyboard frame is current." };
      const cents = todo.length * PRICES.imageCents.gptImage;
      return { cents, ceilingCents: todo.length * PRICES.imageCents.seedream, covers: ["image"], authKind: "storyboards", label: `Draw ${plural(todo.length, "storyboard frame")}`, scope: todo.map((s) => `${num(needShots(pid), s.shot.id)} ${s.shot.title}`), lines: [{ label: plural(todo.length, "frame"), cents }], notes: [], fingerprint: todo.map((s) => shotPrint(s)), allowanceOk: true };
    },
    async run(pid, _i, _author, ctx) {
      const p = getProject(pid)!;
      const ids = assetIdentities(pid);
      let n = 0;
      for (const s of shotStates(pid, needShots(pid), ids)) {
        if (s.storyboardCurrent && s.storyboard?.status !== "failed") continue;
        const r = queueStoryboard(p, s, ids, { authId: ctx.authId });
        if (r === "queued" || r === "reused") n++;
      }
      setPipeline(pid, { develop: true, paused: null });
      await advance(pid);
      kick();
      return { ok: true, summary: `Drawing ${plural(n, "frame")}.`, navigate: "shots" };
    },
  }),

  approve_sequence: op({
    description: "The person approves the current storyboard and blocking of every shot for production. A later change reopens approval only for the shots it touches.",
    input: z.object({ note: z.string().optional() }),
    person: true,
    sample: true,
    run(pid, i) {
      const r = approveSequence(pid, i.note);
      return { ok: r.ok, summary: r.summary, navigate: r.ok ? "cut" : undefined };
    },
  }),

  estimate: op({
    description: "Estimate production: video takes still needed, storyboard frames, sound, reviews and the retry allowance.",
    input: z.object({}),
    run(pid) {
      const e = estimateProduction(pid);
      return { ok: true, summary: `About ${money(e.totalCents)} for ${plural(e.shots.length, "take")} (${money(e.videoCents)}), sound ${money(e.soundCents)} and reviews ${money(e.reviewCents)}, with a ceiling of ${money(e.ceilingCents)} including retries.`, data: e };
    },
  }),

  start_production: op({
    description: "Generate the footage: video takes for every approved shot that needs one, sound, automatic review with up to two repairs per shot inside the approved ceiling, then the cut. Always returns an estimate for the person to approve; the sequence must be approved first.",
    input: z.object({}),
    price(pid) {
      const shots = needShots(pid);
      const seq = sequenceStatus(pid);
      if (!seq.allApproved) {
        const pending = shots.filter((s) => seq.shots[s.id] !== "approved").map((s) => num(shots, s.id));
        return { ok: false, summary: seq.blockers.length ? `Not ready: ${seq.blockers.join(", ")}.` : `Approve the sequence first${pending.length < shots.length ? `: ${pending.join(", ")} changed since approval` : ""}.` };
      }
      const e = estimateProduction(pid);
      if (!e.shots.length) return { ok: false, summary: "Every shot already has a usable take." };
      const states = shotStates(pid, shots);
      return {
        cents: e.totalCents,
        ceilingCents: e.ceilingCents,
        covers: ["video", "image", "audio", "model"],
        authKind: "production",
        label: `Generate footage for ${plural(e.shots.length, "shot")}`,
        scope: [`${plural(e.shots.length, "video take")}, ${e.shots.reduce((a, s) => a + s.seconds, 0)} s at ${RESOLUTION}`, ...(e.reusedTakes ? [e.reusedTakes === 1 ? "1 shot keeps its existing take" : `${e.reusedTakes} shots keep their existing takes`] : []), "Voice, music and the assembled cut", "Each take reviewed; up to two repairs per shot"],
        lines: [{ label: "Video", cents: e.videoCents }, ...(e.storyboardCents ? [{ label: "Storyboard frames", cents: e.storyboardCents }] : []), { label: "Sound", cents: e.soundCents }, { label: "Reviews", cents: e.reviewCents }],
        notes: ["Video receives the storyboard frame and written direction, not the 3D motion track.", "Work stops at the ceiling; nothing above it is bought."],
        fingerprint: { shots: states.filter((s) => e.shots.some((x) => x.shotId === s.shot.id)).map(shotPrint), plan: planDoc(pid)?.version, res: RESOLUTION },
        allowanceOk: false,
      };
    },
    async run(pid, _i, _author, ctx) {
      if (!ctx.authId) return { ok: false, summary: "Production needs your approval of the estimate." };
      const e = estimateProduction(pid);
      await startProduction(pid, ctx.authId, e.shots.map((s) => s.shotId));
      kick();
      return { ok: true, summary: "Generating footage. You can close the studio; it keeps going.", navigate: "cut" };
    },
  }),

  retake_shot: op({
    description: "Generate a new video take for one shot, optionally with direction for the performance or camera. Only that shot is regenerated. Always returns an estimate for the person to approve.",
    input: z.object({ shotId: z.string(), note: z.string().optional() }),
    price(pid, i) {
      const shots = needShots(pid);
      const s = shots.find((x) => x.id === i.shotId);
      if (!s) return { ok: false, summary: "Unknown shot." };
      const st = shotStates(pid, [s])[0];
      if (!st.storyboardCurrent || st.storyboard?.status !== "ready") return { ok: false, summary: "This shot's storyboard frame needs to be drawn first." };
      const video = Math.ceil(clipSeconds(s.duration) * PRICES.videoCentsPerSecond[RESOLUTION]);
      return { cents: video + REVIEW_CENTS.typical, ceilingCents: video + REVIEW_CENTS.bound, covers: ["video", "model"], authKind: "retake", label: `New take of ${num(shots, s.id)}`, scope: [i.note ? `Direction: ${i.note}` : "Same frame and direction"], lines: [{ label: `${clipSeconds(s.duration)} s video`, cents: video }, { label: "Review", cents: REVIEW_CENTS.typical }], notes: [], fingerprint: { s: shotPrint(st), note: i.note ?? null, n: st.takes.length }, allowanceOk: false };
    },
    run(pid, i, _author, ctx) {
      if (!ctx.authId) return { ok: false, summary: "A new take needs your approval of the estimate." };
      const job = retakeShot(pid, i.shotId, i.note, ctx.authId);
      kick();
      return { ok: true, summary: "New take on its way.", jobIds: [job.id] };
    },
  }),

  accept_take: op({
    description: "Use this take for its shot (it overrides an automated flag). Other takes stay playable.",
    input: z.object({ takeId: z.string() }),
    person: true,
    run(pid, i) {
      const t = getTake(i.takeId);
      if (!t || t.project_id !== pid || t.status !== "ready") return { ok: false, summary: "That take isn't ready." };
      acceptTake(i.takeId);
      clearChosenReviews(pid);
      return { ok: true, summary: "Take chosen." };
    },
  }),

  reject_take: op({
    description: "Set a take aside. It is kept, never deleted, but won't play in the cut.",
    input: z.object({ takeId: z.string() }),
    run(pid, i) {
      const t = getTake(i.takeId);
      if (!t || t.project_id !== pid) return { ok: false, summary: "Unknown take." };
      updateTake(i.takeId, { verdict: "rejected" });
      return { ok: true, summary: "Take set aside." };
    },
  }),

  use_footage: op({
    description: "Use a clip the person supplied (mediaId of an uploaded video) as the take for one shot.",
    input: z.object({ shotId: z.string(), mediaId: z.string() }),
    run(pid, i) {
      const m = getMedia(i.mediaId);
      if (!m || m.project_id !== pid || m.kind !== "video") return { ok: false, summary: "That isn't one of your clips." };
      const shots = needShots(pid);
      const s = shots.find((x) => x.id === i.shotId);
      if (!s) return { ok: false, summary: "Unknown shot." };
      const tid = addTake({ projectId: pid, shotId: s.id, jobId: null, inputs: { shotRev: s.rev, pictureKey: "", frameId: "", prompt: "supplied", seconds: m.duration ?? s.duration, resolution: "supplied" }, attempt: 1, source: "upload", mediaId: m.id, status: "ready" });
      acceptTake(tid);
      const short = (m.duration ?? 0) < s.duration - 0.05;
      return { ok: true, summary: `${num(shots, s.id)} now uses your clip.${short ? ` It is ${(m.duration ?? 0).toFixed(1)} s, shorter than the ${s.duration} s slot; shorten the shot or the clip won't fill it.` : ""}` };
    },
  }),

  assemble_cut: op({
    description: "Assemble a new version of the cut from the current takes (or storyboard frames where no take exists), voice, music and on-screen words. Free; earlier versions stay playable.",
    input: z.object({ note: z.string().optional() }),
    sample: true,
    run(pid, i) {
      if (!shotsDoc(pid)) return { ok: false, summary: "There are no shots yet." };
      const cut = queueCut(pid, i.note ?? "Assembled on request");
      kick();
      return { ok: true, summary: `Assembling version ${String(cut.version).padStart(2, "0")}.`, jobIds: [cut.jobId], navigate: "cut" };
    },
  }),

  make_sound: op({
    description: "Record the voice lines and make the music bed for the current plan, without generating video (for the storyboard animatic).",
    input: z.object({}),
    price(pid) {
      const plan = planDoc(pid);
      if (!plan) return { ok: false, summary: "There is no plan yet." };
      const e = estimateProduction(pid);
      if (!e.soundCents) return { ok: false, summary: "Sound is already up to date." };
      return { cents: e.soundCents, ceilingCents: e.soundCents + 2, covers: ["audio"], authKind: "sound", label: "Record voice and music", scope: ["Voice lines and a music bed for the animatic"], lines: [{ label: "Sound", cents: e.soundCents }], notes: [], fingerprint: { plan: plan.version }, allowanceOk: true };
    },
    run(pid, _i, _author, ctx) {
      const n = startSound(pid, ctx.authId);
      kick();
      return { ok: true, summary: n ? "Recording sound." : "Sound is already up to date." };
    },
  }),

  approve_animatic: op({
    description: "The person approves a storyboard animatic as a preview. It is not the final cut.",
    input: z.object({ cutId: z.string() }),
    person: true,
    sample: true,
    run(pid, i) {
      const c = getCut(i.cutId);
      if (!c || c.project_id !== pid || c.status !== "ready") return { ok: false, summary: "That version isn't ready." };
      approveCut(pid, c.id, "animatic", { version: c.version });
      return { ok: true, summary: `Version ${String(c.version).padStart(2, "0")} approved as an animatic.` };
    },
  }),

  accept_final: op({
    description: "The person accepts a cut as final. Only possible when every shot is current, usable footage and the delivery checks pass.",
    input: z.object({ cutId: z.string() }),
    person: true,
    run(pid, i) {
      const c = getCut(i.cutId);
      if (!c || c.project_id !== pid || c.status !== "ready") return { ok: false, summary: "That version isn't ready." };
      const ready = finalReadiness(pid, c.id);
      if (!ready.ok) return { ok: false, summary: `Not final yet: ${ready.reasons.join("; ")}.` };
      approveCut(pid, c.id, "final", { version: c.version });
      return { ok: true, summary: `Version ${String(c.version).padStart(2, "0")} accepted as the final cut.` };
    },
  }),

  set_reviewer: op({
    description: "Name the creative reviewer who signs off (project information only).",
    input: z.object({ name: z.string().max(80) }),
    person: true,
    sample: true,
    run(pid, i) {
      updateProject(pid, { reviewer: i.name.trim() || null });
      return { ok: true, summary: i.name.trim() ? `Creative reviewer: ${i.name.trim()}.` : "Reviewer cleared." };
    },
  }),

  set_allowance: op({
    description: "The person sets the planning allowance: what Astra may spend without asking on planning, references, storyboard frames, reviews and animatic sound. Video always needs an approved estimate.",
    input: z.object({ dollars: z.number().min(0).max(50) }),
    person: true,
    run(pid, i) {
      const g = spendGate(pid);
      if (!g.ok) return { ok: false, summary: g.reason };
      tx(() => {
        const old = allowanceOf(pid);
        if (old) closeAuthorization(old.id);
        if (i.dollars > 0) createAuthorization(pid, { kind: "allowance", label: "Planning allowance", covers: ["model", "image", "audio"], ceilingCents: Math.round(i.dollars * 100) });
      });
      if (i.dollars <= 0) return { ok: true, summary: "No planning allowance: everything paid will ask first." };
      db().prepare("update jobs set hold = null, next_run_at = ? where project_id = ? and status = 'queued' and hold is not null").run(new Date().toISOString(), pid);
      setPipeline(pid, { paused: null });
      void advance(pid);
      kick();
      return { ok: true, summary: `Astra may spend up to ${money(Math.round(i.dollars * 100))} on planning work without asking.` };
    },
  }),

  set_budget: op({
    description: "Set the project's overall spending limit in dollars.",
    input: z.object({ dollars: z.number().min(0).max(500) }),
    person: true,
    run(pid, i) {
      const committed = spend(pid);
      if (Math.round(i.dollars * 100) < committed.spentCents + committed.reservedCents) return { ok: false, summary: "The limit can't be lower than money already spent or held for running work." };
      updateProject(pid, { budget_cents: Math.round(i.dollars * 100) });
      return { ok: true, summary: `Project limit set to ${money(Math.round(i.dollars * 100))}.` };
    },
  }),

  set_autopilot: op({
    description: "Turn 'make it for me' on or off. When on, Astra picks the recommended direction and carries the work to the storyboard preview, within the planning allowance.",
    input: z.object({ on: z.boolean() }),
    person: true,
    async run(pid, i) {
      updateProject(pid, { autopilot: i.on ? 1 : 0 });
      if (i.on) await advance(pid);
      return { ok: true, summary: i.on ? "I'll carry it to the storyboard and stop there." : "I'll stop at each checkpoint." };
    },
  }),

  resume_reviews: op({
    description: "Request a fresh estimate for held automatic take reviews only. Does not raise a limit, buy footage, or approve takes. The person must approve the estimate.",
    input: z.object({ jobIds: z.array(z.string()).min(1).max(24) }),
    price(pid, i) {
      const jobs = [...new Set(i.jobIds)].map(getJob);
      if (jobs.some((j) => !j || j.project_id !== pid || j.kind !== "review.take" || j.status !== "queued" || !j.hold || j.provider_task_id)) return { ok: false, summary: "Those reviews are no longer paused. Refresh the studio." };
      if (activeJobs(pid).some((j) => !jobs.some((x) => x?.id === j.id))) return { ok: false, summary: "Wait for the other running work to finish first." };
      const takeIds = jobs.map((j) => JSON.parse(j!.input).takeId as string);
      const takes = takeIds.map(getTake);
      const current = new Set(shotStates(pid, needShots(pid)).flatMap((s) => s.takes.filter((t) => t.current).map((t) => t.id)));
      if (takes.some((t) => !t || t.project_id !== pid || !current.has(t.id) || t.status !== "ready" || t.verdict === "accepted" || t.verdict === "rejected" || t.review)) return { ok: false, summary: "Some takes changed or already have a decision. Cancel their paused reviews under Jobs." };
      return { cents: jobs.length * REVIEW_CENTS.typical, ceilingCents: jobs.length * REVIEW_CENTS.bound, covers: ["model"], authKind: "retry", label: `Review ${plural(jobs.length, "take")}`, scope: ["Review existing footage only", "No retakes or other generation"], lines: [{ label: "Take reviews", cents: jobs.length * REVIEW_CENTS.typical }], notes: ["Any fixes will need a separate estimate."], fingerprint: takes.map((t, n) => ({ job: jobs[n]!.id, take: t!.id, media: t!.media_id, verdict: t!.verdict, review: t!.review })), allowanceOk: false };
    },
    run(pid, i, _author, ctx) {
      if (!ctx.authId) return { ok: false, summary: "Reviewing needs your approval of the estimate." };
      const authId = ctx.authId;
      tx(() => {
        for (const id of new Set(i.jobIds)) {
          const res = db().prepare("update jobs set auth_id = ?, hold = null, next_run_at = ? where id = ? and project_id = ? and kind = 'review.take' and status = 'queued' and hold is not null and provider_task_id is null").run(authId, new Date().toISOString(), id, pid);
          if (!res.changes) throw new Error("A review changed. Refresh before trying again.");
        }
        setPipeline(pid, { produce: false, paused: null });
      });
      kick();
      return { ok: true, summary: "Reviewing existing takes. No new footage will be bought.", navigate: "cut" };
    },
  }),

  resolve_job: op({
    description: "A person's decision on failed or uncertain work: retry (failed work; reserves money again), check (ask the provider again about an uncertain request; free), buy_again (uncertain work; the first request stays held), not_charged / charged (after checking the provider), drop (queued work only).",
    input: z.object({ jobId: z.string(), action: z.enum(["retry", "check", "buy_again", "not_charged", "charged", "drop"]) }),
    person: true,
    run(pid, i) {
      const job = getJob(i.jobId);
      if (!job || job.project_id !== pid) return { ok: false, summary: "Unknown job." };
      switch (i.action) {
        case "retry":
          return retryJob(i.jobId);
        case "check":
          return checkAgain(i.jobId);
        case "buy_again":
          return buyAgain(i.jobId);
        case "not_charged":
        case "charged":
          return { ok: resolveUncertain(i.jobId, i.action), summary: i.action === "charged" ? "Recorded as charged without a result." : "Recorded as not charged; the hold is released." };
        case "drop":
          return { ok: cancel(i.jobId), summary: job.status === "queued" ? "Dropped." : "Only work that hasn't reached a provider can be dropped." };
      }
    },
  }),

  navigate: op({
    description: "Show the person a stage of the studio.",
    input: z.object({ stage: z.enum(STAGES) }),
    sample: true,
    run(_pid, i) {
      return { ok: true, summary: `Showing ${i.stage}.`, navigate: i.stage };
    },
  }),
} as const;

export type OpName = keyof typeof OPS;

/* ---------------- shot commits ---------------- */

function commitShots(pid: string, next: Shot[], prev: Shot[], author: Author, summary: string): OpResult {
  const p = getProject(pid)!;
  writeShots(pid, next, author, summary);
  const changed: string[] = [];
  for (const s of next) {
    const before = prev.find((x) => x.id === s.id);
    if (!before) continue;
    const scene = latestScene(pid, s.id);
    if (scene) {
      const synced = syncSceneToShot(p, s, scene.data, before);
      if (synced !== scene.data) writeScene(pid, s.id, synced, "system", "Updated for the shot change");
    }
    if (s.rev !== before.rev) changed.push(s.id);
  }
  const a = affected(pid, changed);
  void advance(pid);
  return { ok: true, summary: a.text ? `${summary} ${a.text}` : summary, results: a.lines.map((l) => ({ label: `${l} outdated`, ok: true })) };
}

/* ---------------- final readiness ---------------- */

/** Cancel only undispatched reviews of takes a person already chose. Never marks them reviewed. */
export function clearChosenReviews(pid: string): number {
  let cleared = 0;
  for (const job of activeJobs(pid)) {
    if (job.kind !== "review.take" || job.status !== "queued" || job.provider_task_id) continue;
    const take = getTake(JSON.parse(job.input).takeId);
    if (take?.project_id === pid && take.verdict === "accepted" && cancel(job.id)) {
      db().prepare("update jobs set hold = null, error = ? where id = ?").run("Automatic review skipped: take was manually chosen.", job.id);
      cleared++;
    }
  }
  return cleared;
}

export function finalReadiness(pid: string, cutId: string): { ok: boolean; reasons: string[]; manualShots?: number } {
  const c = getCut(cutId);
  if (!c || c.project_id !== pid) return { ok: false, reasons: ["unknown version"] };
  if (c.status !== "ready" || !c.media_id) return { ok: false, reasons: ["not assembled yet"] };
  const manifest = JSON.parse(c.manifest) as ReturnType<typeof buildManifest>;
  const review = c.review ? (JSON.parse(c.review) as { checks: { label: string; ok: boolean }[] }) : null;
  const reasons: string[] = [];
  let manualShots = 0;
  if (!manifest.shots.length) reasons.push("no shots in this version");
  const stand = manifest.shots.filter((s) => !s.takeId).length;
  if (stand) reasons.push(`${plural(stand, "shot")} still storyboard stand-in${stand === 1 ? "" : "s"}`);
  const shots = shotsDoc(pid)?.data.shots ?? [];
  const states = shotStates(pid, shots);
  const usedAssets = new Set(shots.flatMap(shotAssetIds));
  const unapproved = assetIdentities(pid).filter((a) => usedAssets.has(a.asset.id) && (!a.asset.approved_version_id || a.asset.approved_version_id !== a.version?.id));
  if (unapproved.length) reasons.push(`approve ${unapproved.map((a) => a.asset.name).join(", ")} in Assets`);
  if (shots.length && !sequenceStatus(pid, states).allApproved) reasons.push("the current sequence needs approval");
  const ids = new Set(manifest.shots.map((s) => s.shotId));
  if (shots.length !== manifest.shots.length || shots.some((s) => !ids.has(s.id))) reasons.push("the shot list changed after this version");
  for (const slot of manifest.shots) {
    if (!slot.takeId) continue;
    const st = states.find((s) => s.shot.id === slot.shotId);
    const t = st?.takes.find((x) => x.id === slot.takeId);
    if (!t || !t.current) reasons.push(`${num(shots, slot.shotId)} take is outdated`);
    else if (t.status !== "ready" || !t.media_id || t.seconds < (st?.shot.duration ?? 0) - 0.05) reasons.push(`${num(shots, slot.shotId)} take is incomplete`);
    else if (t.verdict === "rejected") reasons.push(`${num(shots, slot.shotId)} take was set aside`);
    else if (t.verdict !== "accepted" && !t.review) reasons.push(`${num(shots, slot.shotId)} still needs review`);
    else if (t.verdict !== "accepted" && JSON.parse(t.review || "{}").usable !== true) reasons.push(`${num(shots, slot.shotId)} take was flagged`);
    else if (t.verdict === "accepted" && JSON.parse(t.review || "{}").usable !== true) manualShots++;
  }
  if (hashKey(manifest) !== hashKey(buildManifest(pid))) reasons.push("the edit changed; assemble a new version");
  for (const k of review?.checks ?? []) if (!k.ok && k.label !== "Footage") reasons.push(`${k.label.toLowerCase()} check failed`);
  if (!review) reasons.push("checks haven't run");
  return { ok: reasons.length === 0, reasons, manualShots };
}

/* ---------------- dispatch ---------------- */

export async function runOp(pid: string, name: string, rawInput: unknown, author: Author, ctx: OpContext = {}): Promise<OpResult> {
  const def = (OPS as Record<string, Op<z.ZodType>>)[name];
  if (!def) return { ok: false, summary: `Unknown action ${name}.` };
  const p = getProject(pid);
  if (!p) return { ok: false, summary: "This project no longer exists." };
  if (def.person && author !== "user") return { ok: false, summary: "That's the person's decision. Ask them to do it in the studio." };
  if (p.sample && !def.sample) return { ok: false, summary: "This is the sample project, so nothing here is generated or billed. Directing, timing and copy changes work; start your own project to generate." };
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false, summary: `That action's input was invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  try {
    if (def.price && !ctx.authId) {
      const price = def.price(pid, parsed.data);
      if ("ok" in price) return { ok: false, summary: price.summary };
      const gate = spendGate(pid);
      if (!gate.ok) return { ok: false, summary: gate.reason };
      // Small planning work may draw on the person's allowance when it has room.
      const allowance = price.allowanceOk ? allowanceOf(pid) : null;
      if (allowance && price.covers.every((c) => authCovers(allowance).includes(c)) && authRemaining(allowance) >= price.ceilingCents) {
        return await def.run(pid, parsed.data, author, { authId: allowance.id });
      }
      const q = createQuote(pid, {
        op: name,
        input: parsed.data as Record<string, unknown>,
        fingerprint: hashKey(price.fingerprint),
        cents: price.cents,
        ceilingCents: price.ceilingCents,
        label: price.label,
        detail: { scope: price.scope, lines: price.lines, retryCents: price.ceilingCents - price.cents, notes: price.notes, covers: price.covers, authKind: price.authKind } satisfies QuoteDetail,
        createdBy: author,
      });
      return { ok: true, summary: `${price.label}: about ${money(price.cents)}, ceiling ${money(price.ceilingCents)}. Waiting for your approval.`, quote: quoteView(q) };
    }
    return await def.run(pid, parsed.data, author, ctx);
  } catch (err) {
    if (err instanceof SpendBlocked) return { ok: false, summary: err.message };
    return { ok: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The person accepts a quote. Only the studio's confirmation endpoint calls this. The price is
 * recomputed: if anything it depended on changed, a fresh quote replaces it and nothing is
 * bought. Acceptance is single use, and creates the authorization the work then spends under.
 */
export async function approveQuote(pid: string, quoteId: string): Promise<OpResult> {
  const q = getQuote(quoteId);
  if (!q || q.project_id !== pid) return { ok: false, summary: "Unknown estimate." };
  if (q.status === "approved") return { ok: false, summary: "This estimate was already approved." };
  if (q.status !== "open" || q.expires_at < new Date().toISOString()) {
    if (q.status === "open") markQuote(q.id, "expired");
    return { ok: false, summary: "This estimate has expired. Ask for a fresh one." };
  }
  const def = (OPS as Record<string, Op<z.ZodType>>)[q.op];
  const input = JSON.parse(q.input) as Record<string, unknown>;
  if (!def?.price) return { ok: false, summary: "That action can't be approved." };
  const gate = spendGate(pid);
  if (!gate.ok) return { ok: false, summary: gate.reason };
  const price = def.price(pid, def.input.parse(input));
  if ("ok" in price) {
    markQuote(q.id, "stale");
    return { ok: false, summary: price.summary };
  }
  if (hashKey(price.fingerprint) !== q.fingerprint || price.cents !== q.cents || price.ceilingCents !== q.ceiling_cents) {
    markQuote(q.id, "stale");
    const fresh = await runOp(pid, q.op, input, "user");
    return { ok: false, summary: `Things changed since that estimate, so nothing was bought. ${fresh.quote ? "Here's a fresh one." : fresh.summary}`, quote: fresh.quote };
  }
  let authId: string;
  try {
    authId = tx(() => {
      const auth = createAuthorization(pid, { kind: price.authKind, label: q.label, covers: price.covers, ceilingCents: q.ceiling_cents, quoteId: q.id });
      if (!takeQuote(q.id, auth.id)) throw new Error("This estimate was already approved.");
      return auth.id;
    });
  } catch (err) {
    return { ok: false, summary: err instanceof Error ? err.message : String(err) };
  }
  const res = await runOp(pid, q.op, input, "user", { authId });
  return { ...res, summary: `Approved up to ${money(q.ceiling_cents)}. ${res.summary}` };
}

export function declineQuote(pid: string, quoteId: string): OpResult {
  const q = getQuote(quoteId);
  if (!q || q.project_id !== pid || q.status !== "open") return { ok: false, summary: "Nothing to decline." };
  markQuote(q.id, "declined");
  return { ok: true, summary: "Not now. Nothing was bought." };
}

/** What Astra may call: everything except the person's own decisions. No input authorizes payment. */
export function opsForAgent() {
  return Object.entries(OPS)
    .filter(([, def]) => !(def as Op<z.ZodType>).person)
    .map(([name, def]) => ({ name, description: def.description, schema: (def as Op<z.ZodType>).input }));
}

export function postResultMessage(pid: string, res: OpResult) {
  const content: MessageContent & { quote?: QuoteView } = { text: res.summary, results: res.results, quote: res.quote };
  addMessage(pid, "system", content);
}

export { keepAssetVersion };
