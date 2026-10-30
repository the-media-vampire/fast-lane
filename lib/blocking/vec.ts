import type { Vec3 } from "./types";

/** Small vector helpers on the contract's {x, y, z} shape. Pure; no three.js. */

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const mul = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));
export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
export const lerp3 = (a: Vec3, b: Vec3, u: number): Vec3 => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u) });
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const clamp01 = (x: number): number => clamp(x, 0, 1);
export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;
export const round = (x: number, places = 3): number => {
  const k = 10 ** places;
  return Math.round(x * k) / k;
};

export function normalize(a: Vec3): Vec3 {
  const l = len(a);
  return l < 1e-9 ? { x: 0, y: 0, z: 1 } : mul(a, 1 / l);
}

export const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

/** Rotate `p` about world-up through `pivot` by `d` degrees. */
export function orbitAround(p: Vec3, pivot: Vec3, d: number): Vec3 {
  const r = rad(d);
  const c = Math.cos(r);
  const s = Math.sin(r);
  const vx = p.x - pivot.x;
  const vz = p.z - pivot.z;
  return { x: pivot.x + vx * c + vz * s, y: p.y, z: pivot.z - vx * s + vz * c };
}

/** Heading of a direction in the XZ plane, degrees; 0 = +z, 90 = +x (atan2(dx, dz)). */
export function headingDeg(dx: number, dz: number): number {
  return deg(Math.atan2(dx, dz));
}

/** The direction a yaw faces: (sin yaw, cos yaw). */
export function facingDir(yawDeg: number): { x: number; z: number } {
  const r = rad(yawDeg);
  return { x: Math.sin(r), z: Math.cos(r) };
}

/** Signed shortest difference b − a in degrees, in (−180, 180]. */
export function angleDelta(a: number, b: number): number {
  const d = ((((b - a + 180) % 360) + 360) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Interpolate an angle the short way round. */
export function lerpAngle(a: number, b: number, u: number): number {
  return a + angleDelta(a, b) * u;
}

/** Normalise an angle to (−180, 180]. */
export function wrap180(a: number): number {
  return angleDelta(0, a);
}

/** Eases on a 0..1 clock. "gentle" is a soft start and landing for a 2-key move. */
export const EASES = {
  linear: (u: number) => u,
  gentle: (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  // Animation's "slow in": the move settles into its final frame (decelerating landing).
  slow_in: (u: number) => 1 - (1 - u) * (1 - u),
} as const;

/** Tiny deterministic hash for stable "random" choices (side of an angle, etc.). */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
