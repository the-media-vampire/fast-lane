import type { Actor, Mark, Pose, PropPlacement, Scene, Vec3 } from "./types";
import { fovs } from "./lens";
import { EASES, add, clamp01, deg, facingDir, headingDeg, lerp, lerp3, lerpAngle, len, mul, normalize, sub, v3 } from "./vec";

/**
 * THE sampler. Camera view, overhead plan, captures and prompt descriptions all read the
 * scene through `sampleSceneAt`, so they cannot disagree about where anyone is.
 *
 * Look-at cameras with world-up, lens interpolated on the same eased clock, figures travelling each leg at a steady pace and
 * turning the short way round. Fast Lane camera moves have two keys, so the "arc" is
 * explicit per move: orbit and pan interpolate angles (a straight chord would cut the
 * corner), the dolly moves interpolate positions.
 */

export type CameraSample = {
  pos: Vec3;
  target: Vec3;
  lens: number;
  fovV: number;
  fovH: number;
  /** Heading of the view direction in XZ, degrees (atan2(dx, dz)). */
  yaw: number;
  /** Elevation of the view direction, degrees; negative looks down. */
  pitch: number;
};

export type ActorSample = {
  id: string;
  name: string;
  x: number;
  z: number;
  facing: number;
  pose: Pose;
  height: number;
  color: string;
  moving: boolean;
};

export type PropSample = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  size: PropPlacement["size"];
  heldBy: string | null;
  /** Yaw in degrees; a large prop's length runs along its local x. */
  rot: number;
};

/**
 * Blocking sizes of props, metres: length (local x), height, width (local z). Small reads
 * as a cup, medium as a box-sized object, large as a long, low, open silhouette (a bicycle,
 * a bench, a pram) that stands on the floor.
 */
export const PROP_DIMS: Record<PropPlacement["size"], { length: number; height: number; width: number }> = {
  small: { length: 0.1, height: 0.1, width: 0.1 },
  medium: { length: 0.38, height: 0.32, width: 0.32 },
  large: { length: 1.7, height: 1.0, width: 0.25 },
};

export type SceneSample = { t: number; camera: CameraSample; actors: ActorSample[]; props: PropSample[] };

export type ScenePaths = {
  camera: Vec3[];
  actors: { id: string; name: string; color: string; points: { x: number; z: number }[] }[];
};

/** Marker hues (blue, green, red) — an aid for telling cast apart, never an id. */
export const ACTOR_COLORS = ["#3B82F6", "#22C55E", "#EF4444"] as const;
export const ACTOR_COLOR_NAMES = ["blue", "green", "red"] as const;

/** Standing mannequin height at scale 1, in metres. */
export const MANNEQUIN_BASE_HEIGHT = 1.82;

const MOVE_EPS = 0.05; // metres: below this a leg is a turn on the spot, not a walk
const TURN_WINDOW = 0.4; // seconds spent turning into / out of a walk

export function sampleCamera(scene: Scene, t: number): CameraSample {
  const keys = [...scene.camera.keys].sort((a, b) => a.t - b.t);
  const k0 = keys[0];
  const k1 = keys[keys.length - 1];
  let pos = k0.pos;
  let target = k0.target;
  let lens = k0.lens;
  if (keys.length > 1 && k1.t > k0.t) {
    const u = clamp01((t - k0.t) / (k1.t - k0.t));
    const e = EASES[scene.camera.ease ?? "gentle"](u);
    lens = lerp(k0.lens, k1.lens, e);
    if (scene.camera.move === "orbit") {
      // Ride the circle about the (interpolated) subject: angle, radius and height.
      const pivot = lerp3(k0.target, k1.target, e);
      const a0 = headingDeg(k0.pos.x - k0.target.x, k0.pos.z - k0.target.z);
      const a1 = headingDeg(k1.pos.x - k1.target.x, k1.pos.z - k1.target.z);
      const r0 = Math.hypot(k0.pos.x - k0.target.x, k0.pos.z - k0.target.z);
      const r1 = Math.hypot(k1.pos.x - k1.target.x, k1.pos.z - k1.target.z);
      const dir = facingDir(lerpAngle(a0, a1, e));
      const r = lerp(r0, r1, e);
      pos = v3(pivot.x + dir.x * r, lerp(k0.pos.y, k1.pos.y, e), pivot.z + dir.z * r);
      target = pivot;
    } else if (scene.camera.move === "pan") {
      // The camera head turns: interpolate heading, tilt and throw about the moving position.
      pos = lerp3(k0.pos, k1.pos, e);
      const d0 = sub(k0.target, k0.pos);
      const d1 = sub(k1.target, k1.pos);
      const yaw = lerpAngle(headingDeg(d0.x, d0.z), headingDeg(d1.x, d1.z), e);
      const pitch = lerp(Math.atan2(d0.y, Math.hypot(d0.x, d0.z)), Math.atan2(d1.y, Math.hypot(d1.x, d1.z)), e);
      const throwM = lerp(len(d0), len(d1), e);
      const h = facingDir(yaw);
      target = add(pos, mul(v3(h.x * Math.cos(pitch), Math.sin(pitch), h.z * Math.cos(pitch)), throwM));
    } else {
      pos = lerp3(k0.pos, k1.pos, e);
      target = lerp3(k0.target, k1.target, e);
    }
  }
  const { fovV, fovH } = fovs(lens, scene.aspect);
  const f = normalize(sub(target, pos));
  return { pos, target, lens, fovV, fovH, yaw: headingDeg(f.x, f.z), pitch: deg(Math.asin(Math.max(-1, Math.min(1, f.y)))) };
}

