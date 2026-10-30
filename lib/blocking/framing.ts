import type { CameraKey, SetLayout, Vec3 } from "./types";
import type { ActorSample, PropSample } from "./sample";
import { MANNEQUIN_BASE_HEIGHT, PROP_DIMS } from "./sample";
import { aspectNumber, horizontalFovDeg, lensMmToFovDeg } from "./lens";
import { cameraBoundsIssue } from "./presets";
import { lensObstruction, setBounds, sightBlocked, surfaceHeight, surfaceInFront } from "./sets";
import { eyePoint, project } from "./project";
import { clamp, facingDir, hashString, headingDeg, rad, v3 } from "./vec";

/**
 * Deterministic framing: the framing size sets the
 * framed feature height and the fraction of the frame it fills, the lens gives the field
 * of view, and the distance follows (featureH = frac · 2 · d · tan(fov/2)). The treatment
 * sets elevation and the swing off the subject's facing. The lens is the shot's, not a
 * default for the size, so a 35 mm close-up is a close-up on 35 mm.
 */

export type FramingName = "wide" | "medium" | "close" | "detail" | "hero" | "ots" | "pov";
export type Side = "front" | "left" | "right" | "behind_left" | "behind_right";
export type HeightName = "eye" | "low" | "high" | "overhead";

// Anchor heights for a standing 1.82 m mannequin (origin at the feet).
const EYE_Y = 1.62;
const HEAD_Y = 1.72;
const CHEST_Y = 1.3;
const BODY_CENTER_Y = 0.95;
const BODY_HEIGHT = 1.85;
const SEATED_DROP = 0.3; // the sitting pose lowers the head 0.3 m (1.7 → 1.4)

type Spec = { targetY: number; featureH: number; frac: number };

const PERSON_SPEC: Record<"wide" | "medium" | "close", Spec> = {
  // Commercial "wide" is a full figure filling ~45% of frame height.
  wide: { targetY: BODY_CENTER_Y, featureH: BODY_HEIGHT, frac: 0.45 },
  medium: { targetY: CHEST_Y + 0.08, featureH: 1.05, frac: 0.75 },
  close: { targetY: HEAD_Y - 0.08, featureH: 0.42, frac: 0.72 },
};

const ELEVATION: Record<HeightName, number> = { eye: 3, low: -22, high: 26, overhead: 80 };
const SWING: Record<Exclude<Side, "front">, number> = { right: 55, left: -55, behind_right: 140, behind_left: -140 };


export type FramingRequest = {
  set: SetLayout;
  aspect: "16:9" | "9:16";
  lens: number;
  framing: FramingName;
  actors: ActorSample[];
  props: PropSample[];
  /** Actor or prop id; null frames the group (or the room). */
  subjectId: string | null;
  side?: Side;
  height?: HeightName;
  /** Seeds the left/right choice of the mild ¾ swing so shots vary but never flicker. */
  seed: string;
};

export type FramingResult = { key: CameraKey; subjectId: string | null; notes: string[]; focus?: "figure" | "hands" | "prop" };

function fovRad(lens: number, aspect: "16:9" | "9:16"): { v: number; h: number } {
  const a = aspectNumber(aspect);
  const v = lensMmToFovDeg(lens, a);
  return { v: rad(v), h: rad(horizontalFovDeg(v, a)) };
}

function scaleOf(a: ActorSample): number {
  return a.height / MANNEQUIN_BASE_HEIGHT;
}

/**
 * Where a figure's hands work: in front of the body, hip-to-chest standing (higher and
 * further out when reaching), lap height seated — or just above the table top when they
 * sit at one, where the camera view rests their forearms.
 */
export function handsPoint(a: ActorSample, set?: SetLayout): Vec3 {
  const s = scaleOf(a);
  const f = facingDir(a.facing);
  if (a.pose === "sit" && set) {
    const table = surfaceInFront(set, a.x, a.z, a.facing);
    if (table) return v3(a.x + f.x * 0.42 * s, (surfaceHeight(table) ?? 0.75) + 0.06, a.z + f.z * 0.42 * s);
  }
  const y = a.pose === "sit" ? 0.74 : a.pose === "reach" ? 1.22 : 1.08;
  const fwd = a.pose === "reach" ? 0.45 : 0.28;
  return v3(a.x + f.x * fwd * s, y * s, a.z + f.z * fwd * s);
}

/** A figure's eye height, standing or seated (used to settle a push on the face). */
export function faceHeight(a: ActorSample): number {
  return anchorY(a, EYE_Y);
}

function anchorY(a: ActorSample, y: number): number {
  const s = scaleOf(a);
  return (y - (a.pose === "sit" ? SEATED_DROP : 0)) * s;
}

