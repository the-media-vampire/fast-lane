import type { Scene } from "./types";
import type { ActorSample, CameraSample } from "./sample";
import { MANNEQUIN_BASE_HEIGHT, sampleCamera, sampleSceneAt } from "./sample";
import { lensCharacter } from "./lens";
import { amountLabel } from "./presets";
import { isWallFeature, setBounds } from "./sets";
import { WORLD_UP, angleDelta, cross, dot, headingDeg, len, normalize, rad, sub, v3 } from "./vec";

/**
 * The scene in words: film language for image and video prompts, and a compact
 * id-and-coordinate read-out for Astra. Both read the scene through sampleSceneAt, so
 * the words describe exactly what the camera view and the overhead plan show.
 */

const r1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

function nearestFeatureLabel(scene: Scene, x: number, z: number, within = 1.4): string | null {
  let best: { label: string; d: number; kind: string } | null = null;
  for (const f of scene.set.features) {
    if (f.kind === "chair" || f.kind === "plant" || f.kind === "block") continue;
    const d = Math.hypot(f.x - x, f.z - z) - Math.min(f.w, f.d) / 2;
    if (d < within && (!best || d < best.d)) best = { label: f.label.toLowerCase(), d, kind: f.kind };
  }
  if (!best) return null;
  const prep = best.kind === "window" || best.kind === "door" || best.kind === "shelf" || best.kind === "wall" ? "by" : "at";
  return `${prep} the ${best.label}`;
}

/** Where a point sits in frame: −1 … 1 across, or null when it is behind the camera. */
function screenX(cam: CameraSample, x: number, y: number, z: number): number | null {
  const fwd = normalize(sub(cam.target, cam.pos));
  const right = normalize(cross(fwd, WORLD_UP));
  const d = sub(v3(x, y, z), cam.pos);
  const depth = dot(d, fwd);
  if (depth <= 0.05) return null;
  return dot(d, right) / depth / Math.tan(rad(cam.fovH) / 2);
}

function framePosition(cam: CameraSample, a: ActorSample): string {
  const sx = screenX(cam, a.x, (a.pose === "sit" ? 1.2 : 1.5) * (a.height / MANNEQUIN_BASE_HEIGHT), a.z);
  if (sx === null || Math.abs(sx) > 1.05) return "out of frame";
  if (sx < -0.33) return "frame left";
  if (sx > 0.33) return "frame right";
  return "centre frame";
}

function facingToCamera(cam: CameraSample, a: ActorSample): string {
  const toCamera = headingDeg(cam.pos.x - a.x, cam.pos.z - a.z);
  const d = Math.abs(angleDelta(a.facing, toCamera));
  if (d < 35) return "facing the camera";
  if (d < 70) return "in three-quarter view";
  if (d < 115) return "in profile";
  return "with their back to the camera";
}

function shotSize(scene: Scene, cam: CameraSample, subjectId: string | null, actors: ActorSample[]): string {
  if (scene.camera.focus === "hands") {
    const who = actors.find((x) => x.id === subjectId);
    if (who) return `${cam.pitch < -15 ? "close detail" : "close shot"} of ${who.name}'s hands, face out of frame`;
  }
  const prop = scene.props.find((p) => p.id === subjectId);
  if (prop) return cam.pitch < -20 ? `close detail of the ${prop.name}` : `hero shot of the ${prop.name}`;
  const a = actors.find((x) => x.id === subjectId) ?? null;
  if (!a) return scene.actors.length ? "wide shot" : "wide establishing shot";
  const visible = 2 * len(sub(cam.target, cam.pos)) * Math.tan(rad(cam.fovV) / 2);
  const body = (a.pose === "sit" ? 1.42 : a.height) * (a.pose === "sit" ? a.height / MANNEQUIN_BASE_HEIGHT : 1);
  const ratio = visible / body;
  if (ratio > 3) return "wide shot";
  if (ratio > 1.5) return "full shot";
  if (ratio > 0.75) return "medium shot";
  if (ratio > 0.32) return "close-up";
  return "extreme close-up";
}

