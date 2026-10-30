import type { Actor, CameraMove, Feature, Mark, Pose, PropPlacement, Scene, SetLayout } from "./types";
import { BLOCKING_LIMITS } from "./types";
import type { FramingName } from "./framing";
import { faceHeight, solveFraming } from "./framing";
import { DEFAULT_AMOUNTS, clampAmount, fitMove, moveKeys } from "./presets";
import { sampleActor, sampleProp } from "./sample";
import { featureNormal, insideFeature, isSeat, isWallFeature, setBounds, surfaceHeight } from "./sets";
import { ensureInFrame } from "./visibility";
import { WORLD_UP, angleDelta, clamp, cross, dot, facingDir, hashString, headingDeg, normalize, sub, v3 } from "./vec";

/**
 * First-pass blocking for a shot, from its framing, move, lens and plain-language action.
 * Deterministic: the same shot always blocks the same way, so a re-plan never shuffles
 * a scene the user has already looked at. Astra refines it with commands afterwards.
 */

export type AutoBlockInput = {
  shotId: string;
  duration: number;
  aspect: "16:9" | "9:16";
  framing: FramingName;
  move: CameraMove;
  lens: number;
  action: string;
  description: string;
  set: SetLayout;
  characters: { id: string; name: string; height?: number }[];
  props: { id: string; name: string; size?: "small" | "medium" | "large" }[];
  speakerId?: string | null;
};

const WALK_SPEED = 1.15; // m/s, an unhurried walk

const has = (text: string, re: RegExp) => re.test(text);

type Spot = { x: number; z: number; facing: number; pose: Pose; seat?: Feature };

