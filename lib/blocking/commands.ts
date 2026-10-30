import type { CameraMove, Mark, Scene, SceneCommand as SceneCommandT } from "./types";
import { BLOCKING_LIMITS, POSES, Scene as SceneSchema, SceneCommand } from "./types";
import { faceHeight, solveFraming } from "./framing";
import { DEFAULT_AMOUNTS, amountLabel, cameraBoundsIssue, clampAmount, fitMove, moveKeys } from "./presets";
import { sampleActor, sampleCamera, sampleSceneAt } from "./sample";
import { featureById, featureNormal, insideFeature, isSeat, isWallFeature, seatAt, setBounds, surfaceHeight } from "./sets";
import { approachPoint } from "./auto";
import { ensureInFrame, startFramingIssues } from "./visibility";
import { dist, headingDeg, len, mul, normalize, sub, v3 } from "./vec";

/**
 * Astra's scene commands, validated before they touch the scene. Each command is parsed
 * with the contract's zod schema, applied to a copy, and the result re-validated; a
 * command that would leave the scene invalid is rejected with a plain reason and the
 * scene stays as it was. Valid commands apply in order.
 *
 * Choices worth knowing:
 *  - place_actor puts the figure at one spot for the whole shot (any walk is replaced).
 *  - near: a window/door → 0.8 m into the room in front of it; furniture → its nearest
 *    edge from where the figure is now; a seat with pose "sit" → on the seat; another
 *    actor → beside them across the camera's line; a prop → 0.45 m from it.
 *  - set_lens keeps the subject the same size by moving the camera along its line of
 *    sight (a lens swap changes perspective, not framing). Use `frame` to re-frame.
 *  - set_duration rescales every mark, hold and camera key.
 */

export type ApplyResult = { scene: Scene; changes: string[]; errors: string[] };

const MAX_WALK_SPEED = 2.0; // m/s — walking only; running belongs to the full pipeline
const TURN_LEAD = 0.6; // seconds a turn or pose change takes to happen

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const r2 = (n: number) => Math.round(n * 100) / 100;
const fmtT = (t: number) => `${t.toFixed(1)} s`;

type Target = { kind: "actor" | "prop" | "feature" | "camera"; id: string; label: string; x: number; z: number };

function resolveTarget(scene: Scene, id: string, t: number): Target | null {
  if (id === "camera") {
    const c = sampleCamera(scene, t);
    return { kind: "camera", id, label: "the camera", x: c.pos.x, z: c.pos.z };
  }
  const s = sampleSceneAt(scene, t);
  const a = s.actors.find((x) => x.id === id);
  if (a) return { kind: "actor", id, label: a.name, x: a.x, z: a.z };
  const p = s.props.find((x) => x.id === id);
  if (p) return { kind: "prop", id, label: p.name, x: p.x, z: p.z };
  const f = featureById(scene.set, id);
  if (f) return { kind: "feature", id, label: f.label, x: f.x, z: f.z };
  return null;
}

function knownIds(scene: Scene): string {
  return [...scene.actors.map((a) => `${a.id} (${a.name})`), ...scene.props.map((p) => `${p.id} (${p.name})`), ...scene.set.features.map((f) => f.id)].join(", ");
}

/** Where a figure ends up when asked to be near something. */
function nearSpot(scene: Scene, actorId: string, targetId: string, t: number, pose?: string): { x: number; z: number; facing: number | null; seated?: boolean } | string {
  const target = resolveTarget(scene, targetId, t);
  if (!target) return `unknown target "${targetId}" (known: ${knownIds(scene)})`;
  const actorIndex = scene.actors.findIndex((a) => a.id === actorId);
  const me = sampleActor(scene.actors[actorIndex], actorIndex, t);
  if (target.kind === "feature") {
    const f = featureById(scene.set, targetId)!;
    if (pose === "sit" && isSeat(f)) {
      return { x: f.x, z: f.z, facing: f.kind === "bed" ? 0 : f.rot ?? 0, seated: true };
    }
    if (isWallFeature(f)) {
      const n = featureNormal(scene.set, f);
      return { x: f.x + n.x * 0.8, z: f.z + n.z * 0.8, facing: null };
    }
    const p = approachPoint(f, { x: me.x, z: me.z }, 0.45);
    return { x: p.x, z: p.z, facing: p.facing };
  }
  if (target.kind === "actor") {
    // Beside them, across the camera's line of sight, on whichever side I already am.
    const cam = sampleCamera(scene, t);
    const view = normalize(sub(v3(target.x, 0, target.z), v3(cam.pos.x, 0, cam.pos.z)));
    const across = { x: view.z, z: -view.x };
    const side = (me.x - target.x) * across.x + (me.z - target.z) * across.z >= 0 ? 1 : -1;
    const x = target.x + across.x * 0.75 * side;
    const z = target.z + across.z * 0.75 * side;
    return { x, z, facing: headingDeg(target.x - x, target.z - z) };
  }
  if (target.kind === "prop") {
    const dx = me.x - target.x;
    const dz = me.z - target.z;
    const l = Math.hypot(dx, dz) || 1;
    const x = target.x + (dx / l) * 0.45;
    const z = target.z + (dz / l) * 0.45;
    return { x, z, facing: headingDeg(target.x - x, target.z - z) };
  }
  return { x: target.x, z: target.z + 0.8, facing: null };
}