/**
 * Place the camera on a sphere about the target, searching swings and distances until it
 * stands inside the set with a clear line to the subject. If nothing is clear, the first
 * pose inside the set wins and says so.
 */
function placeOnSphere(
  set: SetLayout,
  target: Vec3,
  baseAzimuth: number,
  elevDeg: number,
  distance: number,
  /** Points that must also be in clear view (each figure's head in a group wide). */
  mustSee: Vec3[] = [],
): { pos: Vec3; fitted: boolean; distanceUsed: number; blocked: string | null } {
  const swings = [0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90];
  const mults = [1, 0.85, 0.7, 0.55];
  const at = (az: number, d: number): Vec3 => {
    const e = rad(elevDeg);
    const h = facingDir(az);
    return v3(target.x + d * Math.cos(e) * h.x, clamp(target.y + d * Math.sin(e), 0.3, 3.1), target.z + d * Math.cos(e) * h.z);
  };
  let firstInside: { pos: Vec3; d: number; blocker: string } | null = null;
  for (const m of mults) {
    for (const s of swings) {
      const pos = at(baseAzimuth + s, distance * m);
      if (cameraBoundsIssue(set, pos)) continue;
      const blocker = sightBlocked(set, pos, target) ?? mustSee.map((p) => sightBlocked(set, pos, p)).find(Boolean) ?? lensObstruction(set, pos, target) ?? null;
      if (!blocker) return { pos, fitted: m === 1 && s === 0, distanceUsed: distance * m, blocked: null };
      if (!firstInside) firstInside = { pos, d: distance * m, blocker: blocker.label.toLowerCase() };
    }
  }
  if (firstInside) return { pos: firstInside.pos, fitted: false, distanceUsed: firstInside.d, blocked: firstInside.blocker };
  // Last resort: straight on from the open side, as far back as the set allows.
  const b = setBounds(set);
  const pos = v3(clamp(target.x, b.minX + 0.3, b.maxX - 0.3), clamp(target.y + 0.1, 0.3, 3.0), Math.min(target.z + distance, b.maxZ + 3.0));
  return { pos, fitted: false, distanceUsed: Math.abs(pos.z - target.z), blocked: null };
}

/**
 * Camera for a prop: try azimuths around it and keep the one where no head sits in frame
 * near the prop (a face filling a product shot) and nothing crowds the lens. The prop
 * stays the aim, so it stays centred.
 */
function placeForProp(req: FramingRequest, target: Vec3, baseAz: number, elevDeg: number, distance: number, ownHeadOf?: string): { pos: Vec3; note: string | null } {
  const offsets = [0, 25, -25, 50, -50, 80, -80, 115, -115, 150, -150, 180];
  const { v, h } = fovRad(req.lens, req.aspect);
  const frameOf = (pos: Vec3) => ({ pos, target, fovV: (v * 180) / Math.PI, fovH: (h * 180) / Math.PI });
  let best: { pos: Vec3; score: number; blocked: boolean; heads: boolean } | null = null;
  for (const m of [1, 0.85, 0.7]) {
    for (const o of offsets) {
      const e = rad(elevDeg);
      const dir = facingDir(baseAz + o);
      const dd = distance * m;
      const pos = v3(target.x + dd * Math.cos(e) * dir.x, clamp(target.y + dd * Math.sin(e), 0.3, 3.1), target.z + dd * Math.cos(e) * dir.z);
      if (cameraBoundsIssue(req.set, pos)) continue;
      const blocked = !!(sightBlocked(req.set, pos, target) || lensObstruction(req.set, pos, target, 0.9));
      const frame = frameOf(pos);
      let headPenalty = 0;
      for (const a of req.actors) {
        const q = project(frame, eyePoint(a));
        if (!q || Math.abs(q.x) > 1.05 || Math.abs(q.y) > 1.05) continue;
        // A head between the lens and the subject, or right behind it, takes over the frame;
        // for a hands detail the subject's own face must stay out entirely.
        headPenalty += a.id === ownHeadOf ? 30 : q.depth < dd + 0.9 ? 10 : 2;
      }
      const score = (blocked ? 50 : 0) + headPenalty + Math.abs(o) / 90 + (1 - m) * 2;
      if (!best || score < best.score) best = { pos, score, blocked, heads: headPenalty >= 10 };
    }
  }
  if (!best) {
    const b = setBounds(req.set);
    return { pos: v3(clamp(target.x, b.minX + 0.3, b.maxX - 0.3), clamp(target.y + 0.3, 0.3, 3.0), Math.min(target.z + distance, b.maxZ + 3)), note: "Camera placed straight on; the set left no better angle on the {prop}" };
  }
  return { pos: best.pos, note: best.blocked ? "Furniture partly blocks the view of the {prop}" : best.heads ? "A face stays close to the {prop} from every angle; consider moving the cast back" : null };
}

