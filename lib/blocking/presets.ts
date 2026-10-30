import type { CameraKey, CameraMove, SetLayout, Vec3 } from "./types";
import { BLOCKING_LIMITS } from "./types";
import { insideFeature, isWallFeature, lensObstruction, setBounds, sightBlocked } from "./sets";
import { WORLD_UP, add, cross, dist, len, mul, normalize, orbitAround, sub } from "./vec";

/**
 * Camera moves as two keys (start pose at t = 0, end pose at t = duration), built by rotating
 * or translating the start pose (orbitAround in vec.ts). The amount is per move: push_in / pull_out are a fraction of the camera→subject distance,
 * pan and orbit are degrees, track is metres. Direction "left" is a positive
 * angle about world-up (pan-left / orbit-left) and the camera's left for a track.
 */

export const DEFAULT_AMOUNTS: Record<CameraMove, number> = {
  static: 0,
  push_in: 0.25,
  pull_out: 0.3,
  pan: 20,
  track: 1.2,
  orbit: 25,
};

const MAX_AMOUNTS: Record<CameraMove, number> = {
  static: 0,
  push_in: BLOCKING_LIMITS.pushMax,
  pull_out: BLOCKING_LIMITS.pushMax,
  pan: BLOCKING_LIMITS.panMax,
  track: BLOCKING_LIMITS.trackMax,
  orbit: BLOCKING_LIMITS.orbitMax,
};

export function clampAmount(move: CameraMove, amount: number): { amount: number; clamped: boolean } {
  const max = MAX_AMOUNTS[move];
  const a = Math.max(0, Math.min(max, Math.abs(amount)));
  return { amount: a, clamped: Math.abs(Math.abs(amount) - a) > 1e-9 };
}

export function amountLabel(move: CameraMove, amount: number): string {
  switch (move) {
    case "push_in":
    case "pull_out":
      return `${Math.round(amount * 100)}% of the distance`;
    case "pan":
    case "orbit":
      return `${Math.round(amount)}°`;
    case "track":
      return `${amount.toFixed(1)} m`;
    default:
      return "locked off";
  }
}

/** End pose of a move from its start pose. */
export function moveEnd(start: { pos: Vec3; target: Vec3 }, move: CameraMove, amount: number, direction: "left" | "right"): { pos: Vec3; target: Vec3 } {
  const { pos, target } = start;
  const view = sub(target, pos);
  const throwM = len(view) || 1;
  const fwd = normalize(view);
  let right = cross(fwd, WORLD_UP);
  right = len(right) < 1e-6 ? { x: 1, y: 0, z: 0 } : normalize(right);
  const sign = direction === "left" ? 1 : -1;
  switch (move) {
    case "push_in":
      return { pos: add(pos, mul(fwd, amount * throwM)), target };
    case "pull_out":
      return { pos: sub(pos, mul(fwd, amount * throwM)), target };
    case "pan":
      return { pos, target: orbitAround(target, pos, sign * amount) };
    case "orbit":
      return { pos: orbitAround(pos, target, sign * amount), target };
    case "track": {
      const off = mul(right, (direction === "right" ? 1 : -1) * amount);
      return { pos: add(pos, off), target: add(target, off) };
    }
    default:
      return { pos, target };
  }
}

/**
 * Two keys for a move. `faceY` (the subject's eye height) lets a push on a person settle
 * on the face rather than the chest: the end aim rises toward it in proportion to the push.
 */
export function moveKeys(start: CameraKey, move: CameraMove, amount: number, direction: "left" | "right", duration: number, opts: { faceY?: number | null } = {}): CameraKey[] {
  const first: CameraKey = { t: 0, pos: start.pos, target: start.target, lens: start.lens };
  if (move === "static" || amount <= 0) return [first];
  const end = moveEnd(start, move, amount, direction);
  if (move === "push_in" && opts.faceY != null && opts.faceY > start.target.y) {
    const lift = Math.min(1, amount / 0.35);
    end.target = { ...end.target, y: start.target.y + (opts.faceY - 0.04 - start.target.y) * lift };
  }
  return [first, { t: duration, pos: end.pos, target: end.target, lens: start.lens }];
}

/* ---------- camera bounds ---------- */

export function cameraBoundsIssue(set: SetLayout, pos: Vec3): string | null {
  const b = setBounds(set);
  const L = BLOCKING_LIMITS;
  const sideAllowance = set.exterior ? L.fourthWall : -0.2;
  if (pos.x < b.minX - sideAllowance || pos.x > b.maxX + sideAllowance) return "the camera would be outside the side walls";
  if (pos.z < b.minZ + 0.25) return "the camera would be behind the back wall";
  if (pos.z > b.maxZ + L.fourthWall) return `the camera would be more than ${L.fourthWall} m beyond the open side of the set`;
  const ceiling = set.exterior ? L.cameraHeightMax : Math.min(L.cameraHeightMax, set.height - 0.1);
  if (pos.y < L.cameraHeightMin) return `the camera would be below ${L.cameraHeightMin} m`;
  if (pos.y > ceiling) return `the camera would be above ${ceiling.toFixed(1)} m`;
  for (const f of set.features) {
    if (isWallFeature(f)) continue;
    const top = (f.elev ?? 0) + f.h;
    if (top > pos.y - 0.15 && insideFeature(f, pos.x, pos.z, 0.12)) return `the camera would be inside the ${f.label.toLowerCase()}`;
  }
  return null;
}

/**
 * Keep a move inside the set: try the requested amount, then smaller ones. Returns the
 * amount actually used (0 means the move could not fit and the shot is locked off).
 */
export function fitMove(set: SetLayout, start: CameraKey, move: CameraMove, amount: number, direction: "left" | "right"): { amount: number; reduced: boolean } {
  if (move === "static" || amount <= 0) return { amount: 0, reduced: false };
  let insideOnly: number | null = null;
  for (const k of [1, 0.75, 0.5, 0.3]) {
    const a = amount * k;
    const end = moveEnd(start, move, a, direction);
    // A push must stop short of the subject.
    if (move === "push_in" && dist(end.pos, end.target) < 0.35) continue;
    if (cameraBoundsIssue(set, end.pos)) continue;
    // Prefer an end frame that still sees the subject; take one that doesn't only if nothing else fits.
    if (!sightBlocked(set, end.pos, end.target) && !lensObstruction(set, end.pos, end.target)) return { amount: a, reduced: k < 1 };
    if (insideOnly === null) insideOnly = a;
  }
  return insideOnly !== null ? { amount: insideOnly, reduced: insideOnly < amount } : { amount: 0, reduced: true };
}
