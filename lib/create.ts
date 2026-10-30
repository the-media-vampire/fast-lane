import fs from "node:fs";
import path from "node:path";
import { db } from "./db";
import { allowanceOf, createAuthorization, spendGate, SpendBlocked } from "./billing";
import { saveMedia, absPath, type MediaRow } from "./media";
import {
  addAssetVersion,
  addFrame,
  addMessage,
  createAsset,
  createProject,
  getProject,
  keepAssetVersion,
  writeDoc,
  writeScene,
} from "./repo";
import { advance, blockShot } from "./pipeline";
import { assetIdentities, setPipeline } from "./state";
import { attachPreview, kick } from "./worker";
import { classifyUploads, fitDurations } from "./creative";
import { jpegFor } from "./ffmpeg";
import type { AssetKind, Aspect, Brief, ConceptSet, Kind, Plan, Shot } from "./types";
import { EXAMPLE_STORIES } from "./concept-examples";

/**
 * Starting a project: one sentence is enough. A script, images and footage are optional and,
 * when supplied, kept as facts. The person also sets the planning allowance here — what Astra
 * may spend on drafts, references and storyboard frames without asking. Video always asks.
 */

export type NewFile = { name: string; type: string; bytes: Buffer };

export async function createFromIdea(input: { idea: string; kind: Kind; duration: number; aspect: Aspect; autopilot?: boolean; allowanceCents: number; script?: string; files?: NewFile[] }) {
  const idea = input.idea.trim();
  if (idea.length < 3) throw new Error("Tell me a little about what you have in mind.");
  const pid = createProject({ title: "Untitled", kind: input.kind, duration: input.duration, aspect: input.aspect, budgetCents: input.allowanceCents });
  if (input.autopilot) db().prepare("update projects set autopilot = 1 where id = ?").run(pid);
  if (input.allowanceCents > 0 && spendGate(pid).ok) createAuthorization(pid, { kind: "allowance", label: "Planning allowance", covers: ["model", "image", "audio"], ceilingCents: input.allowanceCents });
  const uploads: Brief["uploads"] = [];
  for (const f of input.files ?? []) {
    const m = await storeUpload(pid, f);
    if (m) uploads.push({ mediaId: m.id, label: f.name, use: m.kind === "video" ? "footage" : "reference" });
  }
  const brief: Brief = {
    idea,
    title: "Untitled",
    kind: input.kind,
    duration: input.duration,
    aspect: input.aspect,
    purpose: "",
    audience: "",
    tone: "",
    pacing: "",
    facts: [],
    assumptions: [],
    questions: [],
    needsProductImage: false,
    uploads,
    script: input.script?.trim() || undefined,
  };
  writeDoc(pid, "brief", brief, { author: "user", note: "Opening idea" });
  addMessage(pid, "user", { text: idea, stage: "brief" });
  const images = uploads.filter((u) => u.use === "reference").map((u) => u.mediaId);
  if (images.length) await adoptUploads(pid, idea, images);
  setPipeline(pid, { concepts: true });
  await advance(pid);
  kick();
  return pid;
}

/** Save one supplied file (image or video clip) with a preview. */
export async function storeUpload(pid: string, f: NewFile): Promise<MediaRow | null> {
  const mime = f.type === "image/jpg" ? "image/jpeg" : f.type === "video/quicktime" ? "video/mp4" : f.type;
  if (!mime.startsWith("image/") && !mime.startsWith("video/")) return null;
  const m = saveMedia({ projectId: pid, bytes: f.bytes, mime, provenance: "upload", name: "upload", meta: { filename: f.name } });
  await attachPreview(m);
  return m;
}

/**
 * Turn supplied images into kept identities (or note them as style references). Reading them
 * is a model call: it runs only under the planning allowance, and without one the images are
 * kept as plain references for the person to label.
 */
