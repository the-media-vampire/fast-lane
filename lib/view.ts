import { db, json } from "./db";
import { getJob, jobOutput, projectJobs, type JobRow } from "./jobs";
import { allowanceOf, authorizations, authUsage, ledgerLines, spend, spendGate, type AuthRow } from "./billing";
import { openQuotes, quoteView } from "./quotes";
import { sequenceStatus } from "./approvals";
import { getMedia, type MediaRow } from "./media";
import {
  assetVersions,
  audioForProject,
  docAt,
  docVersions,
  frameHistory,
  getProject,
  listCuts,
  listMessages,
  sceneById,
  sceneHistory,
  type AssetVersionRow,
} from "./repo";
import { assetIdentities, briefDoc, briefInterpreted, conceptsDoc, pipelineOf, planDoc, shotStates, shotsDoc } from "./state";
import { buildManifest, estimateProduction, RESOLUTION } from "./pipeline";
import { finalReadiness } from "./ops";
import { labelFor } from "./worker";
import { freeMedia } from "./providers";
import { liveEnabled } from "./env";
import { MODEL } from "./llm";
import { brevity, FRAMING_PLAIN, movementPlain, shotNumber } from "./plain";
import { LIMITS, STAGES, type CutManifest, type Plan, type Stage } from "./types";
import type { AssetImage, AssetView, AuthView, CutView, JobView, MediaRef, MessageView, NextDecision, ProjectView, ShotView, StageStatus, TakeView, Words } from "./view-types";

/** Builds the whole studio view in one read. Staleness is computed here, never stored. */

export function mediaRef(m: MediaRow | null): MediaRef | null {
  if (!m) return null;
  const meta = json<{ previewPath?: string }>(m.meta, {});
  return { id: m.id, url: `/api/media/${m.id}`, preview: meta.previewPath ? `/api/media/${m.id}?v=preview` : `/api/media/${m.id}`, provenance: m.provenance, kind: m.kind };
}

const ref = (id: string | null | undefined) => mediaRef(getMedia(id));

function jobView(j: JobRow): JobView {
  return { id: j.id, kind: j.kind, label: labelFor(j.kind), status: j.status, error: j.error, hold: j.hold ?? null, estCents: j.est_cents, actualCents: j.actual_cents, providerTaskId: j.provider_task_id, createdAt: j.created_at, updatedAt: j.updated_at };
}

function authView(a: AuthRow): AuthView {
  const u = authUsage(a.id);
  return { id: a.id, kind: a.kind, label: a.label, ceilingCents: a.ceiling_cents, spentCents: u.spentCents, reservedCents: u.reservedCents, remainingCents: a.ceiling_cents - u.spentCents - u.reservedCents, status: a.status, createdAt: a.created_at };
}

type CreditCache = { at: number; value: number | null; inflight?: boolean };
const credits: CreditCache = ((globalThis as typeof globalThis & { __fastLaneCredits?: CreditCache }).__fastLaneCredits ??= { at: 0, value: null });

function kieCredits(): number | null {
  if (Date.now() - credits.at > 60_000 && !credits.inflight && liveEnabled()) {
    credits.inflight = true;
    freeMedia()
      .credits()
      .then((v) => {
        credits.value = v;
        credits.at = Date.now();
      })
      .catch(() => {
        credits.at = Date.now();
      })
      .finally(() => {
        credits.inflight = false;
      });
  }
  return credits.value;
}

function imageView(v: AssetVersionRow): AssetImage {
  return { id: v.id, version: v.version, media: ref(v.media_id), label: v.label, source: v.source, status: v.status, role: (v.role ?? "primary") as "primary" | "reference", note: v.note, createdAt: v.created_at };
}

