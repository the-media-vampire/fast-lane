import type { MediaServices } from "./contract";

/**
 * The media adapter: where pictures, video, voice, music and assembly come from.
 *
 * NOT CONNECTED in this repository. Every method below rejects with a MediaError of kind
 * "not_connected", so the studio runs for review (projects, frames, cuts, blocking, Astra)
 * but any generation step fails with a clear message instead of reaching a provider.
 *
 * To connect it, implement each method of MediaServices (lib/adapters/contract.ts documents
 * the shapes, units and the provider routes the prototype used). Read keys with
 * `secret("KIE_API_KEY")` etc. from lib/env.ts; never log them. Keep these semantics, which
 * the worker relies on:
 *   - throw MediaError for every failure, with `kind`, `transient` and `rejected`;
 *   - a paid submission (imageSubmit, clipSubmit, musicSubmit, speak) whose outcome is unknown
 *     (timeout, lost connection) must fail with kind "ambiguous": the provider may have
 *     created the task, so the worker holds it for a person instead of resubmitting;
 *   - kind "credits" means the provider account is empty;
 *   - `transient: true` on a free call (polls, inspect) makes the worker retry later.
 * Spending is gated before these methods are called (lib/providers.ts → lib/billing.ts), so
 * an implementation only performs the call and reports its real cost in cents.
 */

export class MediaError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly transient: boolean,
    readonly rejected = false,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

const notConnected = (method: string) => () =>
  Promise.reject(
    new MediaError(`Media generation is not connected (${method}). Implement it in lib/adapters/media.ts; see "Connecting generation" in the README.`, "not_connected", false),
  );

export function mediaStatus() {
  return { connected: false, adapter: "lib/adapters/media.ts" };
}

export const media: MediaServices & {
  /** Which keys resolve and which provider routes are live. Free. */
  ping(): Promise<{ keys: Record<string, boolean>; videoProvider: string | null }>;
  /** The exact provider body a paid call would send; nothing is submitted. */
  dryRun(method: "imageSubmit" | "clipSubmit" | "musicSubmit", params: unknown): Promise<{ model: string; input: Record<string, unknown>; estCents: number; droppedReferences?: number }>;
} = {
  ping: notConnected("ping"),
  credits: notConnected("credits"),
  publish: notConnected("publish"),
  imageSubmit: notConnected("imageSubmit"),
  kiePoll: notConnected("kiePoll"),
  clipSubmit: notConnected("clipSubmit"),
  clipPoll: notConnected("clipPoll"),
  speak: notConnected("speak"),
  musicSubmit: notConnected("musicSubmit"),
  musicPoll: notConnected("musicPoll"),
  musicFinish: notConnected("musicFinish"),
  renderOverlay: notConnected("renderOverlay"),
  assemble: notConnected("assemble"),
  inspect: notConnected("inspect"),
  frameAt: notConnected("frameAt"),
  stillToClip: notConnected("stillToClip"),
  dryRun: notConnected("dryRun"),
};