/** Insert a mark at `t`, holding the previous state until just before it so changes happen quickly. */
function insertMark(marks: Mark[], m: Mark, holdFrom: Mark | null): Mark[] {
  const out = marks.filter((k) => Math.abs(k.t - m.t) > 0.05);
  if (holdFrom && m.t - TURN_LEAD > (out.filter((k) => k.t < m.t).pop()?.t ?? -1) + 0.05) {
    out.push({ ...holdFrom, t: r2(m.t - TURN_LEAD) });
  }
  out.push(m);
  return out.sort((a, b) => a.t - b.t);
}

function cameraFrameTime(scene: Scene): number {
  return scene.camera.move === "pan" || scene.camera.move === "track" ? 0 : scene.duration;
}

/** Rebuild the move from the start key with the current move settings, fitted to the set. */
function rebuildMove(scene: Scene, changes: string[]): void {
  const start = scene.camera.keys[0];
  const requested = clampAmount(scene.camera.move, scene.camera.amount).amount;
  const fitted = fitMove(scene.set, start, scene.camera.move, requested, scene.camera.direction);
  if (scene.camera.move !== "static" && fitted.amount === 0) {
    changes.push(`The ${moveName(scene.camera.move)} no longer fits the set from here, so the camera is locked off`);
    scene.camera.move = "static";
  } else if (fitted.reduced) {
    changes.push(`${capital(moveName(scene.camera.move))} reduced to ${amountLabel(scene.camera.move, fitted.amount)} to stay inside the set`);
  }
  scene.camera.amount = Math.round(fitted.amount * 1000) / 1000;
  const at = cameraFrameTime(scene);
  const subjectIndex = scene.actors.findIndex((a) => a.id === scene.camera.subjectId);
  const faceY = subjectIndex >= 0 && scene.camera.focus !== "hands" ? faceHeight(sampleActor(scene.actors[subjectIndex], subjectIndex, at)) : null;
  scene.camera.keys = moveKeys(start, scene.camera.move, scene.camera.amount, scene.camera.direction, scene.duration, { faceY });
}