export async function adoptUploads(pid: string, idea: string, mediaIds: string[]) {
  const rows = mediaIds.map((id) => db().prepare("select * from media where id = ?").get(id) as MediaRow).filter(Boolean);
  const images: { base64: string; label: string }[] = [];
  for (const m of rows) {
    const jpg = await jpegFor(absPath(m), 768);
    if (jpg) images.push({ base64: jpg.toString("base64"), label: JSON.parse(m.meta || "{}").filename ?? "upload" });
  }
  if (!images.length) return;
  let items: Awaited<ReturnType<typeof classifyUploads>>["items"] = [];
  try {
    const r = await classifyUploads({ idea, images, bill: { projectId: pid, purpose: "Reading your uploads", authId: allowanceOf(pid)?.id ?? null } });
    items = r.items;
  } catch (err) {
    if (!(err instanceof SpendBlocked)) console.warn("[uploads] classification failed", (err as Error).message);
  }
  rows.forEach((m, i) => {
    const it = items[i];
    if (!it || it.kind === "style") return;
    attachUpload(pid, m.id, it.kind, it.name, { description: it.description, look: it.look, role: "Supplied by you" });
  });
}

export function attachUpload(pid: string, mediaId: string, kind: AssetKind, name: string, data: { description: string; look: string; role: string }, assetId?: string, opts: { role?: "primary" | "reference"; label?: string } = {}) {
  const aid = assetId ?? createAsset({ projectId: pid, kind, name, data });
  const role = opts.role ?? "primary";
  const vid = addAssetVersion({ assetId: aid, projectId: pid, mediaId, source: "upload", status: "ready", prompt: null, role, label: opts.label ?? "Your photo" });
  // The person's own photo as the main image is their decision: it becomes the approved identity.
  if (role === "primary") {
    keepAssetVersion(aid, vid);
    db().prepare("update assets set approved_version_id = ? where id = ?").run(vid, aid);
  }
  return { assetId: aid, versionId: vid };
}

/* ---------------- the sample project ---------------- */

export const SAMPLE_ID = "sample-quiet-hour";

function sampleMedia(pid: string, file: string, name: string): MediaRow {
  const bytes = fs.readFileSync(path.join(process.cwd(), "public", "sample", file));
  return saveMedia({ projectId: pid, bytes, mime: "image/svg+xml", provenance: "sample", width: 1280, height: 720, name, meta: { previewPath: undefined, sample: file } });
}

/**
 * "The quiet hour": the layout reference's café commercial, as a browsable project. Every
 * picture is labelled sample content; blocking and captures are computed live; nothing is
 * generated or billed, and the conversation replays recorded replies.
 */
