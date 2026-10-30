/**
 * Deterministic checks for the blocking module. No network, no browser.
 * Run from the project root:
 *   pnpm exec tsx scripts/check-blocking.ts
 */
import type { Scene, SceneCommand } from "../lib/blocking/types";
import { Scene as SceneSchema } from "../lib/blocking/types";
import { autoBlock } from "../lib/blocking/auto";
import { applyCommands, validateScene } from "../lib/blocking/commands";
import { describeForAgent, describeForPrompt } from "../lib/blocking/describe";
import { aspectNumber, lensMmToFovDeg } from "../lib/blocking/lens";
import { sampleCamera, sampleSceneAt, scenePaths } from "../lib/blocking/sample";
import { buildSet, featureById, setPresetFor, SET_PRESET_IDS } from "../lib/blocking/sets";
import { ensureInFrame, framingIssues, startFramingIssues } from "../lib/blocking/visibility";
import { eyePoint, inFrame, project, propCenter } from "../lib/blocking/project";
import { handsPoint } from "../lib/blocking/framing";
import { lensObstruction } from "../lib/blocking/sets";
import { dist } from "../lib/blocking/vec";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const CAST = [
  { id: "char_mara", name: "Mara", height: 1.68 },
  { id: "char_sam", name: "Sam", height: 1.8 },
];
const PROPS = [{ id: "prop_cup", name: "cup", size: "small" as const }];

function block(over: Partial<Parameters<typeof autoBlock>[0]> = {}): Scene {
  return autoBlock({
    shotId: "shot_test",
    duration: 8,
    aspect: "16:9",
    framing: "medium",
    move: "push_in",
    lens: 35,
    action: "Mara sits by the window with a cup",
    description: "A quiet moment",
    set: buildSet("cafe"),
    characters: [CAST[0]],
    props: PROPS,
    speakerId: null,
    ...over,
  });
}

/* ---- lens ---- */
check("lens: 16:9 uses 20.25 mm of the gate", near(lensMmToFovDeg(35, 16 / 9), (2 * Math.atan(20.25 / 70) * 180) / Math.PI, 1e-9));
check("lens: 9:16 uses the full 24 mm height", near(lensMmToFovDeg(35, 9 / 16), (2 * Math.atan(24 / 70) * 180) / Math.PI, 1e-9));
check("lens: aspectNumber", near(aspectNumber("9:16"), 0.5625));

/* ---- sampler ---- */
const base = block();
check("autoBlock output parses as a Scene", SceneSchema.safeParse(base).success);
const k0 = base.camera.keys[0];
const k1 = base.camera.keys[base.camera.keys.length - 1];
const c0 = sampleCamera(base, 0);
const c1 = sampleCamera(base, base.duration);
check("sampler hits the first camera key at t=0", dist(c0.pos, k0.pos) < 1e-9 && dist(c0.target, k0.target) < 1e-9);
check("sampler hits the last camera key at t=duration", dist(c1.pos, k1.pos) < 1e-9 && dist(c1.target, k1.target) < 1e-9);
check("push-in moves the camera toward its subject", dist(c1.pos, c1.target) < dist(c0.pos, c0.target));
const mid = sampleSceneAt(base, 3.3);
const paths = scenePaths(base);
check("overhead and camera read one pose (same sampler)", dist(mid.camera.pos, sampleCamera(base, 3.3).pos) < 1e-12);
check("camera path starts and ends on the keys", dist(paths.camera[0], k0.pos) < 1e-9 && dist(paths.camera[paths.camera.length - 1], k1.pos) < 1e-9);

