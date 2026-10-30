import type { Scene, Vec3 } from "./types";
import type { ActorSample } from "./sample";
import { sampleSceneAt } from "./sample";
import { LENS_PRESETS, fovs } from "./lens";
import { faceHeight, handsPoint } from "./framing";
import { cameraBoundsIssue, clampAmount, fitMove, moveKeys } from "./presets";
import { lensObstruction, sightBlocked } from "./sets";
import type { FrameSpec } from "./project";
import { actorInFrame, actorWellFramed, eyePoint, inFrame, propCenter } from "./project";
import { add, dist, mul, normalize, orbitAround, sub, v3 } from "./vec";

/**
 * Who is in frame, and when. The grey capture at t = 0 is the first frame of the generated
 * video, so every on-screen character (and a detail shot's prop) must be visible at t = 0.
 * A static camera must also hold them through the shot; a moving camera is only held to
 * its first frame (the move is what reveals or loses them).
 *
 * Required: every actor, except the one whose eyes the camera is (a POV) — and in a detail
 * or hero shot of a prop, only that prop.
 */

const WHEN = [
  { label: "the start", f: 0 },
  { label: "the middle", f: 0.5 },
  { label: "the end", f: 1 },
] as const;

function requiredAt(scene: Scene, t: number) {
  const s = sampleSceneAt(scene, t);
  const cam = s.camera;
  const propSubject = s.props.find((p) => p.id === scene.camera.subjectId) ?? null;
  // A detail of someone's hands needs the hands, not the face (or anyone else).
  const handsOf = scene.camera.focus === "hands" ? s.actors.find((a) => a.id === scene.camera.subjectId) ?? null : null;
  const pov = (a: ActorSample) => dist(eyePoint(a), cam.pos) < 0.35;
  const actors = propSubject || handsOf ? [] : s.actors.filter((a) => !pov(a));
  return { cam, actors, prop: propSubject, hands: handsOf };
}

function issuesAt(scene: Scene, when: (typeof WHEN)[number]): string[] {
  const t = scene.duration * when.f;
  const { cam, actors, prop, hands } = requiredAt(scene, t);
  const out: string[] = [];
  for (const a of actors) if (!actorInFrame(cam, a)) out.push(`${a.name} is out of frame at ${when.label} (${t.toFixed(1)} s)`);
  if (hands && !inFrame(cam, handsPoint(hands, scene.set), 0.95)) out.push(`${hands.name}'s hands are out of frame at ${when.label} (${t.toFixed(1)} s)`);
  if (prop && !inFrame(cam, propCenter(prop), 0.95)) out.push(`the ${prop.name} is out of frame at ${when.label} (${t.toFixed(1)} s)`);
  return out;
}

/** Out-of-frame problems at the start, middle and end of the shot. */
export function framingIssues(scene: Scene): string[] {
  return WHEN.flatMap((w) => issuesAt(scene, w));
}

/** Out-of-frame problems on the first frame — the ones that block a shot. */
export function startFramingIssues(scene: Scene): string[] {
  return issuesAt(scene, WHEN[0]);
}

/** The problems a camera is accountable for: all three moments when static, the start when moving. */
function accountable(scene: Scene): string[] {
  return scene.camera.move === "static" ? framingIssues(scene) : startFramingIssues(scene);
}

/**
 * Re-aim and ease the camera back (then widen the lens) until everyone required is in
 * frame: through the whole shot for a static camera, on the first frame for a moving one.
 * Keeps the camera's direction where it can, so the shot keeps its angle.
 */
