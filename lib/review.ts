import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { jpegFor } from "./ffmpeg";
import { structured, type Bill } from "./llm";
import { absPath, getMedia } from "./media";
import { freeMedia } from "./providers";
import { getAssetVersion, getFrame, getProject, getTake, latestScene, takeInputs, frameInputs } from "./repo";
import { assetIdentities, shotAssetIds, shotsDoc } from "./state";
import { MEDIA_DIR } from "./db";
import type { CutManifest } from "./types";

/**
 * Automated review. Takes get measurable checks (length, shape) plus a vision review of
 * sampled frames against the storyboard frame and the approved identities. Redrawn storyboard
 * frames get a drift check against the approved references. The cut gets runtime, format,
 * sound and loudness checks. None of this replaces a person's acceptance; exact camera motion
 * is only guaranteed in the grey blocking preview.
 */

const Verdict = z.object({
  usable: z.boolean().describe("Could this take play in the film without embarrassment?"),
  identity: z.enum(["consistent", "drifted", "not_applicable"]),
  location: z.enum(["consistent", "drifted", "not_applicable"]),
  props: z.enum(["consistent", "drifted", "not_applicable"]),
  adherence: z.enum(["good", "partial", "poor"]).describe("How well the motion and framing follow the intended shot"),
  generatedText: z.boolean().describe("Any legible generated lettering, logos or captions in the picture"),
  defects: z.array(z.string()).describe("Material defects only: warped faces or hands, morphing, flicker, wrong person, broken objects"),
  summary: z.string().describe("One short sentence for the director"),
  repairHint: z.string().describe("If not usable: one sentence of extra direction for a retake; else empty"),
});
export type TakeReview = z.infer<typeof Verdict> & { checks: { label: string; ok: boolean; detail: string }[]; cents: number };

export async function reviewTake(takeId: string, bill: Bill): Promise<TakeReview> {
  const take = getTake(takeId);
  if (!take?.media_id) throw new Error("The take has no video.");
  const video = getMedia(take.media_id)!;
  const ti = takeInputs(take);
  const shot = shotsDoc(take.project_id)?.data.shots.find((s) => s.id === take.shot_id);
  const media = freeMedia();
  const info = await media.inspect(absPath(video));
  const checks: TakeReview["checks"] = [];
  const need = shot?.duration ?? ti.seconds;
  checks.push({ label: "Length", ok: !!info && info.durationMs >= need * 1000 - 60, detail: info ? `${(info.durationMs / 1000).toFixed(2)} s for a ${need} s slot` : "unreadable" });
  const landscape = info?.width && info?.height ? info.width > info.height : null;
  const project = getProject(take.project_id)!;
  checks.push({ label: "Format", ok: landscape === (project.aspect === "16:9"), detail: info?.width ? `${info.width}×${info.height}` : "unknown" });

  // Sample frames: start, middle, end.
  const dir = path.join(MEDIA_DIR, take.project_id, "review");
  fs.mkdirSync(dir, { recursive: true });
  const seconds = (info?.durationMs ?? need * 1000) / 1000;
  const samples: Buffer[] = [];
  for (const t of [0.25, seconds / 2, Math.max(0.3, seconds - 0.35)]) {
    const out = path.join(dir, `${takeId}-${t.toFixed(2)}.jpg`);
    try {
      await media.frameAt({ videoPath: absPath(video), seconds: t, outPath: out });
      const jpg = await jpegFor(out, 768);
      if (jpg) samples.push(jpg);
    } catch {
      // A missing sample is reported by the reviewer's lower confidence, not fatal.
    }
  }

  const images: { mime: "image/jpeg"; base64: string; label: string }[] = [];
  const frame = getFrame(ti.frameId);
  const frameMedia = getMedia(frame?.media_id);
  if (frameMedia) {
    const jpg = await jpegFor(absPath(frameMedia), 768);
    if (jpg) images.push({ mime: "image/jpeg", base64: jpg.toString("base64"), label: "Intended first frame (approved storyboard):" });
  }
  if (shot) {
    const ids = assetIdentities(take.project_id).filter((i) => shotAssetIds(shot).includes(i.asset.id) && i.mediaId && i.asset.kind !== "location");
    for (const i of ids.slice(0, 3)) {
      const m = getMedia(i.mediaId);
      const jpg = m ? await jpegFor(absPath(m), 512) : null;
      if (jpg) images.push({ mime: "image/jpeg", base64: jpg.toString("base64"), label: `Approved reference for ${i.asset.name} (${i.asset.kind}):` });
    }
  }
  samples.forEach((s, i) => images.push({ mime: "image/jpeg", base64: s.toString("base64"), label: `Generated take, frame ${i + 1} of ${samples.length} (start, middle, end):` }));

  const scene = latestScene(take.project_id, take.shot_id);
  const { data, cents } = await structured({
    schema: Verdict,
    effort: "low",
    maxTokens: 3000,
    bill,
    system: "You review generated footage for a film studio. Judge only material problems a viewer would notice. Small differences from the storyboard are fine; identity drift, deformation, morphing, wrong people or objects, and generated lettering are not.",
    prompt: `Shot: ${shot?.title ?? "unknown"} — ${shot?.description ?? ""}. Action: ${shot?.action ?? ""}.
Intended camera: ${scene ? `${scene.data.camera.move.replace("_", " ")}, ${scene.data.camera.keys[0].lens}mm` : "unknown"}.
Review the generated take against the intended first frame and the approved references.`,
    images,
  });
  const failedCheck = checks.find((c) => !c.ok);
  return { ...data, usable: data.usable && !failedCheck, checks, cents };
}

