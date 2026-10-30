import { z } from "zod";

/**
 * Shared contracts for the Fast Lane. Every document the studio stores is one of these
 * shapes; the agent, the UI and the workers all read and write through them.
 */

export const DURATION_PRESETS = [30, 45, 60, 90, 120] as const;
export const MIN_DURATION = 30;
export const MAX_DURATION = 120;
export const LIMITS = {
  locations: 3,
  characters: 3,
  shots: 24,
  repairAttempts: 2,
  shotMin: 2,
  shotMax: 10,
} as const;

export const Kind = z.enum(["commercial", "film"]);
export type Kind = z.infer<typeof Kind>;
export const Aspect = z.enum(["16:9", "9:16"]);
export type Aspect = z.infer<typeof Aspect>;
export const Duration = z.number().int().min(MIN_DURATION).max(MAX_DURATION);

export const STAGES = ["brief", "concept", "assets", "shots", "direct", "cut"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  brief: "Brief",
  concept: "Concept",
  assets: "Assets",
  shots: "Shots",
  direct: "Direct",
  cut: "Cut",
};

/** Old Plan links now open the visual plan. The written plan stays internal. */
export function studioStage(value: unknown): Stage | null {
  if (value === "plan") return "shots";
  return STAGES.includes(value as Stage) ? (value as Stage) : null;
}

/* ---------- Brief ---------- */

export const Choice = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  recommended: z.boolean().optional(),
});
export type Choice = z.infer<typeof Choice>;

export const Question = z.object({
  id: z.string(),
  question: z.string(),
  why: z.string(),
  choices: z.array(Choice).min(2).max(3),
  answer: z.string().optional(),
});
export type Question = z.infer<typeof Question>;

export const Brief = z.object({
  idea: z.string(),
  title: z.string(),
  kind: Kind,
  duration: Duration,
  aspect: Aspect,
  purpose: z.string(),
  audience: z.string(),
  tone: z.string(),
  pacing: z.string(),
  /** Things the user actually said or supplied. Never invented. */
  facts: z.array(z.string()),
  /** Creative proposals the agent made to fill gaps. Editable, clearly labelled. */
  assumptions: z.array(z.string()),
  /** Only consequential open questions, each with 2–3 choices. */
  questions: z.array(Question),
  /** Product identity, prices, offer terms and claims are never invented. */
  needsProductImage: z.boolean(),
  uploads: z.array(z.object({ mediaId: z.string(), label: z.string(), use: z.string() })),
  /** One sentence the person reads first. */
  summary: z.string().optional(),
  /** Which fields the person stated themselves (the rest are Astra's assumptions). */
  supplied: z.object({ purpose: z.boolean(), audience: z.boolean(), tone: z.boolean() }).optional(),
  /** A script the person pasted at the start. Its words are kept. */
  script: z.string().optional(),
});
export type Brief = z.infer<typeof Brief>;

/* ---------- Concept ---------- */

export const StoryBeat = z.object({
  title: z.string().min(1).max(50),
  visual: z.string().min(1).max(350),
  lines: z.array(z.object({
    kind: z.enum(["vo", "dialogue", "super"]),
    speaker: z.string().optional(),
    text: z.string().min(1).max(400),
  })).max(8),
});
export type StoryBeat = z.infer<typeof StoryBeat>;
export const ConceptStory = z.array(StoryBeat).min(4).max(6);

export const Concept = z.object({
  id: z.string(),
  title: z.string(),
  tag: z.string(),
  /** One sentence of 15–20 words for the card. Hook, shape and reasons are shown on request. */
  pitch: z.string().optional(),
  logline: z.string(),
  hook: z.string(),
  structure: z.string(),
  /** The short story the person reviews before committing to assets. */
  story: ConceptStory.optional(),
  /** Proposed edits leave the previously chosen story and existing work intact. */
  storyDraft: ConceptStory.optional(),
  why: z.string(),
  look: z.string(),
  imagePrompt: z.string(),
  recommended: z.boolean(),
  mediaId: z.string().optional(),
  jobId: z.string().optional(),
});
export type Concept = z.infer<typeof Concept>;

export const ConceptSet = z.object({
  concepts: z.array(Concept).length(3),
  chosenId: z.string().nullable(),
  direction: z.string().optional(),
});
export type ConceptSet = z.infer<typeof ConceptSet>;

/* ---------- Plan (AV plan for ads, scene script for films; one beat list feeds shots) ---------- */

