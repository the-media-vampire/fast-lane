import type { Scene } from "./blocking/types";
import type { Shot } from "./types";

/**
 * Plain words for the default screens. Lens and camera terminology stay available in the
 * details; the first thing a person reads is what the camera does.
 */

export function movementPlain(shot: Pick<Shot, "move" | "framing">, scene?: Scene | null): string {
  const cam = scene?.camera;
  const move = cam?.move ?? shot.move;
  const slow = cam ? (cam.ease === "slow_in" || (move === "push_in" || move === "pull_out" ? cam.amount < 0.18 : move === "track" ? cam.amount < 0.8 : cam.amount < 14)) : false;
  const dir = cam?.direction ?? "right";
  switch (move) {
    case "static":
      return "Camera holds still";
    case "push_in":
      return slow ? "Camera eases closer" : "Camera moves closer";
    case "pull_out":
      return slow ? "Camera eases back" : "Camera pulls back";
    case "pan":
      return `Camera turns ${dir}`;
    case "track":
      return slow ? "Camera drifts alongside" : "Camera travels alongside";
    case "orbit":
      return `Camera circles ${dir}`;
    default:
      return "Camera holds still";
  }
}

export const FRAMING_PLAIN: Record<string, string> = {
  wide: "Wide",
  medium: "Medium",
  close: "Close-up",
  detail: "Detail",
  hero: "Hero shot",
  ots: "Over the shoulder",
  pov: "Point of view",
};

/**
 * A short version of a long description for legacy content written before short fields
 * existed: the first sentence or clause, never cut mid-word. Not used on dialogue or
 * on-screen words, which are always shown whole.
 */
export function brevity(text: string | null | undefined, maxWords = 12): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const words = t.split(" ");
  if (words.length <= maxWords) return t.replace(/[.;:,]+$/, "");
  const sentence = t.split(/(?<=[.!?])\s/)[0];
  if (sentence.split(" ").length <= maxWords) return sentence.replace(/[.;:,]+$/, "");
  for (const sep of [";", " — ", ": ", ", then ", ", "]) {
    const head = t.split(sep)[0];
    const n = head.split(" ").length;
    if (n >= 4 && n <= maxWords) return head.replace(/[.;:,]+$/, "");
  }
  return `${words.slice(0, maxWords).join(" ").replace(/[.;:,]+$/, "")}…`;
}

export function shotNumber(index: number) {
  return String(index + 1).padStart(2, "0");
}

export function clockText(seconds: number) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = Math.round((s - m * 60) * 10) / 10;
  const whole = Number.isInteger(r) ? String(r).padStart(2, "0") : r.toFixed(1).padStart(4, "0");
  return `${m}:${whole}`;
}