/* ---------------- storyboard drift ---------------- */

const FrameVerdict = z.object({
  drift: z.enum(["none", "minor", "drifted"]).describe("Does any person, place or object look different from its approved reference?"),
  followedNote: z.boolean().describe("Did the frame make the requested change?"),
  summary: z.string().describe("One short sentence for the director"),
});
export type FrameReview = z.infer<typeof FrameVerdict>;

/** Compare a redrawn frame with the approved references and the requested change. */
export async function reviewFrame(frameId: string, bill: Bill): Promise<FrameReview & { cents: number }> {
  const frame = getFrame(frameId);
  const m = getMedia(frame?.media_id);
  if (!frame || !m) throw new Error("The frame has no picture.");
  const shot = shotsDoc(frame.project_id)?.data.shots.find((s) => s.id === frame.shot_id);
  const images: { mime: "image/jpeg"; base64: string; label: string }[] = [];
  const fi = frameInputs(frame);
  const ids = assetIdentities(frame.project_id);
  for (const [aid, vid] of Object.entries(fi.assets ?? {}).slice(0, 4)) {
    const id = ids.find((x) => x.asset.id === aid);
    const ref = getMedia(getAssetVersion(vid)?.media_id);
    const jpg = ref ? await jpegFor(absPath(ref), 512) : null;
    if (id && jpg) images.push({ mime: "image/jpeg", base64: jpg.toString("base64"), label: `Approved reference for ${id.asset.name} (${id.asset.kind}):` });
  }
  const jpg = await jpegFor(absPath(m), 900);
  if (jpg) images.push({ mime: "image/jpeg", base64: jpg.toString("base64"), label: "The redrawn storyboard frame:" });
  const { data, cents } = await structured({
    schema: FrameVerdict,
    effort: "low",
    maxTokens: 1500,
    bill,
    system: "You check storyboard frames for a film studio. Compare people, places and objects with their approved references; ignore differences in pose, camera angle and light.",
    prompt: `Shot: ${shot?.title ?? ""} — ${shot?.description ?? ""}.${frame.note ? ` Requested change: "${frame.note}".` : ""} Report identity drift and whether the change was made.`,
    images,
  });
  return { ...data, cents };
}

/* ---------------- the cut ---------------- */

export type CutReview = { checks: { label: string; ok: boolean; detail: string }[]; standIns: number; supers: string[] };

export async function reviewCut(manifest: CutManifest, result: { durationMs: number; width: number; height: number; hasAudio: boolean; loudness: { integrated: number; truePeak: number } | null }): Promise<CutReview> {
  const checks: CutReview["checks"] = [];
  const want = manifest.duration * 1000;
  checks.push({ label: "Runtime", ok: Math.abs(result.durationMs - want) <= 60, detail: `${(result.durationMs / 1000).toFixed(2)} s of ${manifest.duration} s` });
  checks.push({ label: "Frame", ok: result.width === manifest.width && result.height === manifest.height, detail: `${result.width}×${result.height} (${manifest.aspect})` });
  const expectsSound = manifest.voice.length > 0 || !!manifest.music;
  checks.push({ label: "Sound", ok: !expectsSound || result.hasAudio, detail: expectsSound ? `${manifest.voice.length} voice line${manifest.voice.length === 1 ? "" : "s"}${manifest.music ? " + music" : ""}` : "no sound requested" });
  if (result.loudness && expectsSound) {
    checks.push({
      label: "Loudness",
      ok: Math.abs(result.loudness.integrated + 14) <= 1.5 && result.loudness.truePeak <= -0.9,
      detail: `${result.loudness.integrated.toFixed(1)} LUFS, ${result.loudness.truePeak.toFixed(1)} dBTP`,
    });
  }
  const words = [...manifest.supers.map((s) => s.text), ...(manifest.endCard ? [manifest.endCard.line, manifest.endCard.detail ?? ""] : [])];
  const placeholders = [...new Set(words.flatMap((w) => w.match(/\[[^\]]+\]/g) ?? []))];
  checks.push({ label: "Copy", ok: placeholders.length === 0, detail: placeholders.length ? `Replace ${placeholders.join(", ")} with your real words before delivery` : "no placeholders on screen" });
  const standIns = manifest.shots.filter((s) => !s.takeId).length;
  checks.push({ label: "Footage", ok: standIns === 0, detail: standIns ? `${standIns} of ${manifest.shots.length} shots are storyboard stand-ins` : "every shot is footage" });
  return { checks, standIns, supers: manifest.supers.map((s) => s.text).concat(manifest.endCard ? [manifest.endCard.line, manifest.endCard.detail ?? ""].filter(Boolean) : []) };
}