export function buildView(pid: string): ProjectView | null {
  const p = getProject(pid);
  if (!p) return null;
  const pipe = pipelineOf(p);
  const jobs = projectJobs(pid);
  const active = jobs.filter((j) => ["queued", "submitting", "submitted", "running"].includes(j.status));
  const attention = jobs.filter((j) => j.status === "ambiguous" || isLatestFailure(j, jobs));
  const gate = spendGate(pid);
  const mode: ProjectView["mode"] = p.sample ? "sample" : gate.ok ? "live" : "off";

  /* brief & concepts */
  const brief = briefDoc(pid);
  const concepts = conceptsDoc(pid);
  const conceptItems =
    concepts?.data.concepts.map((c) => {
      const job = getJob(c.jobId);
      const out = job ? jobOutput<{ mediaId?: string }>(job) : null;
      const mediaId = c.mediaId ?? out?.mediaId ?? null;
      const imageStatus: "none" | "pending" | "ready" | "failed" = mediaId ? "ready" : !job ? "none" : job.status === "failed" || job.status === "cancelled" ? "failed" : "pending";
      return { ...c, media: ref(mediaId), imageStatus, pitchText: c.pitch ?? brevity(c.logline, 22) };
    }) ?? [];

  /* plan */
  const plan = planDoc(pid);

  /* assets */
  const identities = assetIdentities(pid);
  const shotsD = shotsDoc(pid);
  const shotList = shotsD?.data.shots ?? [];
  const assets: AssetView[] = identities.map((i) => {
    const versions = assetVersions(i.asset.id);
    const primaryRow = i.version ?? null;
    const approved = i.asset.approved_version_id;
    const proposals = versions.filter((v) => (v.role ?? "primary") === "primary" && v.id !== primaryRow?.id && v.id !== approved && v.status !== "failed" && (!primaryRow || v.version > primaryRow.version)).map(imageView);
    const gallery = versions.filter((v) => v.role === "reference" && v.status !== "failed").map(imageView);
    const drawing = versions.some((v) => v.status === "pending");
    const status: AssetView["status"] = p.sample ? "sample" : !primaryRow ? (drawing ? "drawing" : "missing") : approved && approved === primaryRow.id ? "approved" : "proposed";
    return {
      id: i.asset.id,
      kind: i.asset.kind,
      name: i.asset.name,
      role: brevity(i.data.role, 7),
      data: i.data,
      status,
      primary: primaryRow ? imageView(primaryRow) : null,
      proposals,
      gallery,
      approvedVersionId: approved,
      usedIn: shotList.filter((s) => [s.locationId, ...s.characterIds, ...s.propIds].includes(i.asset.id)).length,
    };
  });

  /* shots */
  const states = shotStates(pid, shotList, identities);
  const seq = shotList.length ? sequenceStatus(pid, states) : null;
  const lineIndex = new Map<string, Words>();
  for (const b of plan?.data.beats ?? []) for (const l of b.lines) lineIndex.set(l.id, { id: l.id, kind: l.kind, speaker: l.speaker, text: l.text });
  const placed = new Set<string>();
  const items: ShotView[] = states.map((s, index) => {
    const takes: TakeView[] = s.takes.map((t) => {
      const review = t.review ? json<{ usable: boolean; summary: string; defects: string[]; checks: { label: string; ok: boolean; detail: string }[] }>(t.review, null as never) : null;
      const job = getJob(t.job_id);
      const media = ref(t.media_id);
      return {
        id: t.id,
        media,
        poster: media ? `${media.url}?v=preview` : null,
        status: t.status,
        verdict: t.verdict,
        current: t.current,
        attempt: t.attempt,
        source: t.source ?? "generated",
        review: review ? { usable: review.usable, summary: review.summary, defects: review.defects ?? [], checks: review.checks ?? [] } : null,
        error: job?.status === "failed" || job?.status === "ambiguous" ? job.error : null,
        createdAt: t.created_at,
      };
    });
    const currentTried = s.takes.filter((t) => t.current && t.source !== "upload").length;
    let attentionNote: string | null = null;
    if (s.needsTake && !s.pendingTake && currentTried >= 1 + LIMITS.repairAttempts) attentionNote = `${currentTried} takes didn't pass review.`;
    if (s.storyboard?.status === "failed") attentionNote = "The storyboard frame failed.";
    const pickMedia = s.pick?.kind === "take" ? ref(s.pick.take.media_id) : s.pick ? ref(s.pick.frame.media_id) : null;
    const words = s.shot.lineIds.map((id) => lineIndex.get(id)).filter((w): w is Words => !!w);
    for (const w of words) placed.add(w.id);
    const history = frameHistory(pid, s.shot.id).slice(0, 8);
    const sb = s.storyboard;
    return {
      ...s.shot,
      index,
      number: shotNumber(index),
      start: s.start,
      summaryText: s.shot.summary ?? brevity(s.shot.action, 12),
      movement: movementPlain(s.shot, s.scene?.data),
      framingText: FRAMING_PLAIN[s.shot.framing] ?? s.shot.framing,
      words,
      castNames: s.shot.characterIds.map((c) => identities.find((i) => i.asset.id === c)?.asset.name).filter((x): x is string => !!x),
      locationName: identities.find((i) => i.asset.id === s.shot.locationId)?.asset.name ?? null,
      scene: s.scene ? { id: s.scene.id, rev: s.scene.rev, data: s.scene.data, author: s.scene.author, note: s.scene.note } : null,
      blockingVersions: sceneHistory(pid, s.shot.id).slice(0, 8).map((h) => ({ rev: h.rev, author: h.author, note: h.note, createdAt: h.created_at })),
      capture: s.capture ? { media: ref(s.capture.media_id), current: s.captureCurrent, status: s.capture.status } : null,
      storyboard: sb ? { media: ref(sb.media_id), current: s.storyboardCurrent, status: sb.status, reasons: s.storyboardReasons, note: sb.note } : null,
      storyboards: history.map((f) => {
        const meta = json<{ drift?: string; followedNote?: boolean; check?: string }>(f.meta, {});
        return { id: f.id, media: ref(f.media_id), status: f.status, note: f.note, current: f.id === sb?.id && s.storyboardCurrent, drift: meta.drift ? { drift: meta.drift, followedNote: !!meta.followedNote, check: meta.check ?? "" } : null, createdAt: f.created_at };
      }),
      takes,
      pick: s.pick ? { kind: s.pick.kind, media: pickMedia } : null,
      generating: !!s.pendingTake || s.storyboard?.status === "pending" || s.capture?.status === "pending",
      attention: attentionNote,
      approval: seq?.shots[s.shot.id] ?? "new",
    };
  });
  const unplaced = [...lineIndex.values()].filter((w) => !placed.has(w.id));

  /* cuts */
  const cuts: CutView[] = listCuts(pid).map((c) => {
    const manifest = json<CutManifest>(c.manifest, null as unknown as CutManifest);
    const footage = manifest?.shots.filter((s) => s.takeId).length ?? 0;
    const total = manifest?.shots.length ?? 0;
    return {
      id: c.id,
      version: c.version,
      media: ref(c.media_id),
      status: c.status,
      kind: footage === 0 ? "animatic" : footage < total ? "partial" : "footage",
      footageShots: footage,
      totalShots: total,
      acceptance: c.acceptance ?? null,
      acceptedBy: c.accepted_by ?? null,
      acceptedAt: c.accepted_at ?? null,
      finalReady: c.status === "ready" ? finalReadiness(pid, c.id) : { ok: false, reasons: ["not assembled yet"] },
      note: c.note,
      review: c.review ? json(c.review, null) : null,
      manifest,
      createdAt: c.created_at,
    };
  });

  /* sound */
  const audio = audioForProject(pid);
  const voiceLines = plan?.data.beats.flatMap((b) => b.lines.filter((l) => l.kind !== "super")) ?? [];
  const voiceReady = voiceLines.filter((l) => audio.some((a) => a.kind === "voice" && a.line_key === l.id && a.status === "ready" && json<{ text?: string }>(a.data, {}).text === l.text)).length;
  const bed = audio.find((a) => a.kind === "music");
  // Use the same current audio placement as assembly, without rendering or submitting work.
  const preview = buildManifest(pid);
  const audioDuration = (id: string) => Number(json<{ durationMs?: number }>(audio.find((a) => a.id === id)?.data, {}).durationMs ?? 0) / 1000;
  const musicMedia = preview.music ? ref(preview.music.mediaId) : null;

  /* messages */
  const messages: MessageView[] = listMessages(pid, 80).map((m) => {
    const c = m.content as MessageView & { text: string };
    return { id: m.id, role: m.role, text: c.text, choices: c.choices, results: c.results, quote: c.quote, questionId: c.questionId, stage: c.stage, focus: c.focus, recorded: c.recorded, archived: (c as { archived?: boolean }).archived, cents: c.cents, createdAt: m.created_at };
  });

  /* stage status */
  // Work held at a spending gate is waiting on a person, not working.
  const working = (kinds: string[]) => active.some((j) => !j.hold && kinds.some((k) => j.kind === k));
  const held = active.filter((j) => j.hold);
  const stages = {} as ProjectView["stages"];
  const st = (status: StageStatus, label?: string, note?: string) => ({ status, label, note });
  const openQ = brief?.data.questions.find((q) => !q.answer);
  stages.brief = working(["think.brief"]) ? st("working", "Reading") : briefInterpreted(brief) ? (openQ && !concepts?.data.chosenId ? st("attention", "1 question") : st("ready")) : brief ? st("working", "Reading") : st("empty");
  stages.concept = working(["think.concepts", "image.concept"]) ? st("working", "Developing") : concepts?.data.chosenId ? st("ready") : concepts ? st("attention", "Choose one") : st("empty");
  const assetPending = assets.some((a) => a.status === "drawing" || a.proposals.some((x) => x.status === "pending") || a.gallery.some((x) => x.status === "pending"));
  const toApprove = assets.filter((a) => a.status === "proposed").length;
  stages.assets = working(["think.plan", "think.assets"]) || assetPending ? st("working", "Preparing") : assets.length ? (toApprove && !p.sample ? st("attention", `${toApprove} to approve`) : st("ready")) : st("empty");
  // Shots only go stale when the plan's structure changes (beats, timing, action) — never for copy edits.
  const madeFrom = shotsD && plan && shotsD.inputs.plan !== plan.version ? docAt<Plan>(pid, "plan", Number(shotsD.inputs.plan)) : null;
  const planOutdated = !!(madeFrom && plan && planStructure(madeFrom.data) !== planStructure(plan.data));
  const sbOutdated = items.filter((s) => s.storyboard && !s.storyboard.current).length;
  stages.shots = working(["think.plan", "think.shots", "image.storyboard", "capture"])
    ? st("working", "Drawing")
    : items.some((s) => s.attention)
      ? st("attention", "Needs you")
      : sbOutdated || planOutdated
        ? st("outdated", sbOutdated ? `${sbOutdated} outdated` : "Sequence changed")
        : items.length
          ? seq?.allApproved
            ? st("ready", "Approved")
            : st("attention", "To approve")
          : st("empty");
  stages.direct = items.length ? st("ready") : st("empty");
  const latestCut = cuts[0];
  stages.cut = working(["video.clip", "assemble", "audio.voice", "audio.music", "review.take"])
    ? st("working", pipe.produce ? "Generating" : "Assembling")
    : latestCut?.acceptance === "final"
      ? st("ready", "Final")
      : pipe.attention?.length
        ? st("attention", "Needs you")
        : latestCut
          ? st("ready", latestCut.kind === "animatic" ? "Animatic" : latestCut.kind === "footage" ? "Footage" : "Partial")
          : st("empty");

  const estimate = !p.sample && items.length ? estimateProduction(pid) : null;
  const quotes = openQuotes(pid).map(quoteView);
  const allowance = allowanceOf(pid);
  const footageTakes = items.filter((s) => s.pick?.kind === "take").length;
  // Production is stalled when everything it still has queued is held for money.
  const stalled = held.length > 0 && !working(["video.clip", "assemble", "audio.voice", "audio.music", "review.take", "image.storyboard"]);
  const production: ProjectView["production"] = {
    state: pipe.produce && stalled ? "paused" : pipe.produce ? "running" : pipe.paused?.phase === "production" ? "paused" : pipe.attention?.length ? "attention" : "idle",
    reason: pipe.produce && stalled ? `Stopped at the approved ceiling: ${held.length} ${held.length === 1 ? "step" : "steps"} didn't run. ${held[0].hold}` : (pipe.paused?.reason ?? null),
    attention: pipe.attention ?? [],
    footage: footageTakes,
    total: items.length,
  };

  const view: ProjectView = {
    project: { id: p.id, title: p.title, kind: p.kind, duration: p.duration, aspect: p.aspect, sample: !!p.sample, autopilot: !!p.autopilot, reviewer: p.reviewer ?? null, rev: p.rev, createdAt: p.created_at, updatedAt: p.updated_at },
    mode,
    modeReason: gate.ok ? null : gate.reason,
    spend: spend(pid),
    allowance: allowance ? authView(allowance) : null,
    authorizations: authorizations(pid).map(authView),
    quotes,
    pipeline: { concepts: pipe.concepts, develop: pipe.develop, produce: pipe.produce, paused: pipe.paused ?? null, attention: pipe.attention ?? null },
    stages,
    brief: brief ? { version: brief.version, data: brief.data, interpreted: briefInterpreted(brief) } : null,
    concepts: concepts ? { version: concepts.version, chosenId: concepts.data.chosenId, direction: concepts.data.direction, items: conceptItems } : null,
    plan: plan ? { version: plan.version, data: plan.data, author: plan.author, note: plan.note, createdAt: plan.created_at, versions: docVersions(pid, "plan").length, summaryText: plan.data.summary ?? (conceptItems.find((c) => c.id === concepts?.data.chosenId)?.pitchText || brevity(plan.data.treatment, 22)), unplaced } : null,
    assets,
    shots: shotsD ? { version: shotsD.version, planOutdated, items } : null,
    sequence: seq ? { approvedAt: seq.approvedAt, reviewer: seq.reviewer, allApproved: seq.allApproved, changed: seq.changed, blockers: seq.blockers } : null,
    production,
    cuts,
    footage: (brief?.data.uploads ?? []).filter((u) => u.use === "footage").map((u) => ({ mediaId: u.mediaId, label: u.label, media: ref(u.mediaId) })),
    sound: { voiceReady, voiceTotal: voiceLines.length, music: bed ? bed.status : "none" },
    animatic: {
      voice: preview.voice.flatMap((v) => {
        const media = ref(v.mediaId);
        return media ? [{ id: v.audioId, lineId: v.lineId, start: v.start, duration: audioDuration(v.audioId), media }] : [];
      }),
      music: preview.music && musicMedia ? { media: musicMedia, duration: audioDuration(preview.music.audioId), gainDb: preview.music.gainDb } : null,
      supers: preview.supers,
      endCard: preview.endCard,
    },
    jobs: { active: active.map(jobView), attention: attention.map(jobView).slice(0, 12), recent: jobs.slice(0, 30).map(jobView) },
    messages,
    estimate,
    next: null,
    ledger: ledgerLines(pid, 60).map((l) => ({ at: l.at, cents: l.cents, note: l.note, basis: l.basis })),
    provider: { kieCredits: p.sample ? null : kieCredits(), live: mode === "live", models: [`Astra: Claude (${MODEL})`, "Pictures: Kie GPT Image 2, fallback Seedream", `Video: Kie Seedance 2.5, first frame, ${RESOLUTION}`, "Voice: ElevenLabs", "Music: Suno via Kie", "Assembly: ffmpeg"], videoResolution: RESOLUTION },
  };
  view.next = nextDecision(view);
  return view;
}