export function ensureInFrame(scene: Scene): { scene: Scene; notes: string[]; ok: boolean } {
  if (!accountable(scene).length) return { scene, notes: [], ok: true };
  const s: Scene = JSON.parse(JSON.stringify(scene));
  const staticCam = s.camera.move === "static";
  const times = staticCam ? [0, 0.25, 0.5, 0.75, 1].map((f) => f * s.duration) : [0];

  // What must be seen, per moment: each required figure comfortably framed, and the prop.
  const checks: ((frame: FrameSpec) => boolean)[] = [];
  const all: Vec3[] = [];
  const names = new Set<string>();
  for (const t of times) {
    const { actors, prop, hands } = requiredAt(s, t);
    if (hands) {
      const h = handsPoint(hands, s.set);
      checks.push((frame) => inFrame(frame, h, 0.8));
      all.push(h);
      names.add(`${hands.name}'s hands`);
    }
    for (const a of actors) {
      checks.push((frame) => actorWellFramed(frame, a));
      all.push(eyePoint(a), v3(a.x, (a.pose === "sit" ? 0.7 : 1.0) * (a.height / 1.82), a.z));
      names.add(a.name);
    }
    if (prop) {
      const c = propCenter(prop);
      checks.push((frame) => inFrame(frame, c, 0.85));
      all.push(c);
      names.add(`the ${prop.name}`);
    }
  }
  if (!checks.length) return { scene, notes: [], ok: true };
  const xs = all.map((p) => p.x);
  const zs = all.map((p) => p.z);
  const ys = all.map((p) => p.y);
  const target = v3((Math.min(...xs) + Math.max(...xs)) / 2, Math.max(0.3, Math.min(1.5, (Math.min(...ys) + Math.max(...ys)) / 2)), (Math.min(...zs) + Math.max(...zs)) / 2);

  const k0 = s.camera.keys[0];
  const pov = sampleSceneAt(s, 0).actors.some((a) => dist(eyePoint(a), k0.pos) < 0.35);
  if (pov) {
    const { fovV, fovH } = fovs(k0.lens, s.aspect);
    const frame = { pos: k0.pos, target, fovV, fovH };
    if (!checks.every((c) => c(frame))) return { scene, notes: [], ok: false };
    s.camera.keys = moveKeys({ t: 0, pos: k0.pos, target, lens: k0.lens }, s.camera.move, s.camera.amount, s.camera.direction, s.duration);
    return accountable(s).length ? { scene, notes: [], ok: false } : { scene: s, notes: ["Point of view re-aimed so everyone it watches is in frame"], ok: true };
  }
  const away = normalize(sub(k0.pos, k0.target));
  const startDist = Math.max(0.6, dist(k0.pos, k0.target) * 0.85);
  const lenses = [k0.lens, ...LENS_PRESETS.filter((l) => l < k0.lens - 0.5).sort((a, b) => b - a)];

  for (const lens of lenses) {
    const { fovV, fovH } = fovs(lens, s.aspect);
    for (const swing of [0, 15, -15, 30, -30, 45, -45]) {
      const dir = swing ? normalize(sub(orbitAround(add(target, away), target, swing), target)) : away;
      for (let d = startDist; d < 16; d *= 1.1) {
        const pos = add(target, mul(dir, d));
        if (cameraBoundsIssue(s.set, pos)) break; // further back only leaves the set
        const frame = { pos, target, fovV, fovH };
        if (!checks.every((c) => c(frame))) continue;
        if (sightBlocked(s.set, pos, target) || lensObstruction(s.set, pos, target)) continue;
        s.camera.keys = [{ t: 0, pos, target, lens }];
        // Rebuild the move from the new start, fitted to the set.
        const requested = clampAmount(s.camera.move, s.camera.amount).amount;
        const fitted = fitMove(s.set, s.camera.keys[0], s.camera.move, requested, s.camera.direction);
        if (s.camera.move !== "static" && fitted.amount === 0) s.camera.move = "static";
        s.camera.amount = Math.round(fitted.amount * 1000) / 1000;
        const subject = sampleSceneAt(s, 0).actors.find((a) => a.id === s.camera.subjectId);
        s.camera.keys = moveKeys(s.camera.keys[0], s.camera.move, s.camera.amount, s.camera.direction, s.duration, { faceY: subject && s.camera.focus !== "hands" ? faceHeight(subject) : null });
        if (accountable(s).length) continue; // the rebuilt move lost someone; keep looking
        const who = [...names].join(" and ");
        const one = names.size === 1 && ![...names][0].endsWith("hands");
        const keep = staticCam ? `${one ? "stays" : "stay"} in frame throughout` : `${one ? "is" : "are"} in frame from the first frame`;
        const notes = [lens < k0.lens - 0.5 ? `Lens widened to ${lens}mm so ${who} ${keep}` : `Camera re-aimed and eased back so ${who} ${keep}`];
        return { scene: s, notes, ok: true };
      }
    }
  }
  return { scene, notes: [], ok: false };
}
