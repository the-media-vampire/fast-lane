import type { Scene } from "./blocking/types";
import type { AssetData, AssetKind, Brief, Concept, CutManifest, Plan, Shot, Stage } from "./types";

/** The JSON the studio receives. Shared by the server view builder and client components. */

export type Provenance = "sample" | "live" | "upload" | "blocking" | "assembled";
export type StageStatus = "empty" | "working" | "ready" | "outdated" | "attention";
export type MediaRef = { id: string; url: string; preview: string; provenance: Provenance; kind: "image" | "video" | "audio" };
export type Mode = "live" | "off" | "sample";

export type TakeView = {
  id: string;
  media: MediaRef | null;
  poster: string | null;
  status: "pending" | "ready" | "failed";
  verdict: "none" | "accepted" | "rejected";
  current: boolean;
  attempt: number;
  source: "generated" | "upload";
  review: { usable: boolean; summary: string; defects: string[]; checks: { label: string; ok: boolean; detail: string }[] } | null;
  error: string | null;
  createdAt: string;
};

export type FrameVersion = {
  id: string;
  media: MediaRef | null;
  status: string;
  note: string | null;
  current: boolean;
  drift: { drift: string; followedNote: boolean; check: string } | null;
  createdAt: string;
};

export type Words = { id: string; kind: "vo" | "dialogue" | "super"; speaker?: string; text: string };

export type ShotView = Shot & {
  index: number;
  number: string;
  start: number;
  /** What happens, in a few words. */
  summaryText: string;
  /** What the camera does, in plain words. */
  movement: string;
  framingText: string;
  /** The voice, dialogue and on-screen words heard or seen over this shot. */
  words: Words[];
  castNames: string[];
  locationName: string | null;
  scene: { id: string; rev: number; data: Scene; author: string; note: string | null } | null;
  blockingVersions: { rev: number; author: string; note: string | null; createdAt: string }[];
  capture: { media: MediaRef | null; current: boolean; status: string } | null;
  storyboard: { media: MediaRef | null; current: boolean; status: string; reasons: string[]; note: string | null } | null;
  storyboards: FrameVersion[];
  takes: TakeView[];
  pick: { kind: "take" | "storyboard" | "capture"; media: MediaRef | null } | null;
  generating: boolean;
  attention: string | null;
  approval: "approved" | "changed" | "new";
};

export type AssetImage = { id: string; version: number; media: MediaRef | null; label: string | null; source: string; status: string; role: "primary" | "reference"; note: string | null; createdAt: string };

export type AssetView = {
  id: string;
  kind: AssetKind;
  name: string;
  role: string;
  data: AssetData;
  status: "approved" | "proposed" | "sample" | "drawing" | "missing";
  primary: AssetImage | null;
  /** Newer main images waiting for the person's approval. */
  proposals: AssetImage[];
  /** Separate reference images (angles, outfits, details). */
  gallery: AssetImage[];
  approvedVersionId: string | null;
  usedIn: number;
};

export type CutView = {
  id: string;
  version: number;
  media: MediaRef | null;
  status: "pending" | "ready" | "failed";
  /** What this version is made of. */
  kind: "animatic" | "partial" | "footage";
  footageShots: number;
  totalShots: number;
  acceptance: "animatic" | "final" | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  finalReady: { ok: boolean; reasons: string[]; manualShots?: number };
  note: string | null;
  review: { checks: { label: string; ok: boolean; detail: string }[]; standIns: number; supers: string[]; creativeNotes?: string[] } | null;
  manifest: CutManifest;
  createdAt: string;
};

export type JobView = { id: string; kind: string; label: string; status: string; error: string | null; hold: string | null; estCents: number; actualCents: number | null; providerTaskId: string | null; createdAt: string; updatedAt: string };

export type QuoteCard = {
  id: string;
  op: string;
  cents: number;
  ceilingCents: number;
  label: string;
  detail: { scope: string[]; lines: { label: string; cents: number }[]; retryCents: number; notes: string[]; covers: string[]; authKind: string };
  status: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
};

export type MessageView = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  choices?: { id: string; label: string; detail?: string; recommended?: boolean }[];
  results?: { label: string; detail?: string; ok: boolean }[];
  quote?: QuoteCard;
  questionId?: string;
  stage?: Stage;
  focus?: { kind: string; id?: string; label: string; time?: number };
  recorded?: boolean;
  archived?: boolean;
  cents?: number;
  createdAt: string;
};

export type EstimateView = {
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

export type NextDecision = {
  kind: "off" | "quote" | "uncertain" | "allowance" | "question" | "concept" | "frames" | "approve-sequence" | "generate" | "producing" | "attention" | "final" | "animatic" | "working" | "done";
  label: string;
  detail?: string;
  op?: string;
  input?: Record<string, unknown>;
  quoteId?: string;
  stage?: Stage;
  questionId?: string;
  choices?: { id: string; label: string; recommended?: boolean }[];
};

export type AuthView = { id: string; kind: string; label: string; ceilingCents: number; spentCents: number; reservedCents: number; remainingCents: number; status: string; createdAt: string };

export type AnimaticSound = {
  voice: { id: string; lineId: string; start: number; duration: number; media: MediaRef }[];
  music: { media: MediaRef; duration: number; gainDb: number } | null;
  supers: CutManifest["supers"];
  endCard: CutManifest["endCard"];
};

export type ProjectView = {
  project: { id: string; title: string; kind: "commercial" | "film"; duration: number; aspect: "16:9" | "9:16"; sample: boolean; autopilot: boolean; reviewer: string | null; rev: number; createdAt: string; updatedAt: string };
  mode: Mode;
  modeReason: string | null;
  spend: { budgetCents: number; spentCents: number; reservedCents: number; remainingCents: number; uncertainCents: number; estimatedCents: number; approvedCents: number };
  allowance: AuthView | null;
  authorizations: AuthView[];
  quotes: QuoteCard[];
  pipeline: { concepts?: boolean; develop?: boolean; produce?: boolean; paused?: { code: string; reason: string; phase: string } | null; attention?: string[] | null };
  stages: Record<Stage, { status: StageStatus; label?: string; note?: string }>;
  brief: { version: number; data: Brief; interpreted: boolean } | null;
  concepts: { version: number; chosenId: string | null; direction?: string; items: (Concept & { media: MediaRef | null; imageStatus: "none" | "pending" | "ready" | "failed"; pitchText: string })[] } | null;
  plan: { version: number; data: Plan; author: string; note: string | null; createdAt: string; versions: number; summaryText: string; unplaced: Words[] } | null;
  assets: AssetView[];
  shots: { version: number; planOutdated: boolean; items: ShotView[] } | null;
  sequence: { approvedAt: string | null; reviewer: string | null; allApproved: boolean; changed: string[]; blockers: string[] } | null;
  production: { state: "idle" | "running" | "paused" | "attention"; reason: string | null; attention: string[]; footage: number; total: number };
  cuts: CutView[];
  footage: { mediaId: string; label: string; media: MediaRef | null }[];
  sound: { voiceReady: number; voiceTotal: number; music: "none" | "pending" | "ready" | "failed" };
  /** Current plan's ready audio and timed text. Reading this never creates media or a cut. */
  animatic?: AnimaticSound;
  jobs: { active: JobView[]; attention: JobView[]; recent: JobView[] };
  messages: MessageView[];
  estimate: EstimateView | null;
  next: NextDecision | null;
  ledger: { at: string; cents: number; note: string; basis: string | null }[];
  provider: { kieCredits: number | null; live: boolean; models: string[]; videoResolution: string };
};
