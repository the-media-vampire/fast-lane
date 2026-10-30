import type { Vec3 } from "./types";
import type { ActorSample, PropSample } from "./sample";
import { MANNEQUIN_BASE_HEIGHT, PROP_DIMS } from "./sample";
import { WORLD_UP, cross, dot, facingDir, len, normalize, rad, sub, v3 } from "./vec";

/**
 * Pinhole projection into the shot frame: x and y run −1…1 across the frame, so a point is
 * in frame when both are within ±1. Pure maths, shared by framing (keep heads out of a
 * detail) and visibility (keep the cast in frame from the first frame).
 */

export type FrameSpec = { pos: Vec3; target: Vec3; fovV: number; fovH: number };

export function project(frame: FrameSpec, p: Vec3): { x: number; y: number; depth: number } | null {
  const fwd = normalize(sub(frame.target, frame.pos));
  let right = cross(fwd, WORLD_UP);
  right = len(right) < 1e-6 ? v3(1, 0, 0) : normalize(right);
  const up = cross(right, fwd);
  const d = sub(p, frame.pos);
  const depth = dot(d, fwd);
  if (depth <= 0.05) return null;
  return {
    x: dot(d, right) / depth / Math.tan(rad(frame.fovH) / 2),
    y: dot(d, up) / depth / Math.tan(rad(frame.fovV) / 2),
    depth,
  };
}

export function inFrame(frame: FrameSpec, p: Vec3, margin = 1): boolean {
  const q = project(frame, p);
  return !!q && Math.abs(q.x) <= margin && Math.abs(q.y) <= margin;
}

/** Eyes, chest, both shoulders and waist: a figure counts as in frame if any of them is. */
export function actorPoints(a: ActorSample): Vec3[] {
  const s = a.height / MANNEQUIN_BASE_HEIGHT;
  const drop = a.pose === "sit" ? 0.3 : 0;
  const f = facingDir(a.facing);
  const right = { x: f.z, z: -f.x };
  const chest = (1.3 - drop) * s;
  return [
    v3(a.x, (1.62 - drop) * s, a.z),
    v3(a.x, chest, a.z),
    v3(a.x + right.x * 0.25 * s, chest + 0.12 * s, a.z + right.z * 0.25 * s),
    v3(a.x - right.x * 0.25 * s, chest + 0.12 * s, a.z - right.z * 0.25 * s),
    v3(a.x, (a.pose === "sit" ? 0.7 : 1.0) * s, a.z),
  ];
}

export function eyePoint(a: ActorSample): Vec3 {
  return actorPoints(a)[0];
}

export function propCenter(p: PropSample): Vec3 {
  return v3(p.x, p.y + PROP_DIMS[p.size].height * 0.5, p.z);
}

/** A figure within 1.3 m of the lens is foreground (the shoulder in an over-the-shoulder). */
export function isForeground(frame: FrameSpec, a: ActorSample): boolean {
  return Math.hypot(a.x - frame.pos.x, a.z - frame.pos.z) < 1.3;
}

/**
 * In frame: their head is in the picture and their body isn't off the side. A foreground
 * figure only needs some of them in frame. This is the bar for "visible on the first frame".
 */
export function actorInFrame(frame: FrameSpec, a: ActorSample): boolean {
  const pts = actorPoints(a);
  if (isForeground(frame, a)) return pts.some((p) => inFrame(frame, p));
  const chest = project(frame, pts[1]);
  return inFrame(frame, pts[0]) && !!chest && Math.abs(chest.x) <= 1;
}

/** Comfortably framed: the whole head inside the frame, body clear of the sides. What a camera fix aims for. */
export function actorWellFramed(frame: FrameSpec, a: ActorSample): boolean {
  const pts = actorPoints(a);
  if (isForeground(frame, a)) return pts.some((p) => inFrame(frame, p, 0.95));
  const s = a.height / MANNEQUIN_BASE_HEIGHT;
  const crown = v3(a.x, (MANNEQUIN_BASE_HEIGHT - (a.pose === "sit" ? 0.3 : 0)) * s, a.z);
  const chest = project(frame, pts[1]);
  return inFrame(frame, pts[0], 0.85) && inFrame(frame, crown, 0.97) && !!chest && Math.abs(chest.x) <= 0.9;
}