function sortedMarks(actor: Actor): Mark[] {
  return [...actor.marks].sort((a, b) => a.t - b.t);
}

export function sampleActor(actor: Actor, index: number, t: number): ActorSample {
  const marks = sortedMarks(actor);
  const base = {
    id: actor.id,
    name: actor.name,
    height: actor.height ?? 1.72,
    color: ACTOR_COLORS[index % ACTOR_COLORS.length],
  };
  if (marks.length === 1 || t <= marks[0].t) {
    const m = marks[0];
    return { ...base, x: m.x, z: m.z, facing: m.facing, pose: m.pose, moving: false };
  }
  const last = marks[marks.length - 1];
  if (t >= last.t) return { ...base, x: last.x, z: last.z, facing: last.facing, pose: last.pose, moving: false };
  let i = 0;
  while (i < marks.length - 2 && t > marks[i + 1].t) i++;
  const a = marks[i];
  const b = marks[i + 1];
  const span = Math.max(1e-6, b.t - a.t);
  const u = clamp01((t - a.t) / span);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const travel = Math.hypot(dx, dz);
  if (travel < MOVE_EPS) {
    // A turn or a pose change on the spot: the pose switches when its mark is reached.
    return { ...base, x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u), facing: lerpAngle(a.facing, b.facing, u), pose: a.pose, moving: false };
  }
  // A walk: steady pace along the leg, facing the direction of travel, with a short
  // turn out of the start facing and into the end facing.
  const heading = headingDeg(dx, dz);
  const local = u * span;
  const tw = Math.min(TURN_WINDOW, span / 3);
  let facing = heading;
  if (local < tw) facing = lerpAngle(a.facing, heading, local / tw);
  else if (local > span - tw) facing = lerpAngle(heading, b.facing, (local - (span - tw)) / tw);
  return { ...base, x: a.x + dx * u, z: a.z + dz * u, facing, pose: "walk", moving: true };
}

/** Where a figure's (right) hand is, for held props. Scales with height like the mannequin. */
export function handPosition(a: ActorSample): Vec3 {
  const s = a.height / MANNEQUIN_BASE_HEIGHT;
  const f = facingDir(a.facing);
  const right = { x: f.z, z: -f.x }; // right = (cos yaw, 0, −sin yaw)
  const reach = a.pose === "reach";
  const y = a.pose === "sit" ? 0.8 : reach ? 1.3 : 1.05;
  const fwd = reach ? 0.55 : 0.3;
  return v3(a.x + (f.x * fwd + right.x * 0.18) * s, y * s, a.z + (f.z * fwd + right.z * 0.18) * s);
}

export function sampleProp(prop: PropPlacement, actors: ActorSample[], t: number): PropSample {
  const holds = [...(prop.holds ?? [])].sort((a, b) => a.t - b.t);
  let holder: string | null = null;
  for (const h of holds) if (h.t <= t + 1e-9) holder = h.actorId;
  const actor = holder ? actors.find((a) => a.id === holder) : undefined;
  const base = { id: prop.id, name: prop.name, size: prop.size };
  if (actor && prop.size === "large") {
    // Too big for a hand: it stands on the floor beside them and travels with them
    // (wheeling a bike, pushing a pram), its length along their facing.
    const s = actor.height / MANNEQUIN_BASE_HEIGHT;
    const f = facingDir(actor.facing);
    const right = { x: f.z, z: -f.x };
    return { ...base, x: actor.x + right.x * 0.55 * s, y: 0, z: actor.z + right.z * 0.55 * s, heldBy: actor.id, rot: actor.facing - 90 };
  }
  if (actor) {
    const p = handPosition(actor);
    return { ...base, x: p.x, y: p.y - (prop.size === "medium" ? PROP_DIMS.medium.height / 2 : 0), z: p.z, heldBy: actor.id, rot: actor.facing };
  }
  return { ...base, x: prop.x, y: prop.size === "large" ? 0 : prop.y, z: prop.z, heldBy: null, rot: prop.rot ?? 0 };
}

export function sampleSceneAt(scene: Scene, t: number): SceneSample {
  const time = Math.max(0, Math.min(scene.duration, t));
  const actors = scene.actors.map((a, i) => sampleActor(a, i, time));
  return {
    t: time,
    camera: sampleCamera(scene, time),
    actors,
    props: scene.props.map((p) => sampleProp(p, actors, time)),
  };
}

/** Full paths for the overhead plan, from the same sampler (24 steps per shot). */
export function scenePaths(scene: Scene, steps = 24): ScenePaths {
  const times = Array.from({ length: steps + 1 }, (_, i) => (scene.duration * i) / steps);
  return {
    camera: times.map((t) => sampleCamera(scene, t).pos),
    actors: scene.actors.map((actor, i) => {
      const pts = times.map((t) => {
        const s = sampleActor(actor, i, t);
        return { x: s.x, z: s.z };
      });
      return { id: actor.id, name: actor.name, color: ACTOR_COLORS[i % ACTOR_COLORS.length], points: pts };
    }),
  };
}