export function moveName(move: CameraMove): string {
  return { static: "locked-off camera", push_in: "push-in", pull_out: "pull-out", pan: "pan", track: "tracking move", orbit: "orbit" }[move];
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function applyOne(scene: Scene, cmd: SceneCommandT, changes: string[]): string | null {
  const actorOf = (id: string) => scene.actors.find((a) => a.id === id);
  const inTime = (t: number, what: string) => (t < -1e-6 || t > scene.duration + 1e-6 ? `${what} ${fmtT(t)} is outside the shot (0–${fmtT(scene.duration)})` : null);
  switch (cmd.op) {
    case "place_actor": {
      const actor = actorOf(cmd.actor);
      if (!actor) return `unknown actor "${cmd.actor}" (cast: ${scene.actors.map((a) => `${a.id} (${a.name})`).join(", ") || "none"})`;
      let x = cmd.x;
      let z = cmd.z;
      let facing: number | null = cmd.facing ?? null;
      let pose = cmd.pose ?? sampleActor(actor, scene.actors.indexOf(actor), 0).pose;
      let where = "";
      if (cmd.near) {
        const spot = nearSpot(scene, actor.id, cmd.near, 0, pose);
        if (typeof spot === "string") return spot;
        x = spot.x;
        z = spot.z;
        if (facing === null) facing = spot.facing;
        if (spot.seated) pose = "sit";
        where = ` beside the ${resolveTarget(scene, cmd.near, 0)?.label ?? cmd.near}`;
      }
      if (x === undefined || z === undefined) return "place_actor needs x and z, or near";
      const current = sampleActor(actor, scene.actors.indexOf(actor), 0);
      if (pose === "walk") pose = "stand";
      actor.marks = [{ t: 0, x: r2(x), z: r2(z), facing: Math.round(facing ?? current.facing), pose }];
      changes.push(`${actor.name} placed${where} at (${x.toFixed(1)}, ${z.toFixed(1)}), ${pose === "sit" ? "seated" : "standing"}`);
      return null;
    }
    case "move_actor": {
      const actor = actorOf(cmd.actor);
      if (!actor) return `unknown actor "${cmd.actor}"`;
      const bad = inTime(cmd.from, "start") ?? inTime(cmd.until, "end");
      if (bad) return bad;
      if (cmd.until - cmd.from < 0.5) return "a walk needs at least half a second";
      const idx = scene.actors.indexOf(actor);
      const at = sampleActor(actor, idx, cmd.from);
      let dest: { x: number; z: number; facing: number | null };
      let where = "";
      if (cmd.toward) {
        const spot = nearSpot(scene, actor.id, cmd.toward, cmd.until);
        if (typeof spot === "string") return spot;
        dest = spot;
        where = ` to the ${resolveTarget(scene, cmd.toward, cmd.until)?.label ?? cmd.toward}`;
      } else if (cmd.to) {
        dest = { x: cmd.to.x, z: cmd.to.z, facing: null };
        where = ` to (${cmd.to.x.toFixed(1)}, ${cmd.to.z.toFixed(1)})`;
      } else return "move_actor needs `to` or `toward`";
      const travel = Math.hypot(dest.x - at.x, dest.z - at.z);
      if (travel / (cmd.until - cmd.from) > MAX_WALK_SPEED) {
        return `${actor.name} would have to cover ${travel.toFixed(1)} m in ${(cmd.until - cmd.from).toFixed(1)} s — faster than a walk (max ${MAX_WALK_SPEED} m/s). Give the walk more time.`;
      }
      const heading = headingDeg(dest.x - at.x, dest.z - at.z);
      const kept = actor.marks.filter((m) => m.t < cmd.from - 0.05);
      const startPose = at.pose === "sit" ? "stand" : at.pose === "walk" ? "stand" : at.pose;
      kept.push({ t: r2(cmd.from), x: r2(at.x), z: r2(at.z), facing: Math.round(at.facing), pose: startPose });
      kept.push({ t: r2(cmd.until), x: r2(dest.x), z: r2(dest.z), facing: Math.round(dest.facing ?? heading), pose: "stand" });
      actor.marks = kept;
      changes.push(`${actor.name} walks${where} from ${fmtT(cmd.from)} to ${fmtT(cmd.until)}`);
      return null;
    }
    case "set_pose": {
      const actor = actorOf(cmd.actor);
      if (!actor) return `unknown actor "${cmd.actor}"`;
      const bad = inTime(cmd.at, "time");
      if (bad) return bad;
      const idx = scene.actors.indexOf(actor);
      const s = sampleActor(actor, idx, cmd.at);
      if (s.moving) return `${actor.name} is walking at ${fmtT(cmd.at)}; change the pose before or after the walk`;
      if (cmd.pose === "walk") return `"walk" is shown automatically while a figure moves; use move_actor`;
      const prev = { t: 0, x: r2(s.x), z: r2(s.z), facing: Math.round(s.facing), pose: s.pose };
      const m: Mark = { t: r2(cmd.at), x: r2(s.x), z: r2(s.z), facing: Math.round(s.facing), pose: cmd.pose };
      actor.marks = cmd.at <= 0.05 && actor.marks.length === 1 ? [m] : insertMark(actor.marks, m, prev);
      changes.push(`${actor.name} ${poseVerb(cmd.pose)}${cmd.at > 0.05 ? ` at ${fmtT(cmd.at)}` : ""}`);
      return null;
    }
    case "face": {
      const actor = actorOf(cmd.actor);
      if (!actor) return `unknown actor "${cmd.actor}"`;
      const bad = inTime(cmd.at, "time");
      if (bad) return bad;
      const idx = scene.actors.indexOf(actor);
      const s = sampleActor(actor, idx, cmd.at);
      if (s.moving) return `${actor.name} is walking at ${fmtT(cmd.at)} and faces the direction of travel; turn them before or after the walk`;
      let facing = cmd.facing;
      let what = facing !== undefined ? `${Math.round(facing)}°` : "";
      if (cmd.toward) {
        const target = resolveTarget(scene, cmd.toward, cmd.at);
        if (!target) return `unknown target "${cmd.toward}" (known: ${knownIds(scene)})`;
        facing = headingDeg(target.x - s.x, target.z - s.z);
        what = target.kind === "camera" ? "the camera" : `the ${target.label}`;
      }
      if (facing === undefined) return "face needs `facing` or `toward`";
      const prev = { t: 0, x: r2(s.x), z: r2(s.z), facing: Math.round(s.facing), pose: s.pose };
      const m: Mark = { t: r2(cmd.at), x: r2(s.x), z: r2(s.z), facing: Math.round(facing), pose: s.pose };
      actor.marks = cmd.at <= 0.05 && actor.marks.length === 1 ? [m] : insertMark(actor.marks, m, prev);
      changes.push(`${actor.name} turns toward ${what}${cmd.at > 0.05 ? ` at ${fmtT(cmd.at)}` : ""}`);
      return null;
    }
    case "place_prop": {
      const prop = scene.props.find((p) => p.id === cmd.prop);
      if (!prop) return `unknown prop "${cmd.prop}" (props: ${scene.props.map((p) => `${p.id} (${p.name})`).join(", ") || "none"})`;
      if (cmd.on) {
        const f = featureById(scene.set, cmd.on);
        if (!f) return `unknown set feature "${cmd.on}"`;
        const top = surfaceHeight(f);
        if (top === null) return `the ${f.label.toLowerCase()} has no surface to put the ${prop.name} on`;
        if (prop.size === "large") return `the ${prop.name} is too large to rest on the ${f.label.toLowerCase()}; place it on the floor beside it`;
        const others = scene.props.filter((p) => p !== prop && insideFeature(f, p.x, p.z) && Math.abs(p.y - top) < 0.05).length;
        prop.x = r2(cmd.x ?? f.x + others * 0.18);
        prop.z = r2(cmd.z ?? f.z);
        prop.y = r2(top + (f.elev ?? 0));
        if (!insideFeature(f, prop.x, prop.z, 0.02)) return `(${prop.x}, ${prop.z}) is not on the ${f.label.toLowerCase()}`;
        changes.push(`The ${prop.name} rests on the ${f.label.toLowerCase()}`);
        return null;
      }
      if (cmd.x === undefined || cmd.z === undefined) return "place_prop needs `on`, or x and z";
      const under = prop.size === "large" ? undefined : scene.set.features.find((f) => surfaceHeight(f) !== null && !isWallFeature(f) && insideFeature(f, cmd.x!, cmd.z!));
      prop.x = r2(cmd.x);
      prop.z = r2(cmd.z);
      prop.y = under ? r2((surfaceHeight(under) ?? 0) + (under.elev ?? 0)) : 0;
      changes.push(`The ${prop.name} placed at (${cmd.x.toFixed(1)}, ${cmd.z.toFixed(1)})${under ? ` on the ${under.label.toLowerCase()}` : ""}`);
      return null;
    }
    case "hand_prop": {
      const prop = scene.props.find((p) => p.id === cmd.prop);
      if (!prop) return `unknown prop "${cmd.prop}"`;
      if (cmd.actor !== null && !actorOf(cmd.actor)) return `unknown actor "${cmd.actor}"`;
      const bad = inTime(cmd.at, "time");
      if (bad) return bad;
      prop.holds = [...(prop.holds ?? []).filter((h) => Math.abs(h.t - cmd.at) > 0.05), { t: r2(cmd.at), actorId: cmd.actor }].sort((a, b) => a.t - b.t);
      const who = cmd.actor ? actorOf(cmd.actor)!.name : null;
      changes.push(who ? `${who} holds the ${prop.name} from ${fmtT(cmd.at)}` : `The ${prop.name} is set down at ${fmtT(cmd.at)}`);
      return null;
    }
    case "frame": {
      const subjectId = cmd.subject ?? scene.camera.subjectId;
      if (cmd.subject && !scene.actors.some((a) => a.id === cmd.subject) && !scene.props.some((p) => p.id === cmd.subject)) {
        return `unknown subject "${cmd.subject}" — frame an actor or a prop (${knownIds(scene)})`;
      }
      const at = cameraFrameTime(scene);
      const s = sampleSceneAt(scene, at);
      const solved = solveFraming({
        set: scene.set,
        aspect: scene.aspect,
        lens: scene.camera.keys[0].lens,
        framing: cmd.framing,
        actors: s.actors,
        props: s.props,
        subjectId: subjectId ?? null,
        side: cmd.side,
        height: cmd.height,
        seed: scene.shotId,
      });
      scene.camera.keys = [solved.key];
      scene.camera.subjectId = solved.subjectId;
      scene.camera.focus = solved.focus ?? "figure";
      changes.push(`Re-framed as a ${cmd.framing}${solved.subjectId ? ` on ${nameOf(scene, solved.subjectId)}${solved.focus === "hands" ? "'s hands" : ""}` : ""}${cmd.side && cmd.side !== "front" ? ` from the ${cmd.side.replace("_", " ")}` : ""}${cmd.height && cmd.height !== "eye" ? `, ${cmd.height} angle` : ""}`);
      changes.push(...solved.notes);
      rebuildMove(scene, changes);
      const held = ensureInFrame(scene);
      if (!held.ok) return `a ${cmd.framing} from here can't keep everyone in frame at the first frame; try another side or a wider framing`;
      Object.assign(scene, held.scene);
      changes.push(...held.notes);
      return null;
    }
    case "camera_move": {
      const requested = cmd.amount ?? (cmd.move === scene.camera.move ? scene.camera.amount : DEFAULT_AMOUNTS[cmd.move]);
      const { amount, clamped } = clampAmount(cmd.move, requested);
      scene.camera.move = cmd.move;
      scene.camera.amount = amount;
      if (cmd.direction) scene.camera.direction = cmd.direction;
      if (cmd.ease) scene.camera.ease = cmd.ease;
      if (clamped) changes.push(`${capital(moveName(cmd.move))} limited to ${amountLabel(cmd.move, amount)} (the fast-lane maximum)`);
      const before = changes.length;
      rebuildMove(scene, changes);
      if (changes.length === before || scene.camera.move !== "static") {
        changes.push(
          scene.camera.move === "static"
            ? "Camera locked off"
            : `${capital(moveName(scene.camera.move))} of ${amountLabel(scene.camera.move, scene.camera.amount)}${scene.camera.move === "pan" || scene.camera.move === "orbit" || scene.camera.move === "track" ? ` to the ${scene.camera.direction}` : ""} over ${fmtT(scene.duration)}, ${easeName(scene.camera.ease)}`,
        );
      }
      return null;
    }
    case "set_lens": {
      const L = BLOCKING_LIMITS;
      if (cmd.mm < L.lensMin || cmd.mm > L.lensMax) return `${cmd.mm} mm is outside the supported lenses (${L.lensMin}–${L.lensMax} mm)`;
      const k = scene.camera.keys[0];
      const view = sub(k.target, k.pos);
      const want = len(view) * (cmd.mm / k.lens);
      const back = normalize(view);
      // Keep the subject's size: move along the line of sight, as far as the set allows.
      let d = want;
      let pos = sub(k.target, mul(back, d));
      for (let i = 0; i < 24 && cameraBoundsIssue(scene.set, pos); i++) {
        d = d * 0.92;
        pos = sub(k.target, mul(back, d));
      }
      if (cameraBoundsIssue(scene.set, pos)) return `a ${cmd.mm} mm lens can't keep this framing inside the set`;
      scene.camera.keys = [{ t: 0, pos, target: k.target, lens: cmd.mm }];
      changes.push(`Lens changed to ${cmd.mm} mm${d < want * 0.98 ? " (the set is too small to keep the full framing, so the subject is a little larger)" : ", framing kept"}`);
      rebuildMove(scene, changes);
      return null;
    }
    case "set_camera_height": {
      const L = BLOCKING_LIMITS;
      if (cmd.meters < L.cameraHeightMin || cmd.meters > L.cameraHeightMax) return `camera height must be ${L.cameraHeightMin}–${L.cameraHeightMax} m`;
      const k = scene.camera.keys[0];
      scene.camera.keys = [{ ...k, t: 0, pos: { ...k.pos, y: cmd.meters } }];
      changes.push(`Camera height set to ${cmd.meters.toFixed(2)} m`);
      rebuildMove(scene, changes);
      return null;
    }
    case "set_duration": {
      if (cmd.seconds < 1 || cmd.seconds > 15) return "a shot's blocking runs 1–15 s";
      // Keep the fractions of the shot exact: rounding here would read as a new picture.
      const k = cmd.seconds / scene.duration;
      const r5 = (n: number) => Math.round(n * 100000) / 100000;
      for (const a of scene.actors) a.marks = a.marks.map((m) => ({ ...m, t: r5(m.t * k) }));
      for (const p of scene.props) p.holds = (p.holds ?? []).map((h) => ({ ...h, t: r5(h.t * k) }));
      scene.camera.keys = scene.camera.keys.map((key, i) => ({ ...key, t: i === 0 ? 0 : cmd.seconds }));
      changes.push(`Shot length ${fmtT(scene.duration)} → ${fmtT(cmd.seconds)}; actions and the move rescaled to match`);
      scene.duration = cmd.seconds;
      return null;
    }
  }
}

function nameOf(scene: Scene, id: string): string {
  return scene.actors.find((a) => a.id === id)?.name ?? scene.props.find((p) => p.id === id)?.name ?? id;
}

function poseVerb(pose: string): string {
  return { stand: "stands", sit: "sits", walk: "walks", turn: "turns", look: "looks", reach: "reaches" }[pose] ?? pose;
}

function easeName(ease: string): string {
  return { linear: "steady pace", gentle: "gentle ease in and out", slow_in: "settling into the end frame" }[ease] ?? ease;
}

function zodMessage(err: { issues: { path: PropertyKey[]; message: string }[] }, raw: unknown): string {
  const op = typeof raw === "object" && raw && "op" in raw ? String((raw as { op: unknown }).op) : "command";
  const poseIssue = err.issues.find((i) => i.path.includes("pose"));
  if (poseIssue) {
    const asked = typeof raw === "object" && raw && "pose" in raw ? String((raw as { pose: unknown }).pose) : "?";
    return `${op}: pose "${asked}" isn't supported in the fast lane (${POSES.join(", ")}); complex performance belongs to the full pipeline`;
  }
  const moveIssue = err.issues.find((i) => i.path.includes("move"));
  if (moveIssue) return `${op}: unsupported camera move (static, push_in, pull_out, pan, track, orbit)`;
  return `${op}: ${err.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`;
}

export function applyCommands(scene: Scene, commands: readonly unknown[]): ApplyResult {
  let current = clone(scene);
  const changes: string[] = [];
  const errors: string[] = [];
  const baseline = new Set(validateStructure(current));
  for (const raw of commands) {
    const parsed = SceneCommand.safeParse(raw);
    if (!parsed.success) {
      errors.push(zodMessage(parsed.error, raw));
      continue;
    }
    const cmd = parsed.data;
    let next = clone(current);
    const notes: string[] = [];
    const problem = applyOne(next, cmd, notes);
    if (problem) {
      errors.push(`${cmd.op}: ${problem}`);
      continue;
    }
    const introduced = validateStructure(next).filter((i) => !baseline.has(i));
    if (introduced.length) {
      errors.push(`${cmd.op}: rejected — ${introduced.join("; ")}`);
      continue;
    }
    // Everyone on screen must be visible on the first frame (it is the first frame of the
    // generated video). If this change loses someone, move the camera to hold them; if
    // the camera can't, the change is refused.
    const before = new Set(startFramingIssues(current));
    const lost = startFramingIssues(next).filter((i) => !before.has(i));
    if (lost.length) {
      const held = ensureInFrame(next);
      if (!held.ok) {
        errors.push(`${cmd.op}: rejected — ${lost.join("; ")}, and the camera can't widen enough to hold them`);
        continue;
      }
      next = held.scene;
      notes.push(...held.notes);
    }
    current = next;
    changes.push(...notes);
  }
  return { scene: current, changes, errors };
}

/**
 * Every reason a scene is outside the fast lane's supported blocking. Empty = valid.
 * Includes anyone out of frame on the first frame (see visibility.ts framingIssues for the
 * middle and end of the shot).
 */
export function validateScene(scene: Scene): string[] {
  const structural = validateStructure(scene);
  return structural.length ? structural : [...structural, ...startFramingIssues(scene)];
}

/** Bounds, poses, speeds, seats, lens and camera limits — everything except framing. */
export function validateStructure(scene: Scene): string[] {
  const issues: string[] = [];
  const parsed = SceneSchema.safeParse(scene);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  const L = BLOCKING_LIMITS;
  const b = setBounds(scene.set);
  const m = L.actorMargin;
  const ids = new Set<string>();
  for (const a of scene.actors) {
    if (ids.has(a.id)) issues.push(`actor ${a.id} appears twice`);
    ids.add(a.id);
    const marks = [...a.marks].sort((x, y) => x.t - y.t);
    marks.forEach((mk, i) => {
      if (mk.t < -1e-6 || mk.t > scene.duration + 1e-6) issues.push(`${a.name} has a mark at ${fmtT(mk.t)}, outside the shot`);
      if (mk.x < b.minX + m || mk.x > b.maxX - m || mk.z < b.minZ + m || mk.z > b.maxZ - m) {
        issues.push(`${a.name} at (${mk.x.toFixed(1)}, ${mk.z.toFixed(1)}) is outside the set (x ${(b.minX + m).toFixed(1)}…${(b.maxX - m).toFixed(1)}, z ${(b.minZ + m).toFixed(1)}…${(b.maxZ - m).toFixed(1)})`);
      }
      if (mk.pose === "sit") {
        if (!seatAt(scene.set, mk.x, mk.z)) issues.push(`${a.name} sits at (${mk.x.toFixed(1)}, ${mk.z.toFixed(1)}) with no seat there`);
      } else {
        const blocked = scene.set.features.find((f) => !isWallFeature(f) && f.h > 0.3 && f.kind !== "chair" && insideFeature(f, mk.x, mk.z, -0.05));
        if (blocked) issues.push(`${a.name} would stand inside the ${blocked.label.toLowerCase()}`);
      }
      if (i > 0) {
        const prev = marks[i - 1];
        const span = mk.t - prev.t;
        const travel = Math.hypot(mk.x - prev.x, mk.z - prev.z);
        if (travel > 0.05 && (span <= 0 || travel / span > MAX_WALK_SPEED + 1e-6)) issues.push(`${a.name} moves faster than a walk between ${fmtT(prev.t)} and ${fmtT(mk.t)}`);
      }
    });
  }
  for (const p of scene.props) {
    if (ids.has(p.id)) issues.push(`id ${p.id} is used twice`);
    ids.add(p.id);
    if (p.x < b.minX || p.x > b.maxX || p.z < b.minZ || p.z > b.maxZ) issues.push(`the ${p.name} is outside the set`);
    for (const h of p.holds ?? []) {
      if (h.actorId && !scene.actors.some((a) => a.id === h.actorId)) issues.push(`the ${p.name} is held by an unknown actor ${h.actorId}`);
      if (h.t < -1e-6 || h.t > scene.duration + 1e-6) issues.push(`the ${p.name} changes hands at ${fmtT(h.t)}, outside the shot`);
    }
  }
  const cam = scene.camera;
  const { amount } = clampAmount(cam.move, cam.amount);
  if (Math.abs(amount - Math.abs(cam.amount)) > 1e-6) issues.push(`the ${moveName(cam.move)} amount ${cam.amount} is beyond the fast-lane limit`);
  for (const k of cam.keys) {
    if (k.t < -1e-6 || k.t > scene.duration + 1e-6) issues.push(`a camera key at ${fmtT(k.t)} is outside the shot`);
    if (k.lens < L.lensMin || k.lens > L.lensMax) issues.push(`lens ${k.lens} mm is outside ${L.lensMin}–${L.lensMax} mm`);
    const where = cameraBoundsIssue(scene.set, k.pos);
    if (where) issues.push(where);
    if (dist(k.pos, k.target) < 0.2) issues.push("the camera is sitting on its own target");
  }
  if (cam.move !== "static" && cam.keys.length < 2) issues.push(`a ${moveName(cam.move)} needs an end key`);
  if (cam.subjectId && !scene.actors.some((a) => a.id === cam.subjectId) && !scene.props.some((p) => p.id === cam.subjectId)) {
    issues.push(`the camera's subject ${cam.subjectId} is not in the shot`);
  }
  return issues;
}

// Re-exported for callers that build command lists from UI options.
export { DEFAULT_AMOUNTS, amountLabel };
