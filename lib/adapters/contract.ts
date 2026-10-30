import type { Aspect } from "../types";

/**
 * The bounded media surface Fast Lane uses, implemented in lib/adapters/media.ts (not connected
 * in this repository). The prototype's films were made with one proven route per task:
 *   pictures   Kie GPT Image 2 (fallback Seedream) with public reference URLs
 *   video      Kie Seedance 2.5, first-frame mode, 4–15 s clips
 *   voice      ElevenLabs eleven_multilingual_v2 with word timings
 *   music      Suno via Kie, cut to exact length
 *   assembly   ffmpeg filtergraph, EBU R128 loudness correction to −14 LUFS
 */

export type ImageEngine = "gptImage" | "seedream" | "nanoBanana";
export type Resolution = "480p" | "720p" | "1080p";
/**
 * `layout` is the grey blocking capture of the shot: the picture must match its camera
 * position, framing and figure placement, but never its grey look. Labels are written into
 * the reference roster verbatim ("Reference image 3 is Mara: …").
 */
export type RefRole = "character" | "location" | "prop" | "style" | "layout";

export type KiePoll =
  | { state: "pending" }
  | { state: "success"; urls: string[]; cents: number | null }
  | { state: "fail"; error: string; transient: boolean };

export type ClipPoll =
  | { status: "pending" }
  | { status: "done"; url: string; cents: number | null }
  | { status: "failed"; error: string; rejected: boolean };

export type Word = { word: string; startMs: number; endMs: number };

export type AssembleRequest = {
  width: number;
  height: number;
  fps: number;
  /** In edit order. Each clip is scaled/cropped to width×height, trimmed from trimInMs for durationMs. */
  clips: { path: string; trimInMs: number; durationMs: number; still?: boolean }[];
  /** Full-frame transparent PNGs (supers, end card). */
  overlays: { pngPath: string; startMs: number; endMs: number }[];
  /** Voice lines placed on the edit timeline. */
  voice: { path: string; startMs: number }[];
  music: { path: string; gainDb: number } | null;
  outPath: string;
  loudnessTarget: number;
};

export type AssembleResult = {
  path: string;
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
  loudness: { integrated: number; truePeak: number } | null;
};

export type OverlayRequest = {
  width: number;
  height: number;
  text: string;
  detail?: string;
  style: "lower" | "center" | "end";
  outPath: string;
};

export interface MediaServices {
  /** Kie balance in credits (1 credit = $0.005). Free. */
  credits(): Promise<number>;
  /** Make a local file fetchable by providers (Vercel Blob, public). Free apart from storage. */
  publish(input: { absPath: string; pathname: string; contentType: string }): Promise<{ url: string }>;
  imageSubmit(input: {
    engine: ImageEngine;
    prompt: string;
    aspect: Aspect;
    references: { url: string; role: RefRole; label: string }[];
  }): Promise<{ taskId: string; model: string; estCents: number }>;
  kiePoll(taskId: string): Promise<KiePoll>;
  clipSubmit(input: {
    frameUrl: string;
    prompt: string;
    seconds: number;
    aspect: Aspect;
    resolution: Resolution;
    cameraFixed: boolean;
    pathname: string;
  }): Promise<{ handle: string; providerTaskId: string; estCents: number; model: string }>;
  clipPoll(handle: string): Promise<ClipPoll>;
  /** Writes an mp3 to outPath. */
  speak(input: { text: string; voiceId: string; outPath: string }): Promise<{ durationMs: number; words: Word[]; cents: number }>;
  musicSubmit(input: { style: string; title: string; seconds: number }): Promise<{ taskId: string; estCents: number }>;
  musicPoll(taskId: string): Promise<{ state: "pending" } | { state: "success"; trackUrls: string[]; cents: number } | { state: "fail"; error: string }>;
  /** Download the tracks, cut the best one to exactly `seconds`, write outDir/name.mp3. */
  musicFinish(input: { trackUrls: string[]; seconds: number; outDir: string; name: string }): Promise<{ path: string; durationMs: number }>;
  renderOverlay(input: OverlayRequest): Promise<{ path: string }>;
  assemble(spec: AssembleRequest): Promise<AssembleResult>;
  inspect(path: string): Promise<{ durationMs: number; width?: number; height?: number; hasAudio: boolean } | null>;
  /** Grab one still (jpg) from a video at `seconds`. */
  frameAt(input: { videoPath: string; seconds: number; outPath: string }): Promise<{ path: string }>;
  /** Make a still image play as a clip (used when a slot has no live take yet). */
  stillToClip(input: { imagePath: string; seconds: number; width: number; height: number; outPath: string; push?: boolean }): Promise<{ path: string }>;
}

/** Provider prices the estimates use (Kie and ElevenLabs, as of October 2026). Check current pricing when connecting. */
export const PRICES = {
  imageCents: { gptImage: 5, seedream: 7, nanoBanana: 9 } as Record<ImageEngine, number>,
  videoCentsPerSecond: { "480p": 14, "720p": 31.5, "1080p": 79 } as Record<Resolution, number>,
  voiceCentsPer1000Chars: 10,
  musicCents: 6,
} as const;

export const CLIP_MIN_SECONDS = 4;
export const CLIP_MAX_SECONDS = 15;