// Orbit stays on its circle; pan keeps its position.
const orbit = block({ move: "orbit" });
if (orbit.camera.move === "orbit") {
  const o0 = sampleCamera(orbit, 0);
  const oM = sampleCamera(orbit, orbit.duration / 2);
  const o1 = sampleCamera(orbit, orbit.duration);
  const r0 = Math.hypot(o0.pos.x - o0.target.x, o0.pos.z - o0.target.z);
  const rM = Math.hypot(oM.pos.x - oM.target.x, oM.pos.z - oM.target.z);
  const chordMid = Math.hypot((o0.pos.x + o1.pos.x) / 2 - o0.target.x, (o0.pos.z + o1.pos.z) / 2 - o0.target.z);
  // Keys are stored to the centimetre, so the radius is constant to ~1 cm; a chord would cut well inside.
  check("orbit rides the circle, not the chord", Math.abs(r0 - rM) < 0.01 && rM - chordMid > 0.02, `${r0} vs ${rM} (chord ${chordMid})`);
}
const pan = block({ move: "pan" });
if (pan.camera.move === "pan") {
  check("pan holds position", dist(sampleCamera(pan, 0).pos, sampleCamera(pan, pan.duration).pos) < 1e-9);
  check("pan turns the head", Math.abs(sampleCamera(pan, 0).yaw - sampleCamera(pan, pan.duration).yaw) > 5);
}

/* ---- auto blocking across presets, framings and moves ---- */
const framings = ["wide", "medium", "close", "detail", "hero", "ots", "pov"] as const;
const moves = ["static", "push_in", "pull_out", "pan", "track", "orbit"] as const;
for (const preset of ["cafe", "office", "living_room", "street"]) {
  for (const framing of framings) {
    for (const move of moves) {
      const scene = autoBlock({
        shotId: `s_${preset}_${framing}_${move}`,
        duration: 6,
        aspect: preset === "office" ? "9:16" : "16:9",
        framing,
        move,
        lens: framing === "close" ? 50 : framing === "wide" ? 24 : 35,
        action: framing === "wide" ? "Mara enters and walks to the table" : "Mara sits at the table holding a cup while Sam listens",
        description: "",
        set: buildSet(preset),
        characters: CAST,
        props: PROPS,
        speakerId: "char_mara",
      });
      const issues = validateScene(scene);
      check(`autoBlock ${preset}/${framing}/${move} is valid`, issues.length === 0, issues.join("; "));
    }
  }
}
check("deterministic: same input, same scene", JSON.stringify(block()) === JSON.stringify(block()));
check("sit by window anchors near the window", (() => {
  const m = base.actors[0].marks[0];
  const w = featureById(base.set, "window-1")!;
  return m.pose === "sit" && Math.hypot(m.x - w.x, m.z - w.z) < 2.5;
})());
check("held prop rides the hand", sampleSceneAt(base, 1).props[0].heldBy === "char_mara");
check("entrance walks", (() => {
  const s = block({ framing: "wide", action: "Mara enters and walks to the counter" });
  const pts = scenePaths(s).actors[0].points;
  return Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) > 1;
})());
check("setPresetFor matches settings", setPresetFor("A busy neighbourhood coffee shop") === "cafe" && setPresetFor("yoga studio at dawn") === "gym" && setPresetFor("product on a seamless backdrop") === "studio_tabletop" && setPresetFor("somewhere") === "generic_interior");
check("every preset builds", SET_PRESET_IDS.every((id) => buildSet(id).features.length > 2));