export const Line = z.object({
  id: z.string(),
  kind: z.enum(["vo", "dialogue", "super"]),
  /** For dialogue: the speaking character's asset name. One visible speaker per shot. */
  speaker: z.string().optional(),
  text: z.string(),
});
export type Line = z.infer<typeof Line>;

export const Beat = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  scene: z.string().optional(), // film: scene heading, e.g. "INT. CAFÉ – DAWN"
  visual: z.string(), // what we see / scene action
  sound: z.string(), // sound design and music direction
  lines: z.array(Line),
});
export type Beat = z.infer<typeof Beat>;

export const Plan = z.object({
  title: z.string(),
  /** One sentence above the plan. */
  summary: z.string().optional(),
  treatment: z.string(),
  beats: z.array(Beat).min(2),
  voice: z.object({
    style: z.string(),
    voiceId: z.string().optional(),
    /** Character asset id → voice id for dialogue. */
    cast: z.record(z.string(), z.string()).optional(),
  }),
  music: z.object({ mood: z.string(), trackId: z.string().optional() }),
  endCard: z.object({ line: z.string(), detail: z.string().optional() }).optional(),
});
export type Plan = z.infer<typeof Plan>;

/* ---------- Assets ---------- */

export const AssetKind = z.enum(["character", "location", "prop"]);
export type AssetKind = z.infer<typeof AssetKind>;

export const AssetData = z.object({
  description: z.string(),
  look: z.string(),
  role: z.string(),
  /** Coarse set layout for locations, used by blocking. */
  set: z.string().optional(),
  /** Height in metres for characters, used by blocking. */
  height: z.number().optional(),
  /** Size class for props, used by blocking. */
  size: z.enum(["small", "medium", "large"]).optional(),
});
export type AssetData = z.infer<typeof AssetData>;

/* ---------- Shots ---------- */

export const Framing = z.enum(["wide", "medium", "close", "detail", "hero", "ots", "pov"]);
export type Framing = z.infer<typeof Framing>;
export const Move = z.enum(["static", "push_in", "pull_out", "pan", "track", "orbit"]);
export type Move = z.infer<typeof Move>;

export const Shot = z.object({
  id: z.string(),
  /** Bumped whenever anything that changes the generated picture changes. */
  rev: z.number().int(),
  title: z.string(),
  /** What happens, in a few plain words (the description and action stay for prompts). */
  summary: z.string().optional(),
  /** Standing direction for this shot only, e.g. "She wears a dark wool hat." */
  direction: z.string().optional(),
  beatId: z.string().nullable(),
  duration: z.number().min(LIMITS.shotMin).max(LIMITS.shotMax),
  framing: Framing,
  move: Move,
  lens: z.number().min(18).max(135),
  description: z.string(),
  action: z.string(),
  locationId: z.string().nullable(),
  characterIds: z.array(z.string()).max(LIMITS.characters),
  propIds: z.array(z.string()),
  /** Plan line ids heard or shown over this shot. */
  lineIds: z.array(z.string()),
  speakerId: z.string().nullable(),
});
export type Shot = z.infer<typeof Shot>;

export const ShotList = z.object({ shots: z.array(Shot).max(LIMITS.shots) });
export type ShotList = z.infer<typeof ShotList>;

/* ---------- Cut ---------- */

export const CutManifest = z.object({
  aspect: Aspect,
  width: z.number(),
  height: z.number(),
  duration: z.number(),
  shots: z.array(
    z.object({
      shotId: z.string(),
      takeId: z.string().nullable(),
      /** When no live take exists the grey blocking capture or storyboard holds the slot. */
      fallback: z.enum(["storyboard", "capture", "black"]).nullable(),
      mediaId: z.string().nullable(),
      start: z.number(),
      duration: z.number(),
      trimIn: z.number(),
    }),
  ),
  voice: z.array(z.object({ lineId: z.string(), audioId: z.string(), mediaId: z.string(), start: z.number() })),
  music: z.object({ audioId: z.string(), mediaId: z.string(), gainDb: z.number() }).nullable(),
  supers: z.array(z.object({ lineId: z.string(), text: z.string(), start: z.number(), end: z.number(), style: z.enum(["lower", "center", "end"]) })),
  endCard: z.object({ line: z.string(), detail: z.string().optional(), start: z.number() }).nullable(),
});
export type CutManifest = z.infer<typeof CutManifest>;