/** Facing of the subject used for the base azimuth; a figure turned away is framed from the open side. */
function baseAzimuth(facing: number, side: Side | undefined, seed: string): number {
  const mild = hashString(seed) % 2 === 0 ? 20 : -20;
  const swing = side && side !== "front" ? SWING[side] : mild;
  let az = facing + swing;
  // Keep the camera on the open (+z) half when the subject faces the back wall: the
  // fourth wall is where the camera lives in a blocking set.
  const dir = facingDir(az);
  if (dir.z < 0.2 && !(side && side.startsWith("behind"))) az = mild;
  return az;
}

export function solveFraming(req: FramingRequest): FramingResult {
  const notes: string[] = [];
  const { v: fovV, h: fovH } = fovRad(req.lens, req.aspect);
  const tanV = Math.tan(fovV / 2);
  const tanH = Math.tan(fovH / 2);
  const actor = req.actors.find((a) => a.id === req.subjectId) ?? null;
  const prop = req.props.find((p) => p.id === req.subjectId) ?? null;
  const elev = ELEVATION[req.height ?? "eye"];

  // Detail / hero: the prop centred, and no head crowding the frame.
  if (req.framing === "detail" || req.framing === "hero") {
    const p = prop ?? req.props[0] ?? null;
    if (p) {
      const dims = PROP_DIMS[p.size];
      const detail = req.framing === "detail";
      // Height fills the frame vertically; a long prop's length must also fit across it.
      const vMult = p.size === "large" ? 1.5 : detail ? 1.7 : 2.8;
      const hMult = p.size === "large" ? 1.35 : detail ? 1.7 : 2.8;
      const d = Math.max(0.3, (dims.height * vMult) / (2 * 0.8 * tanV), (dims.length * hMult) / (2 * 0.8 * tanH));
      const target = v3(p.x, p.y + dims.height * (p.size === "large" ? 0.5 : 0.4), p.z);
      const holder = req.actors.find((a) => a.id === p.heldBy);
      // A large prop is seen from its side (perpendicular to its length); a held one from the holder's front.
      const facing = p.size === "large" ? p.rot : holder ? holder.facing : 0;
      const elevation = req.height ? elev : detail ? 32 : 9;
      const chosen = placeForProp(req, target, baseAzimuth(facing, req.side, req.seed), elevation, d);
      if (chosen.note) notes.push(chosen.note.replace("{prop}", p.name));
      return { key: { t: 0, pos: chosen.pos, target, lens: req.lens }, subjectId: p.id, notes, focus: "prop" };
    }
    // No prop: the action is in their hands. Frame the hands and lap, never the face.
    const a = actor ?? req.actors[0];
    if (a) {
      const detail = req.framing === "detail";
      const target = handsPoint(a, req.set);
      // Enough frame for both forearms and what they hold (narrow 9:16 frames need it most).
      const span = detail ? 0.62 : 0.9;
      const d = Math.max(0.45, span / (2 * 0.8 * tanV), (span * 0.75) / (2 * 0.8 * tanH));
      const elevation = req.height ? elev : detail ? 35 : 12;
      const chosen = placeForProp(req, target, baseAzimuth(a.facing, req.side, req.seed), elevation, d, a.id);
      if (chosen.note) notes.push(chosen.note.replace("{prop}", `${a.name}'s hands`));
      return { key: { t: 0, pos: chosen.pos, target, lens: req.lens }, subjectId: a.id, notes, focus: "hands" };
    }
  }

  // Point of view: from the subject's eyes, where they face.
  if (req.framing === "pov") {
    const a = actor ?? req.actors[0];
    if (a) {
      const others = req.actors.filter((o) => o.id !== a.id);
      const eye = anchorY(a, EYE_Y);
      // Through their eyes: at the other figures if there are any, otherwise where they face.
      const look = others.length
        ? { x: others.reduce((n, o) => n + o.x, 0) / others.length, z: others.reduce((n, o) => n + o.z, 0) / others.length }
        : { x: a.x + facingDir(a.facing).x * 3, z: a.z + facingDir(a.facing).z * 3 };
      const dx = look.x - a.x;
      const dz = look.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      const pos = v3(a.x + (dx / l) * 0.12, eye, a.z + (dz / l) * 0.12);
      const lookY = others.length ? others.reduce((n, o) => n + anchorY(o, CHEST_Y + 0.15), 0) / others.length : eye - 0.25;
      const target = v3(look.x, lookY, look.z);
      return { key: { t: 0, pos, target, lens: req.lens }, subjectId: a.id, notes };
    }
  }

  // Over the shoulder: past the foreground figure's shoulder onto the subject.
  if (req.framing === "ots" && req.actors.length >= 2) {
    const a = actor ?? req.actors[0];
    const fg = req.actors.find((x) => x.id !== a.id)!;
    const target = v3(a.x, anchorY(a, HEAD_Y - 0.08), a.z);
    const away = { x: fg.x - a.x, z: fg.z - a.z };
    const l = Math.hypot(away.x, away.z) || 1;
    const u = { x: away.x / l, z: away.z / l };
    const right = { x: u.z, z: -u.x };
    const side = hashString(req.seed) % 2 === 0 ? 1 : -1;
    const pos = v3(fg.x + u.x * 0.55 + right.x * 0.35 * side, anchorY(fg, EYE_Y) + 0.05, fg.z + u.z * 0.55 + right.z * 0.35 * side);
    if (!cameraBoundsIssue(req.set, pos)) return { key: { t: 0, pos, target, lens: req.lens }, subjectId: a.id, notes };
    notes.push("No room behind the shoulder, so the over-the-shoulder became a ¾ medium");
  }

  // People: one subject, or the group / the room for a wide.
  const sizeName: "wide" | "medium" | "close" = req.framing === "wide" ? "wide" : req.framing === "medium" || req.framing === "ots" || req.framing === "pov" ? "medium" : "close";
  const spec = PERSON_SPEC[sizeName];
  if (sizeName === "wide" && (!actor || req.actors.length > 1)) {
    const group = req.actors.length ? req.actors : null;
    if (group) {
      const xs = group.map((a) => a.x);
      const zs = group.map((a) => a.z);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + 1.4;
      const tallest = Math.max(...group.map((a) => a.height));
      const target = v3(cx, BODY_CENTER_Y * (tallest / MANNEQUIN_BASE_HEIGHT), cz);
      const dV = (spec.featureH * (tallest / MANNEQUIN_BASE_HEIGHT)) / (2 * spec.frac * tanV);
      const dH = span / (2 * 0.8 * tanH);
      // A wide looks into the room from the middle of its open side, with every figure in clear view.
      const b = setBounds(req.set);
      const fromRoom = headingDeg((b.minX + b.maxX) / 2 - cx, b.maxZ + 1 - cz);
      const heads = group.map((a) => v3(a.x, anchorY(a, EYE_Y), a.z));
      const az = req.side && req.side !== "front" ? baseAzimuth(0, req.side, req.seed) : fromRoom + (hashString(req.seed) % 2 === 0 ? 8 : -8);
      const placed = placeOnSphere(req.set, target, az, elev, Math.max(dV, dH), heads);
      if (placed.blocked) notes.push(`The ${placed.blocked} partly blocks the wide`);
      else if (placed.distanceUsed < Math.max(dV, dH) * 0.99) notes.push("The set is too small for the full wide, so the camera sits as far back as it can");
      return { key: { t: 0, pos: placed.pos, target, lens: req.lens }, subjectId: null, notes };
    }
    // Establishing the room itself.
    const b = setBounds(req.set);
    const target = v3(0, 1.1, req.set.exterior ? b.minZ * 0.45 : b.minZ * 0.35);
    const d = (req.set.width * 0.8) / (2 * tanH);
    const placed = placeOnSphere(req.set, target, baseAzimuth(0, req.side, req.seed) * 0.5, req.height ? elev : 8, d);
    return { key: { t: 0, pos: placed.pos, target, lens: req.lens }, subjectId: null, notes };
  }

  const a = actor ?? req.actors[0];
  if (!a) {
    // Nothing to frame but the set.
    const b = setBounds(req.set);
    const target = v3(0, 1.0, b.minZ * 0.3);
    const placed = placeOnSphere(req.set, target, 0, elev, (req.set.width * 0.6) / (2 * tanH));
    return { key: { t: 0, pos: placed.pos, target, lens: req.lens }, subjectId: null, notes };
  }
  const s = scaleOf(a);
  const target = v3(a.x, anchorY(a, spec.targetY), a.z);
  const d = (spec.featureH * s) / (2 * spec.frac * tanV);
  const placed = placeOnSphere(req.set, target, baseAzimuth(a.facing, req.side, req.seed), elev, d);
  if (placed.blocked) notes.push(`The ${placed.blocked} partly blocks the view of ${a.name}`);
  else if (placed.distanceUsed < d * 0.99) notes.push(`The room is tight, so ${a.name} is framed a little closer than a true ${sizeName}`);
  return { key: { t: 0, pos: placed.pos, target, lens: req.lens }, subjectId: a.id, notes };
}