/** The one decision that matters most right now, shown above the conversation. */
export function nextDecision(v: ProjectView): NextDecision | null {
  const shots = v.shots?.items ?? [];
  if (v.mode === "off") return { kind: "off", label: "Spending is off on this server", detail: "Editing, blocking and playback still work." };
  const quote = v.quotes[0];
  if (quote) return { kind: "quote", label: quote.label, detail: `About ${dollars(quote.cents)} · ceiling ${dollars(quote.ceilingCents)}`, quoteId: quote.id };
  const uncertain = v.jobs.attention.find((j) => j.status === "ambiguous");
  if (uncertain) return { kind: "uncertain", label: `${uncertain.label}: did it go through?`, detail: "Check it under Jobs before buying again." };
  if (v.mode === "live" && !v.allowance && (!v.brief?.interpreted || v.pipeline.paused || v.jobs.active.some((j) => j.hold))) return { kind: "allowance", label: "Set a planning allowance", detail: "Covers drafts, references and storyboard frames. Video always asks." };
  if (v.pipeline.paused && v.pipeline.paused.phase !== "production") return { kind: "allowance", label: "Planning is paused", detail: v.pipeline.paused.reason };
  const q = v.brief?.data.questions.find((x) => !x.answer);
  if (q && !v.concepts?.chosenId) return { kind: "question", label: q.question, questionId: q.id, choices: q.choices.map((c) => ({ id: c.id, label: c.label, recommended: c.recommended })), stage: "brief" };
  if (v.concepts && (!v.concepts.chosenId || v.concepts.items.some((c) => c.id === v.concepts!.chosenId && c.storyDraft))) return { kind: "concept", label: "Review the story", detail: "Approve a direction before creating assets.", stage: "concept" };
  if (v.pipeline.develop || v.jobs.active.some((j) => j.kind.startsWith("think.") || j.kind === "image.storyboard")) return { kind: "working", label: "Building the storyboard", detail: "Preparing assets and shots." };
  if (v.production.state === "running") return { kind: "producing", label: `Generating footage · ${v.production.footage} of ${v.production.total}`, detail: "It keeps going if you close the studio.", stage: "cut" };
  // A stall doesn't hide a version that already passes every check.
  const readyCut = v.cuts.find((c) => c.status === "ready");
  if (v.production.state === "paused" && !readyCut?.finalReady.ok) return { kind: "attention", label: "Production paused", detail: v.production.reason ?? undefined, stage: "cut" };
  if (v.production.attention.length) {
    const names = v.production.attention.map((id) => shots.find((s) => s.id === id)?.number).filter(Boolean);
    return { kind: "attention", label: `Shot${names.length === 1 ? "" : "s"} ${names.join(", ")} need${names.length === 1 ? "s" : ""} your call`, detail: "Accept a flagged take, retake with a note, or change the shot.", stage: "cut" };
  }
  const outdated = shots.filter((s) => !s.storyboard || !s.storyboard.current || s.storyboard.status === "failed").length;
  // The sample never buys anything, so it never suggests paid work.
  if (v.mode === "sample" && outdated) return { kind: "frames", label: `${outdated} sample frame${outdated === 1 ? " is" : "s are"} outdated`, detail: "The sample can't redraw them. The grey blocking shows the change." };
  if (shots.length && outdated) return { kind: "frames", label: `Redraw ${outdated} storyboard frame${outdated === 1 ? "" : "s"}`, detail: `About ${dollars(outdated * 5)}`, op: "render_storyboards", stage: "shots" };
  if (shots.length && v.sequence && !v.sequence.allApproved) return { kind: "approve-sequence", label: "Approve sequence for production", detail: v.sequence.approvedAt ? `${v.sequence.changed.length} shot${v.sequence.changed.length === 1 ? "" : "s"} changed since approval` : `${shots.length} shots, ${v.project.duration} s`, op: "approve_sequence", stage: "shots" };
  const cut = v.cuts.find((c) => c.status === "ready");
  const usedAssets = new Set(shots.flatMap((s) => [s.locationId, ...s.characterIds, ...s.propIds]));
  const proposed = v.assets.filter((a) => usedAssets.has(a.id) && a.status !== "approved" && a.status !== "sample");
  if (proposed.length) return { kind: "attention", label: "Review the remaining assets", detail: proposed.map((a) => a.name).join(", "), stage: "assets" };
  if (cut?.finalReady.ok && cut.acceptance !== "final") return { kind: "final", label: `Accept version ${String(cut.version).padStart(2, "0")} as final`, op: "accept_final", input: { cutId: cut.id }, stage: "cut" };
  if (v.estimate && v.estimate.shots.length && v.sequence?.allApproved && v.mode === "live") return { kind: "generate", label: "Generate footage", detail: `About ${dollars(v.estimate.totalCents)} · ceiling ${dollars(v.estimate.ceilingCents)}`, op: "start_production", stage: "cut" };
  if (cut?.acceptance === "final") return { kind: "done", label: `Version ${String(cut.version).padStart(2, "0")} is the final cut`, stage: "cut" };
  if (cut && cut.kind === "animatic" && !cut.acceptance) return { kind: "animatic", label: `Approve version ${String(cut.version).padStart(2, "0")} as the animatic`, op: "approve_animatic", input: { cutId: cut.id }, stage: "cut" };
  return null;
}