export async function ensureSample() {
  if (getProject(SAMPLE_ID)) return SAMPLE_ID;
  const pid = createProject({ id: SAMPLE_ID, title: "The quiet hour", kind: "commercial", duration: 45, aspect: "16:9", sample: true, budgetCents: 0 });
  const f = { wide: sampleMedia(pid, "frame-1.svg", "cafe"), pour: sampleMedia(pid, "frame-2.svg", "pour"), mara: sampleMedia(pid, "frame-3.svg", "mara"), cup: sampleMedia(pid, "frame-4.svg", "cup") };

  const brief: Brief = {
    idea: "A cinematic film for our café. A small escape from a busy day. Warm, quiet, a little unexpected.",
    title: "The quiet hour",
    kind: "commercial",
    duration: 45,
    aspect: "16:9",
    summary: "A 45-second café film about one quiet pause in a busy morning.",
    purpose: "Make the café your daily pause",
    audience: "Busy locals who need a moment",
    tone: "Warm, quiet, a little unexpected",
    pacing: "Unhurried, one held moment",
    supplied: { purpose: false, audience: false, tone: true },
    facts: ["It's for our café", "A small escape from a busy day", "Warm, quiet, a little unexpected"],
    assumptions: ["Dawn light, a mostly empty room", "One character carries the story", "One voice line, no dialogue", "No prices or offers on screen"],
    questions: [],
    needsProductImage: false,
    uploads: [],
  };
  writeDoc(pid, "brief", brief, { author: "system", note: "Sample brief" });

  const concepts: ConceptSet = {
    chosenId: "k-quiet",
    concepts: [
      { id: "k-quiet", title: "The quiet hour", tag: "RECOMMENDED", pitch: "The street keeps rushing past; inside, one woman, one cup and one held moment by the window.", logline: "The world keeps moving. For one person, a cup of coffee makes it pause.", hook: "A busy street hush as the door closes.", structure: "Noise outside; the ritual inside; one held moment by the window.", why: "One character and one beautiful space give the feeling room to breathe.", look: "Warm amber morning light, olive walls, walnut wood, natural photographic realism, Kodak-like texture", imagePrompt: "", recommended: true, mediaId: f.mara.id },
      { id: "k-care", title: "Made with care", tag: "CRAFT & TEXTURE", pitch: "Hands, steam and walnut: the small rituals of a perfect cup, observed closely until the first sip.", logline: "Small rituals, beautifully observed. Let the making tell the story.", hook: "Steam rising off the first pour.", structure: "Hands, tools and textures build to the finished cup.", why: "Puts the craft forward without a single claim.", look: "Macro detail, raking window light, rich blacks", imagePrompt: "", recommended: false, mediaId: f.pour.id },
      { id: "k-connect", title: "A small connection", tag: "A HUMAN MOMENT", pitch: "Two strangers reach for the last window table, and a familiar café becomes the start of something.", logline: "A familiar place becomes the beginning of something unexpected.", hook: "Two strangers reach for the same table.", structure: "Arrival, a shared glance, a small warmth.", why: "Light storytelling with a gentle surprise.", look: "Wider frames, soft depth, gentle handheld", imagePrompt: "", recommended: false, mediaId: f.wide.id },
    ],
  };
  concepts.concepts = concepts.concepts.map((c) => ({ ...c, story: EXAMPLE_STORIES[c.title] }));
  writeDoc(pid, "concepts", concepts, { author: "system", note: "Sample directions" });

  const plan: Plan = {
    title: "The quiet hour",
    summary: "Mara slips out of the rush into the café and finds one quiet minute by the window.",
    treatment: "A busy morning softens the moment Mara steps inside. We stay with the small ritual of coffee and let one quiet moment by the window carry the feeling, ending on a simple invitation.",
    beats: [
      { id: "b1", start: 0, end: 8, visual: "A busy morning softens as Mara enters.", sound: "Street noise gives way to room tone.", lines: [] },
      { id: "b2", start: 8, end: 22, visual: "The ritual: a pour, steam, a cup placed down.", sound: "A gentle musical motif. Coffee sounds.", lines: [{ id: "b2l1", kind: "super", text: "A little space in your day" }] },
      { id: "b3", start: 22, end: 38, visual: "She settles by the window. A small smile.", sound: "Music opens up.", lines: [{ id: "b3l1", kind: "vo", text: "Make a little room for yourself." }] },
      { id: "b4", start: 38, end: 45, visual: "The cup. The café. A simple invitation.", sound: "Music resolves.", lines: [] },
    ],
    voice: { style: "Calm, warm narrator", voiceId: "configure-warm-narrator" },
    music: { mood: "Gentle solo piano with soft strings, unhurried, warm" },
    endCard: { line: "Make room.", detail: "[brand line]" },
  };
  writeDoc(pid, "plan", plan, { author: "system", note: "Sample AV plan", inputs: { brief: 1, concepts: 1, conceptId: "k-quiet" } });

  const mara = createAsset({ projectId: pid, kind: "character", name: "Mara", data: { description: "A regular who comes for the quiet before work", look: "Woman in her thirties, short dark curly hair, warm beige wool coat, natural skin", role: "A regular, before work", height: 1.68 } });
  const cafe = createAsset({ projectId: pid, kind: "location", name: "The café", data: { description: "A neighbourhood café at dawn", look: "Olive walls, walnut counter and tables, tall windows, amber light", role: "Walnut and morning light", set: "cafe" } });
  const cup = createAsset({ projectId: pid, kind: "prop", name: "The ceramic cup", data: { description: "The café's cream ceramic cup and saucer", look: "Cream glaze, simple rounded form", role: "Hero prop" } });
  for (const [aid, m] of [[mara, f.mara], [cafe, f.wide], [cup, f.cup]] as const) {
    const vid = addAssetVersion({ assetId: aid, projectId: pid, mediaId: m.id, source: "sample", status: "ready", role: "primary", label: "Sample" });
    keepAssetVersion(aid, vid);
    db().prepare("update assets set approved_version_id = ? where id = ?").run(vid, aid);
  }

  const durations = fitDurations([6, 7, 8, 9, 8, 7], 45);
  const base = { rev: 1, propIds: [] as string[], lineIds: [] as string[], speakerId: null, locationId: cafe };
  const shots: Shot[] = [
    { ...base, id: "s01", title: "The world outside", summary: "Mara comes in from the busy street", beatId: "b1", duration: durations[0], framing: "wide", move: "static", lens: 24, description: "Wide interior of the café at dawn, the street bright beyond the tall windows", action: "Mara walks in from the door toward the counter", characterIds: [mara] },
    { ...base, id: "s02", title: "The first pour", summary: "Coffee pours into the cream cup", beatId: "b2", duration: durations[1], framing: "detail", move: "push_in", lens: 85, description: "Macro of espresso pouring into the cream cup, steam catching the light", action: "Coffee pours into the cup on the counter", characterIds: [], propIds: [cup], lineIds: ["b2l1"] },
    { ...base, id: "s03", title: "A slower pace", summary: "She carries her cup to the window", beatId: "b2", duration: durations[2], framing: "medium", move: "track", lens: 35, description: "Mara carries her cup past the tables toward the window", action: "Mara walks toward the window table holding the cup", characterIds: [mara], propIds: [cup] },
    { ...base, id: "s04", title: "The quiet moment", summary: "Mara sits by the window and looks out", beatId: "b3", duration: durations[3], framing: "medium", move: "push_in", lens: 35, description: "Mara seated by the window, the city soft beyond the glass", action: "Mara sits at the window table and looks out, holding the cup", characterIds: [mara], propIds: [cup], lineIds: ["b3l1"] },
    { ...base, id: "s05", title: "A small smile", summary: "She turns slightly and smiles", beatId: "b3", duration: durations[4], framing: "close", move: "static", lens: 50, description: "Close on Mara's face in window light", action: "Mara turns slightly and smiles", characterIds: [mara] },
    { ...base, id: "s06", title: "Make room", summary: "The cup rests on the table", beatId: "b4", duration: durations[5], framing: "hero", move: "pull_out", lens: 50, description: "The cup and saucer on the walnut table, steam rising, the café beyond", action: "The cup rests on the table", characterIds: [], propIds: [cup] },
  ];
  writeDoc(pid, "shots", { shots }, { author: "system", note: "Sample shot plan", inputs: { plan: 1 } });

  const p = getProject(pid)!;
  const ids = assetIdentities(pid);
  const boards: Record<string, MediaRow> = { s01: f.wide, s02: f.pour, s03: f.wide, s04: f.mara, s05: f.mara, s06: f.cup };
  for (const shot of shots) {
    const scene = writeScene(pid, shot.id, blockShot(p, shot, ids), "system", "Automatic blocking from the shot plan");
    const assets: Record<string, string> = {};
    for (const aid of [shot.locationId, ...shot.characterIds, ...shot.propIds].filter(Boolean) as string[]) assets[aid] = ids.find((i) => i.asset.id === aid)!.version!.id;
    addFrame({ projectId: pid, shotId: shot.id, kind: "storyboard", mediaId: boards[shot.id].id, status: "ready", inputs: { shotRev: shot.rev, pictureKey: scene.pictureKey, sceneId: scene.id, assets, captureId: null } });
  }
  await advance(pid);
  kick();
  addMessage(pid, "agent", {
    text: "This is a sample: illustrative frames, no live generation, no cost. The grey 3D blocking is real; try a suggestion below.",
    stage: "concept",
    recorded: true,
  });
  return pid;
}