/** Nearest point on a feature's footprint edge to `from`, pushed `gap` metres outwards. */
export function approachPoint(feature: Feature, from: { x: number; z: number }, gap: number): { x: number; z: number; facing: number } {
  const r = ((feature.rot ?? 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = from.x - feature.x;
  const dz = from.z - feature.z;
  // Into the feature's local frame (inverse of the Y rotation).
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const hw = feature.w / 2;
  const hd = feature.d / 2;
  // Push out through the side the point is nearest to.
  const px = clamp(lx, -hw, hw);
  const pz = clamp(lz, -hd, hd);
  const outX = Math.abs(lx) / hw >= Math.abs(lz) / hd;
  const ox = outX ? Math.sign(lx || 1) * (hw + gap) : px;
  const oz = outX ? pz : Math.sign(lz || 1) * (hd + gap);
  // Back to world.
  const x = feature.x + ox * c + oz * s;
  const z = feature.z - ox * s + oz * c;
  return { x, z, facing: headingDeg(feature.x - x, feature.z - z) };
}

function inBounds(set: SetLayout, x: number, z: number): { x: number; z: number } {
  const b = setBounds(set);
  const m = BLOCKING_LIMITS.actorMargin + 0.1;
  return { x: clamp(x, b.minX + m, b.maxX - m), z: clamp(z, b.minZ + m, b.maxZ - m) };
}

/** Nudge a standing spot out of furniture it would otherwise stand inside. */
function clearOfFurniture(set: SetLayout, p: { x: number; z: number }, ignore?: Feature): { x: number; z: number } {
  let { x, z } = p;
  for (let pass = 0; pass < 3; pass++) {
    const hit = set.features.find((f) => f !== ignore && !isWallFeature(f) && f.h > 0.1 && insideFeature(f, x, z, 0.2));
    if (!hit) break;
    const out = approachPoint(hit, { x, z }, 0.3);
    ({ x, z } = inBounds(set, out.x, out.z));
  }
  return { x, z };
}

function seats(set: SetLayout): Feature[] {
  return set.features.filter(isSeat);
}

function nearest<T extends { x: number; z: number }>(items: T[], p: { x: number; z: number }): T | undefined {
  return [...items].sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
}

function firstOf(set: SetLayout, kinds: string[]): Feature | undefined {
  return set.features.find((f) => kinds.includes(f.kind));
}

/** Where the lead stands or sits, from what the action asks for. */
function leadSpot(set: SetLayout, text: string, seed: string): Spot {
  const window = firstOf(set, ["window"]);
  const counter = firstOf(set, ["counter"]);
  const table = /\bdesk\b/.test(text) ? firstOf(set, ["desk", "table"]) : firstOf(set, ["table", "desk"]);
  const mild = hashString(seed) % 2 === 0 ? 25 : -25;
  const wantsSit = has(text, /\b(sit|sits|sitting|seated|settles|sat|perch|perched|lounges?)\b/);
  const wantsWindow = has(text, /window/);
  const wantsCounter = has(text, /counter|\bbar\b|register|\btill\b|checkout/);
  const wantsTable = has(text, /table|desk/);
  const looks = has(text, /\b(looks?|gazes?|stares?|watch(es)?|glances?)\b/);

  if (wantsSit) {
    const all = seats(set);
    if (all.length) {
      const goal = wantsWindow && window ? window : wantsCounter && counter ? counter : wantsTable && table ? table : null;
      const scored = all
        .map((seat) => {
          // Prefer seats facing the open side, so the camera sees a face, then the goal.
          const facesCamera = facingDir(seat.rot ?? 0).z;
          const d = goal ? Math.hypot(seat.x - goal.x, seat.z - goal.z) : Math.hypot(seat.x, seat.z) * 0.3;
          return { seat, score: d - facesCamera * 1.5 };
        })
        .sort((a, b) => a.score - b.score);
      const seat = scored[0].seat;
      const facing = seat.kind === "bed" ? 0 : seat.rot ?? 0;
      return { x: seat.x, z: seat.z, facing, pose: "sit", seat };
    }
  }
  if (wantsCounter && counter) {
    const p = approachPoint(counter, { x: 0, z: 0 }, 0.45);
    return { ...inBounds(set, p.x, p.z), facing: p.facing + mild, pose: "stand" };
  }
  if (wantsWindow && window) {
    const n = featureNormal(set, window);
    // Along the glass: the centre first, then either side, until nothing is in the way.
    const along = { x: n.z, z: -n.x };
    const offsets = [0, 0.6, -0.6, 1.0, -1.0, window.w / 2, -window.w / 2];
    const clear = offsets
      .map((o) => inBounds(set, window.x + n.x * 0.85 + along.x * o, window.z + n.z * 0.85 + along.z * o))
      .find((c) => !set.features.some((f) => !isWallFeature(f) && f.h > 0.1 && insideFeature(f, c.x, c.z, 0.35)));
    const p = clear ?? inBounds(set, window.x + n.x * 0.85, window.z + n.z * 0.85);
    const towardWindow = headingDeg(-n.x, -n.z);
    // Looking out: mostly toward the glass, turned enough for the camera to read a profile.
    const facing = looks ? towardWindow + (angleDelta(towardWindow, 0) > 0 ? 55 : -55) : headingDeg(n.x, n.z) + mild;
    return { ...clearOfFurniture(set, p), facing, pose: "stand" };
  }
  if (wantsTable && table) {
    // Behind the table, facing out across it toward the open side.
    const p = approachPoint(table, { x: table.x, z: table.z - 3 }, 0.4);
    return { ...inBounds(set, p.x, p.z), facing: p.facing, pose: "stand" };
  }
  const b = setBounds(set);
  const p = clearOfFurniture(set, inBounds(set, 0, b.minZ * 0.2));
  return { ...p, facing: mild, pose: "stand" };
}

/** Where an entering figure starts: a door if there is one, otherwise the side of the set. */
function entranceFor(set: SetLayout, spot: Spot, framing: FramingName): { x: number; z: number } {
  const door = firstOf(set, ["door"]);
  if (framing === "wide" && door) {
    const n = featureNormal(set, door);
    const at = inBounds(set, door.x + n.x * 0.5, door.z + n.z * 0.5);
    // The figure must be in frame from the first frame, so a far door becomes a direction:
    // they start on the door's line, at most 3.5 m from where they arrive.
    const dx = at.x - spot.x;
    const dz = at.z - spot.z;
    const l = Math.hypot(dx, dz);
    if (l <= 3.5) return at;
    return clearOfFurniture(set, inBounds(set, spot.x + (dx / l) * 3.5, spot.z + (dz / l) * 3.5));
  }
  // Closer framings: arrive from 1.8 m off to the side so the walk stays in frame.
  const b = setBounds(set);
  const fromLeft = spot.x > (b.minX + b.maxX) / 2;
  return clearOfFurniture(set, inBounds(set, spot.x + (fromLeft ? -1.8 : 1.8), spot.z + 0.4));
}

type Segment = { a: { x: number; z: number }; b: { x: number; z: number } };

function distToSegment(p: { x: number; z: number }, seg: Segment): number {
  const dx = seg.b.x - seg.a.x;
  const dz = seg.b.z - seg.a.z;
  const l2 = dx * dx + dz * dz;
  const u = l2 > 1e-9 ? clamp(((p.x - seg.a.x) * dx + (p.z - seg.a.z) * dz) / l2, 0, 1) : 0;
  return Math.hypot(p.x - (seg.a.x + dx * u), p.z - (seg.a.z + dz * u));
}

/**
 * A partner for the lead: a second seat at the same table when the lead sits; otherwise a
 * spot 1.2 m away that reads side by side from the open (+z) side, clear of furniture,
 * of anyone already placed and of the lead's walk.
 */
function partnerSpot(set: SetLayout, lead: Spot, index: number, avoid: Segment | null, taken: { x: number; z: number }[]): Spot {
  if (lead.pose === "sit" && lead.seat) {
    const table = nearest(set.features.filter((f) => f.kind === "table" || f.kind === "desk"), lead);
    const others = seats(set).filter((s) => s !== lead.seat && table && Math.hypot(s.x - table.x, s.z - table.z) < 1.4);
    const other = others[index - 1];
    if (other) return { x: other.x, z: other.z, facing: other.rot ?? 0, pose: "sit", seat: other };
  }
  const b = setBounds(set);
  const scored = Array.from({ length: 12 }, (_, k) => {
    const dir = facingDir(k * 30);
    const c = { x: lead.x + dir.x * 1.2, z: lead.z + dir.z * 1.2 };
    const ok =
      c.x > b.minX + 0.4 &&
      c.x < b.maxX - 0.4 &&
      c.z > b.minZ + 0.4 &&
      c.z < b.maxZ - 0.4 &&
      !set.features.some((f) => !isWallFeature(f) && f.h > 0.1 && insideFeature(f, c.x, c.z, 0.25)) &&
      taken.every((t) => Math.hypot(t.x - c.x, t.z - c.z) > 0.8) &&
      (!avoid || distToSegment(c, avoid) > 0.8);
    // Side by side across the frame reads best from the camera side; slightly in front of the lead's gaze.
    const gaze = Math.abs(angleDelta(lead.facing, k * 30)) / 180;
    return { c, ok, score: Math.abs(c.z - lead.z) * 1.2 + gaze * 0.8 + (c.z < lead.z ? 0.3 : 0) };
  })
    .filter((x) => x.ok)
    .sort((x, y) => x.score - y.score);
  const p = scored[0]?.c ?? clearOfFurniture(set, inBounds(set, lead.x + 1.2, lead.z + 0.3));
  return { ...p, facing: headingDeg(lead.x - p.x, lead.z - p.z), pose: "stand" };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mark(t: number, x: number, z: number, facing: number, pose: Pose): Mark {
  return { t: round2(t), x: round2(x), z: round2(z), facing: Math.round(facing), pose };
}

export function autoBlock(input: AutoBlockInput): Scene {
  const text = `${input.action} ${input.description}`.toLowerCase();
  const set = input.set;
  const duration = clamp(input.duration, 1, 15);
  const enters =
    has(text, /\b(enter|enters|entering|arriv\w*|comes in|steps in|walks?( in| into| over| to| toward| towards| across| through| up)?|crosses|approach\w*)\b/) ||
    // Wheeling a bike in, pushing a pram up to the counter: an entrance with a large prop.
    has(text, /\b(wheels?|wheeling|pushes|pushing|rides?|riding)\b[^.]*\b(in|into|up|over|toward|towards|through)\b/);
  const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const holds =
    has(text, /\b(hold|holds|holding|carr(y|ies|ying)|sips?|sipping|drinks?|drinking|cradles?|raises?|lifts?)\b/) ||
    // "Mara sits by the window with a cup": "with" + a prop of this shot reads as holding it.
    input.props.some((p) => p.name && new RegExp(`\\bwith (a|an|the|her|his|their) ${escape(p.name.toLowerCase())}`).test(text));
  const reaches = has(text, /\b(reach\w*|pours?|pouring|grabs?|picks? up|places?|sets? down|puts? down|hands? over|serves?)\b/);

  /* ---- actors ---- */
  const lead = leadSpot(set, text, input.shotId);
  const spots: Spot[] = [];
  const cast = input.characters.slice(0, 3);
  const entrance = enters && cast.length ? entranceFor(set, lead, input.framing) : null;
  const walk: Segment | null = entrance ? { a: entrance, b: lead } : null;
  cast.forEach((_, i) => spots.push(i === 0 ? lead : partnerSpot(set, lead, i, walk, spots)));
  // Partners face the lead once both are placed.
  spots.forEach((s, i) => {
    if (i > 0 && s.pose === "stand") s.facing = headingDeg(spots[0].x - s.x, spots[0].z - s.z);
  });

  const actors: Actor[] = cast.map((c, i) => {
    const s = spots[i];
    const marks: Mark[] = [];
    if (i === 0 && entrance) {
      const from = entrance;
      const travel = Math.hypot(s.x - from.x, s.z - from.z);
      const arrive = clamp(travel / WALK_SPEED, 1.2, duration * 0.65);
      const heading = headingDeg(s.x - from.x, s.z - from.z);
      marks.push(mark(0, from.x, from.z, heading, "stand"));
      if (s.pose === "sit") {
        marks.push(mark(arrive, s.x, s.z, s.facing, "stand"));
        marks.push(mark(Math.min(duration, arrive + 0.7), s.x, s.z, s.facing, "sit"));
      } else {
        marks.push(mark(arrive, s.x, s.z, s.facing, "stand"));
      }
    } else {
      marks.push(mark(0, s.x, s.z, s.facing, s.pose));
      if (i === 0 && reaches && input.props.length && duration >= 3) {
        marks.push(mark(duration * 0.35, s.x, s.z, s.facing, "reach"));
        marks.push(mark(duration * 0.6, s.x, s.z, s.facing, s.pose));
      } else if (i === 0 && has(text, /\b(turns?|looks? (up|back|around|over))\b/) && duration >= 3) {
        marks.push(mark(duration * 0.55, s.x, s.z, s.facing + 35, s.pose === "walk" ? "stand" : s.pose));
      }
    }
    return { id: c.id, name: c.name, height: c.height ?? 1.72, marks };
  });

  /* ---- props ---- */
  const leadActor = actors[0];
  const leadAt = leadActor ? sampleActor(leadActor, 0, 0) : null;
  const usedSurface = new Map<string, number>();
  const surfaces = set.features.filter((f) => surfaceHeight(f) !== null && f.kind !== "chair" && f.kind !== "sofa" && f.kind !== "bed" && !(f.kind === "block" && (f.surface ?? 1) < 0.1));
  const props: PropPlacement[] = input.props.slice(0, 6).map((p, i) => {
    const size = p.size ?? "small";
    const anchor = leadAt ?? { x: 0, z: 0 };
    if (size === "large") {
      // Bikes, benches, prams: on the floor beside the lead, length along their facing.
      // When the lead walks, they walk beside it (sampleProp keeps it at their side).
      const f = facingDir(leadAt?.facing ?? 0);
      const side = { x: f.z, z: -f.x };
      const spot = clearOfFurniture(set, inBounds(set, anchor.x + side.x * 0.75, anchor.z + side.z * 0.75));
      const walksWithIt = !!leadActor && i === 0 && (enters || holds || has(text, /\b(wheels?|push(es)?|rides?|walks? (with|beside))\b/));
      return {
        id: p.id,
        name: p.name,
        x: round2(spot.x),
        y: 0,
        z: round2(spot.z),
        size,
        rot: Math.round((leadAt?.facing ?? 0) - 90),
        holds: walksWithIt ? [{ t: 0, actorId: leadActor!.id }] : [],
      };
    }
    const surface = nearest(surfaces, anchor);
    let x = anchor.x;
    let z = anchor.z + 0.6;
    let y = 0;
    if (surface && Math.hypot(surface.x - anchor.x, surface.z - anchor.z) < 3.5) {
      const n = usedSurface.get(surface.id) ?? 0;
      usedSurface.set(surface.id, n + 1);
      // Toward the lead from the surface centre, spread a little per prop.
      const toward = normalize(sub(v3(anchor.x, 0, anchor.z), v3(surface.x, 0, surface.z)));
      const reach = Math.min(surface.w, surface.d) * 0.25;
      x = surface.x + toward.x * reach + (n % 2 === 0 ? 1 : -1) * n * 0.18;
      z = surface.z + toward.z * reach;
      y = surfaceHeight(surface) ?? 0;
    } else {
      ({ x, z } = inBounds(set, x, z));
    }
    const holdsList: PropPlacement["holds"] = [];
    if (leadActor && i === 0 && holds) holdsList.push({ t: 0, actorId: input.speakerId && cast.some((c) => c.id === input.speakerId) ? input.speakerId : leadActor.id });
    else if (leadActor && i === 0 && reaches && duration >= 3) holdsList.push({ t: round2(duration * 0.45), actorId: leadActor.id });
    return { id: p.id, name: p.name, x: round2(x), y: round2(y), z: round2(z), size, holds: holdsList };
  });

  // A detail or hero with no prop is about what their hands are doing: a standing subject
  // reaches forward so the grey frame shows hands at work, not arms at their sides.
  if ((input.framing === "detail" || input.framing === "hero") && !input.props.length) {
    const subject = actors.find((a) => a.id === input.speakerId) ?? actors[0];
    if (subject) subject.marks = subject.marks.map((m) => (m.pose === "stand" ? { ...m, pose: "reach" as const } : m));
  }

  /* ---- camera ---- */
  // Frame where the action lands, unless the camera itself follows (pan, track).
  const frameAt = input.move === "pan" || input.move === "track" ? 0 : duration;
  const actorsAt = actors.map((a, i) => sampleActor(a, i, frameAt));
  const propsAt = props.map((p) => sampleProp(p, actorsAt, frameAt));
  const subjectId =
    input.framing === "detail" || input.framing === "hero"
      ? props[0]?.id ?? input.speakerId ?? actors[0]?.id ?? null
      : input.framing === "wide" && actors.length > 1
        ? null
        : input.speakerId && actors.some((a) => a.id === input.speakerId)
          ? input.speakerId
          : actors[0]?.id ?? props[0]?.id ?? null;
  const framed = solveFraming({ set, aspect: input.aspect, lens: input.lens, framing: input.framing, actors: actorsAt, props: propsAt, subjectId, seed: input.shotId });

  let direction: "left" | "right" = hashString(`${input.shotId}:dir`) % 2 === 0 ? "left" : "right";
  if (has(text, /\bleft\b/)) direction = "left";
  else if (has(text, /\bright\b/)) direction = "right";
  // Follow a walking lead across frame.
  if ((input.move === "pan" || input.move === "track") && leadActor && leadActor.marks.length > 1) {
    const a = leadActor.marks[0];
    const b = leadActor.marks[leadActor.marks.length - 1];
    const fwd = normalize(sub(framed.key.target, framed.key.pos));
    const right = normalize(cross(fwd, WORLD_UP));
    direction = dot(v3(b.x - a.x, 0, b.z - a.z), right) >= 0 ? "right" : "left";
  }
  const requested = clampAmount(input.move, DEFAULT_AMOUNTS[input.move]).amount;
  const fitted = fitMove(set, framed.key, input.move, requested, direction);
  const move: CameraMove = fitted.amount > 0 ? input.move : "static";
  const subjectActor = actorsAt.find((a) => a.id === framed.subjectId);
  // Camera keys keep full precision: they were validated against the set as computed, and
  // rounding can nudge a key across a clearance margin.
  const keys = moveKeys(framed.key, move, fitted.amount, direction, duration, { faceY: subjectActor && framed.focus !== "hands" ? faceHeight(subjectActor) : null });

  const scene: Scene = {
    shotId: input.shotId,
    duration,
    aspect: input.aspect,
    set,
    actors,
    props,
    camera: {
      move,
      amount: Math.round(fitted.amount * 1000) / 1000,
      direction,
      ease: "gentle",
      subjectId: framed.subjectId,
      focus: framed.focus ?? "figure",
      keys,
    },
  };
  // The first frame is the first frame of the generated video: everyone on screen (and a
  // detail's prop) must be in it, and a static camera must hold a walk from start to end.
  return ensureInFrame(scene).scene;
}