function heightWord(cam: CameraSample): string {
  if (cam.pitch < -38) return "overhead angle";
  if (cam.pitch < -12) return "high angle";
  if (cam.pitch > 10) return "low angle";
  return "eye level";
}

function speedWord(metresPerSecond: number): string {
  if (metresPerSecond < 0.08) return "very slow";
  if (metresPerSecond < 0.2) return "slow";
  if (metresPerSecond < 0.45) return "steady";
  return "quick";
}

function nameOf(scene: Scene, id: string | null): string | null {
  if (!id) return null;
  return scene.actors.find((a) => a.id === id)?.name ?? scene.props.find((p) => `${p.id}` === id)?.name ?? null;
}

export function describeCameraMove(scene: Scene): string {
  const cam = scene.camera;
  const subject = nameOf(scene, cam.subjectId);
  const keys = cam.keys;
  const travel = keys.length > 1 ? len(sub(keys[1].pos, keys[0].pos)) : 0;
  const speed = speedWord(travel / scene.duration);
  switch (cam.move) {
    case "push_in":
      return `${speed} push-in${subject ? ` toward ${subject}` : ""}`;
    case "pull_out":
      return `${speed} pull-back${subject ? ` from ${subject}` : ""}, revealing the ${scene.set.label.toLowerCase()}`;
    case "pan":
      return `pans ${cam.direction} ${Math.round(cam.amount)}°`;
    case "track":
      return `tracks ${cam.direction} ${amountLabel("track", cam.amount)}${subject ? ` alongside ${subject}` : ""}`;
    case "orbit":
      return `${speed === "quick" ? "" : "slow "}${Math.round(cam.amount)}° orbit ${cam.direction}${subject ? ` around ${subject}` : ""}`;
    default:
      return "locked-off camera";
  }
}