function dollars(c: number) {
  return `$${(Math.max(0, c) / 100).toFixed(2)}`;
}

/** A failure needs attention until a later job of the same kind works on the same target. */
const TARGET_KEYS = ["shotId", "assetId", "lineId", "conceptId", "cutId", "takeId", "frameId", "versionId"];
function targetOf(j: JobRow): string {
  const input = json<Record<string, unknown>>(j.input, {});
  for (const k of TARGET_KEYS) if (input[k]) return `${k}:${String(input[k])}`;
  return j.kind;
}

function isLatestFailure(j: JobRow, all: JobRow[]): boolean {
  if (j.status !== "failed") return false;
  const target = targetOf(j);
  return !all.some((k) => k.id !== j.id && k.kind === j.kind && k.created_at > j.created_at && targetOf(k) === target);
}

function planStructure(p: Plan): string {
  return JSON.stringify(p.beats.map((b) => [b.id, b.start, b.end, b.scene ?? "", b.visual]));
}

export function listView() {
  const rows = db().prepare("select * from projects order by updated_at desc").all() as { id: string; title: string; kind: string; duration: number; aspect: string; sample: number; updated_at: string }[];
  return rows.map((r) => {
    const shots = shotsDoc(r.id);
    const first = shots?.data.shots[0];
    const sb = first ? (db().prepare("select media_id from frames where project_id = ? and shot_id = ? and kind = 'storyboard' and status = 'ready' order by created_at desc limit 1").get(r.id, first.id) as { media_id: string } | undefined) : undefined;
    const concept = conceptsDoc(r.id);
    const chosen = concept?.data.concepts.find((c) => c.id === concept.data.chosenId) ?? concept?.data.concepts[0];
    const cover = sb?.media_id ?? chosen?.mediaId ?? (chosen?.jobId ? jobOutput<{ mediaId?: string }>(getJob(chosen.jobId)!)?.mediaId : null) ?? null;
    const cut = db().prepare("select acceptance, manifest from cuts where project_id = ? and status = 'ready' order by version desc limit 1").get(r.id) as { acceptance: string | null; manifest: string } | undefined;
    const m = cut ? json<CutManifest>(cut.manifest, null as unknown as CutManifest) : null;
    const footage = m ? m.shots.filter((s) => s.takeId).length : 0;
    const state = !cut ? null : cut.acceptance === "final" ? "Final cut" : footage === 0 ? "Storyboard animatic" : footage < (m?.shots.length ?? 0) ? `${footage} of ${m?.shots.length} shots filmed` : "Footage ready for review";
    return { id: r.id, title: r.title, kind: r.kind, duration: r.duration, aspect: r.aspect, sample: !!r.sample, updatedAt: r.updated_at, cover: ref(cover), state };
  });
}

export { STAGES, sceneById };
export type { Stage };