/* ---- commands ---- */
function apply(scene: Scene, cmds: unknown[]) {
  return applyCommands(scene, cmds as SceneCommand[]);
}
const out = apply(base, [{ op: "place_actor", actor: "char_mara", x: 40, z: 0 }]);
check("out-of-bounds placement is rejected", out.errors.length === 1 && out.scene.actors[0].marks[0].x === base.actors[0].marks[0].x, out.errors.join(" | "));
const dance = apply(base, [{ op: "set_pose", actor: "char_mara", pose: "dance", at: 0 }]);
check("unsupported pose is rejected", dance.errors.length === 1 && /isn't supported/.test(dance.errors[0]), dance.errors.join(" | "));
const unknown = apply(base, [{ op: "place_actor", actor: "nobody", x: 0, z: 0 }]);
check("unknown actor is rejected", unknown.errors.length === 1 && /unknown actor/.test(unknown.errors[0]));
const bigPush = apply(base, [{ op: "camera_move", move: "push_in", amount: 2 }]);
check("push-in amount clamped to the fast-lane limit", bigPush.scene.camera.amount <= 0.6 + 1e-9 && bigPush.errors.length === 0, `${bigPush.scene.camera.amount} ${bigPush.errors.join(" | ")}`);
const slower = apply(base, [{ op: "camera_move", move: "push_in", amount: 0.12, ease: "gentle" }]);
check("a gentler push moves less", dist(sampleCamera(slower.scene, 8).pos, sampleCamera(slower.scene, 0).pos) < dist(c1.pos, c0.pos), slower.errors.join(" | "));
const longer = apply(base, [{ op: "set_duration", seconds: 12 }]);
check("set_duration rescales the move", longer.scene.duration === 12 && longer.scene.camera.keys[longer.scene.camera.keys.length - 1].t === 12);
check("set_duration rescales holds", longer.scene.props[0].holds.every((h, i) => near(h.t, base.props[0].holds[i].t * 1.5, 0.011)));
const standing = apply(base, [{ op: "set_pose", actor: "char_mara", pose: "stand", at: 0 }]);
const byWindow = apply(standing.scene, [{ op: "place_actor", actor: "char_mara", near: "window-1" }]);
const w1 = featureById(base.set, "window-1")!;
const m0 = byWindow.scene.actors[0].marks[0];
check("near-window placement lands by the window", byWindow.errors.length === 0 && Math.hypot(m0.x - w1.x, m0.z - w1.z) < 1.0, `${byWindow.errors.join(" | ")} (${m0.x}, ${m0.z})`);
const sitNoSeat = apply(standing.scene, [{ op: "place_actor", actor: "char_mara", x: 0, z: 2.5, pose: "sit" }]);
check("sitting where there is no seat is rejected", sitNoSeat.errors.length === 1, sitNoSeat.errors.join(" | "));
const tooFast = apply(standing.scene, [{ op: "move_actor", actor: "char_mara", to: { x: 3, z: 2 }, from: 0, until: 0.6 }]);
check("a run is rejected (walking only)", tooFast.errors.length === 1, tooFast.errors.join(" | "));
const walk = apply(standing.scene, [{ op: "move_actor", actor: "char_mara", toward: "counter-1", from: 1, until: 5 }]);
check("walk to the counter is accepted", walk.errors.length === 0 && sampleSceneAt(walk.scene, 3).actors[0].moving, walk.errors.join(" | "));
const framed = apply(base, [{ op: "frame", framing: "close", subject: "char_mara" }]);
check("frame re-solves the camera closer", framed.errors.length === 0 && dist(sampleCamera(framed.scene, 0).pos, sampleCamera(framed.scene, 0).target) < dist(c0.pos, c0.target), framed.errors.join(" | "));
const lens85 = apply(base, [{ op: "set_lens", mm: 85 }]);
check("a longer lens keeps framing by moving the camera back (or says why not)", lens85.errors.length === 0 ? dist(lens85.scene.camera.keys[0].pos, lens85.scene.camera.keys[0].target) > dist(k0.pos, k0.target) : true, lens85.errors.join(" | "));
const badLens = apply(base, [{ op: "set_lens", mm: 300 }]);
check("unsupported lens is rejected", badLens.errors.length === 1);
const seq = apply(standing.scene, [{ op: "place_actor", actor: "char_mara", near: "window-1" }, { op: "face", actor: "char_mara", toward: "camera", at: 0 }, { op: "camera_move", move: "push_in", amount: 0.15 }]);
check("a command sequence applies in order", seq.errors.length === 0 && seq.changes.length >= 3, seq.errors.join(" | "));

/* ---- words ---- */
const words = describeForPrompt(base);
check("prompt description names the lens and the move", /35mm/.test(words.camera) && /push-in/.test(words.camera), words.camera);
check("staging mentions the cast", /Mara/.test(words.staging), words.staging);
check("agent read-out lists ids", /char_mara/.test(describeForAgent(base)) && /window-1/.test(describeForAgent(base)));


/* ---- first frame: everyone on screen is in it ---- */
{
  // The live failure: "Customer Steps In" — medium, static, 50 mm, shop; the camera framed
  // the END mark, so at t=0 the customer was ~31° off-axis and the capture showed a wall.
  const customer = { id: "char_customer", name: "Customer", height: 1.72 };
  const live = autoBlock({ shotId: "shot_customer", duration: 4, aspect: "16:9", framing: "medium", move: "static", lens: 50, action: "A customer steps in", description: "", set: buildSet("shop"), characters: [customer], props: [] });
  live.actors[0].marks = [
    { t: 0, x: 1.8, z: -0.2, facing: -105, pose: "stand" },
    { t: 1.6, x: 0, z: -0.6, facing: 0, pose: "stand" },
  ];
  live.camera = { ...live.camera, move: "static", amount: 0, keys: [{ t: 0, pos: { x: 2.25, y: 1.44, z: 1.65 }, target: { x: 0, y: 1.25, z: -0.6 }, lens: 50 }] };
  check("live repro: customer out of frame at t=0 is reported", startFramingIssues(live).some((i) => /Customer is out of frame at the start/.test(i)), startFramingIssues(live).join("; "));
  check("live repro: validateScene includes it", validateScene(live).some((i) => /out of frame at the start/.test(i)));
  const fixed = ensureInFrame(live);
  check("live repro: ensureInFrame holds the whole walk", fixed.ok && framingIssues(fixed.scene).length === 0, `${fixed.notes.join(" | ")} ${framingIssues(fixed.scene).join("; ")}`);
  check("live repro: the fix keeps the 50mm or says it widened", fixed.notes.length > 0);

  // Entering walks on the shop and café sets, every framing and move: in frame at t=0, and a
  // static camera holds the walk from start to end.
  for (const preset of ["shop", "cafe"]) {
    for (const framing of ["wide", "medium", "close"] as const) {
      for (const move of ["static", "push_in", "pull_out", "pan", "track", "orbit"] as const) {
        for (const aspect of ["16:9", "9:16"] as const) {
          const s = autoBlock({ shotId: `enter_${preset}_${framing}_${move}_${aspect}`, duration: 5, aspect, framing, move, lens: framing === "close" ? 50 : 35, action: "A customer steps in and walks to the counter", description: "", set: buildSet(preset), characters: [customer], props: [] });
          const start = startFramingIssues(s);
          const whole = s.camera.move === "static" ? framingIssues(s) : start;
          check(`entering walk ${preset}/${framing}/${move}/${aspect} is in frame`, whole.length === 0, whole.join("; "));
          const k = s.camera.keys[0];
          const plant = lensObstruction(s.set, k.pos, k.target);
          check(`entering walk ${preset}/${framing}/${move}/${aspect} has a clear lens`, !plant, plant?.label ?? "");
        }
      }
    }
  }

  // A command that walks someone out of shot moves the camera to keep them (or is refused).
  const walkOut = apply(base, [{ op: "move_actor", actor: "char_mara", to: { x: 3.5, z: 2.5 }, from: 1, until: 4 }]);
  check("a walk out of shot is held or refused, never left out of frame", validateScene(walkOut.scene).length === 0, `${walkOut.errors.join(" | ")} ${validateScene(walkOut.scene).join("; ")}`);
}

/* ---- lens clearance across all auto blocking ---- */
for (const preset of ["shop", "cafe", "office", "living_room"]) {
  for (const framing of ["wide", "medium", "close"] as const) {
    const s = autoBlock({ shotId: `lens_${preset}_${framing}`, duration: 5, aspect: "16:9", framing, move: "static", lens: 35, action: "Mara stands by the window", description: "", set: buildSet(preset), characters: [CAST[0]], props: [] });
    const k = s.camera.keys[0];
    const o = lensObstruction(s.set, k.pos, k.target);
    check(`no furniture crowding the lens: ${preset}/${framing}`, !o, o?.label ?? "");
  }
}

/* ---- props by size ---- */
{
  const bike = { id: "prop_bike", name: "bicycle", size: "large" as const };
  const box = { id: "prop_box", name: "gift box", size: "medium" as const };
  const wheeled = autoBlock({ shotId: "bike_in", duration: 6, aspect: "16:9", framing: "wide", move: "static", lens: 24, action: "Mara wheels her bicycle in", description: "", set: buildSet("shop"), characters: [CAST[0]], props: [bike] });
  const mid = sampleSceneAt(wheeled, 2);
  const b = mid.props[0];
  check("large prop stands on the floor", b.y === 0 && wheeled.props[0].y === 0);
  check("a walked large prop stays beside its walker, not in the hand", b.heldBy === "char_mara" && Math.abs(Math.hypot(b.x - mid.actors[0].x, b.z - mid.actors[0].z) - 0.55 * (1.68 / 1.82)) < 0.05);
  check("words: walks beside the bicycle", /walks beside the bicycle/.test(describeForPrompt(wheeled).staging), describeForPrompt(wheeled).staging);
  const resting = autoBlock({ shotId: "bike_rest", duration: 5, aspect: "16:9", framing: "medium", move: "static", lens: 35, action: "Mara stands at the counter", description: "", set: buildSet("shop"), characters: [CAST[0]], props: [bike, box] });
  check("a resting large prop is on the floor, not on a surface", resting.props[0].y === 0 && resting.props[0].holds.length === 0);
  check("a medium prop rests on a surface", resting.props[1].y > 0.5);
  const onTable = apply(resting, [{ op: "place_prop", prop: "prop_bike", on: "table-1" }]);
  check("a large prop can't be put on a table", onTable.errors.length === 1 && /too large/.test(onTable.errors[0]), onTable.errors.join(" | "));
}

/* ---- detail and hero: the prop centred, no face taking over ---- */
for (const framing of ["detail", "hero"] as const) {
  for (const action of ["Mara sits at the window table, the cup in front of her", "Mara sits by the window holding a cup"]) {
    const s = autoBlock({ shotId: `prop_${framing}_${action.length}`, duration: 5, aspect: "16:9", framing, move: "static", lens: 50, action, description: "", set: buildSet("cafe"), characters: [CAST[0]], props: PROPS });
    const smp = sampleSceneAt(s, 0);
    const q = project(smp.camera, propCenter(smp.props[0]));
    check(`${framing}: the prop is centred (${action.slice(0, 28)}…)`, !!q && Math.abs(q.x) < 0.2 && Math.abs(q.y) < 0.2, JSON.stringify(q));
    const d = Math.hypot(smp.camera.pos.x - smp.props[0].x, smp.camera.pos.z - smp.props[0].z);
    const head = project(smp.camera, eyePoint(smp.actors[0]));
    const crowds = !!head && Math.abs(head.x) <= 1 && Math.abs(head.y) <= 1 && head.depth < d + 0.9;
    check(`${framing}: no head crowding the prop (${action.slice(0, 28)}…)`, !crowds, JSON.stringify(head));
  }
}


/* ---- detail / hero with no prop: the hands, never the face ---- */
for (const framing of ["detail", "hero"] as const) {
  for (const [preset, action] of [
    ["park", "She presses the stems into the cold soil"],
    ["cafe", "Mara sits by the window, hands around nothing, waiting"],
  ] as const) {
    for (const move of ["static", "push_in"] as const) {
      const s = autoBlock({ shotId: `hands_${framing}_${preset}_${move}`, duration: 5, aspect: "9:16", framing, move, lens: 50, action, description: "Stems and Cold Soil", set: buildSet(preset), characters: [CAST[0]], props: [] });
      const label = `${framing} without a prop (${preset}, ${move})`;
      check(`${label} focuses on the hands`, s.camera.focus === "hands" && s.camera.subjectId === "char_mara");
      for (const t of move === "static" ? [0] : [0, s.duration]) {
        const smp = sampleSceneAt(s, t);
        const hands = project(smp.camera, handsPoint(smp.actors[0], s.set));
        check(`${label}: hands near centre at ${t}s`, !!hands && Math.abs(hands.x) < 0.45 && Math.abs(hands.y) < 0.45, JSON.stringify(hands));
        check(`${label}: face out of frame at ${t}s`, !inFrame(smp.camera, eyePoint(smp.actors[0])), JSON.stringify(project(smp.camera, eyePoint(smp.actors[0]))));
      }
      check(`${label} is valid`, validateScene(s).length === 0, validateScene(s).join("; "));
      check(`${label}: words say hands`, /hands, face out of frame/.test(describeForPrompt(s).camera), describeForPrompt(s).camera);
    }
  }
}

console.log(`\nblocking checks: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("\nSample read-outs:");
console.log(`  camera:  ${words.camera}`);
console.log(`  staging: ${words.staging}`);