export function describeForPrompt(scene: Scene): { camera: string; staging: string } {
  const start = sampleSceneAt(scene, 0);
  const end = sampleSceneAt(scene, scene.duration);
  const cam0 = start.camera;
  const size = shotSize(scene, cam0, scene.camera.subjectId, start.actors);
  const camera = `${size}, ${Math.round(cam0.lens)}mm ${lensCharacter(cam0.lens)} lens, ${heightWord(cam0)}, ${describeCameraMove(scene)} over ${Math.round(scene.duration)} seconds`;

  const parts: string[] = [];
  scene.actors.forEach((actor, i) => {
    const s0 = start.actors[i];
    const s1 = end.actors[i];
    const marks = [...actor.marks].sort((a, b) => a.t - b.t);
    const walkLeg = marks.findIndex((m, k) => k > 0 && Math.hypot(m.x - marks[k - 1].x, m.z - marks[k - 1].z) > 0.05);
    if (walkLeg > 0) {
      const from = nearestFeatureLabel(scene, marks[walkLeg - 1].x, marks[walkLeg - 1].z, 1.6);
      const to = nearestFeatureLabel(scene, marks[walkLeg].x, marks[walkLeg].z, 1.6);
      const finalPose = s1.pose === "sit" ? ", then sits" : "";
      parts.push(`${actor.name} walks${from ? ` from ${from.replace(/^(at|by) /, "")}` : " in"}${to ? ` to ${to.replace(/^(at|by) /, "")}` : ""}${finalPose}, ending ${framePosition(end.camera, s1)} ${facingToCamera(end.camera, s1)}`);
    } else {
      const posture = s0.pose === "sit" ? "sits" : s0.pose === "reach" ? "reaches forward" : "stands";
      const where = nearestFeatureLabel(scene, s0.x, s0.z);
      const later = marks.find((m) => m.t > 0.05 && m.pose !== s0.pose);
      const change = later ? `, then ${later.pose === "reach" ? "reaches forward" : later.pose === "sit" ? "sits" : later.pose === "stand" ? "settles" : later.pose}` : "";
      parts.push(`${actor.name} ${posture}${where ? ` ${where}` : ""}, ${framePosition(cam0, s0)}, ${facingToCamera(cam0, s0)}${change}`);
    }
  });
  scene.props.forEach((prop, i) => {
    const p0 = start.props[i];
    const holder = scene.actors.find((a) => a.id === p0.heldBy);
    if (holder) {
      parts.push(prop.size === "large" ? `${holder.name} walks beside the ${prop.name}` : `${holder.name} holds the ${prop.name}`);
      return;
    }
    if (prop.size === "large") {
      const by = nearestFeatureLabel(scene, prop.x, prop.z, 1.6);
      parts.push(`the ${prop.name} stands on the floor${by ? ` ${by}` : ""}`);
      return;
    }
    const surface = scene.set.features.find((f) => !isWallFeature(f) && Math.abs((f.surface ?? -9) - prop.y) < 0.06 && Math.hypot(f.x - prop.x, f.z - prop.z) < Math.max(f.w, f.d));
    const pickedUp = (prop.holds ?? []).find((h) => h.actorId && h.t > 0.05);
    const by = pickedUp ? nameOf(scene, pickedUp.actorId) : null;
    parts.push(`the ${prop.name} rests ${surface ? `on the ${surface.label.toLowerCase()}` : "nearby"}${by ? `, and ${by} picks it up` : ""}`);
  });
  const staging = parts.length ? `${parts.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()) : `The empty ${scene.set.label.toLowerCase()}.`;
  return { camera, staging };
}

export function describeForAgent(scene: Scene): string {
  const b = setBounds(scene.set);
  const lines: string[] = [];
  lines.push(`Shot ${scene.shotId} · ${scene.duration}s · ${scene.aspect}`);
  lines.push(
    `Set: ${scene.set.label} (${scene.set.preset}), ${scene.set.width}×${scene.set.depth} m, ${scene.set.exterior ? "exterior" : `interior, ${scene.set.height} m high`}. Floor x ${b.minX}…${b.maxX}, z ${b.minZ}…${b.maxZ}; back at −z, open camera side +z.`,
  );
  lines.push(`Features: ${scene.set.features.map((f) => `${f.id} "${f.label}" (${r1(f.x)}, ${r1(f.z)})`).join("; ")}`);
  lines.push("Actors:");
  for (const a of scene.actors) {
    const marks = [...a.marks].sort((x, y) => x.t - y.t).map((m) => `t${r1(m.t)} (${r1(m.x)}, ${r1(m.z)}) facing ${Math.round(m.facing)}° ${m.pose}`);
    lines.push(`- ${a.id} "${a.name}" ${a.height} m: ${marks.join(" → ")}`);
  }
  if (!scene.actors.length) lines.push("- none");
  lines.push("Props:");
  for (const p of scene.props) {
    const holds = (p.holds ?? []).map((h) => `t${r1(h.t)} ${h.actorId ?? "set down"}`).join(", ");
    lines.push(`- ${p.id} "${p.name}" ${p.size} at (${r1(p.x)}, ${r1(p.y)}, ${r1(p.z)})${holds ? `; held: ${holds}` : ""}`);
  }
  if (!scene.props.length) lines.push("- none");
  const c = scene.camera;
  const k0 = c.keys[0];
  const k1 = c.keys[c.keys.length - 1];
  const s0 = sampleCamera(scene, 0);
  lines.push(
    `Camera: ${c.move} ${amountLabel(c.move, c.amount)}${c.move === "pan" || c.move === "orbit" || c.move === "track" ? ` ${c.direction}` : ""}, ease ${c.ease}, subject ${c.subjectId ?? "none"}${c.focus && c.focus !== "figure" ? ` (${c.focus})` : ""}; ${Math.round(k0.lens)}mm; start (${r1(k0.pos.x)}, ${r1(k0.pos.y)}, ${r1(k0.pos.z)}) → aim (${r1(k0.target.x)}, ${r1(k0.target.y)}, ${r1(k0.target.z)})${
      c.keys.length > 1 ? `; end (${r1(k1.pos.x)}, ${r1(k1.pos.y)}, ${r1(k1.pos.z)}) → aim (${r1(k1.target.x)}, ${r1(k1.target.y)}, ${r1(k1.target.z)})` : ""
    }; heading ${Math.round(s0.yaw)}°, tilt ${Math.round(s0.pitch)}°`,
  );
  lines.push(`Reads as: ${describeForPrompt(scene).camera}`);
  return lines.join("\n");
}
