import { z } from "zod";

/**
 * Blocking contract shared by Astra's commands, the grey camera view, the overhead plan,
 * captures and the Blender worker.
 *
 * Units: metres and seconds. Right-handed, Y up (three.js convention). The set's floor
 * centre is the origin. The back wall is at z = -depth/2; the open "fourth wall" faces +z.
 * On the overhead plan, up is -z (back wall at the top).
 * Facing is yaw in degrees: 0 faces +z (toward the default camera side), 90 faces +x;
 * direction = (sin yaw, cos yaw).
 * Lens is focal length in mm on a full-frame gate (36 × 24 mm):
 * usedH = min(24, 36 / aspect), vertical FOV = 2·atan(usedH / 2f).
 * Cameras are look-at with world-up; position and target are sampled on the same clock.
 * Times are seconds from the start of the shot.
 * Asset ids are the studio's asset ids, so a mannequin is always a specific approved cast
 * member and a prop block is always a specific approved prop.
 */

export const POSES = ["stand", "sit", "walk", "turn", "look", "reach"] as const;
export const Pose = z.enum(POSES);
export type Pose = z.infer<typeof Pose>;

export const FEATURE_KINDS = ["wall", "window", "door", "counter", "table", "chair", "shelf", "sofa", "plant", "bed", "desk", "block"] as const;
export const FeatureKind = z.enum(FEATURE_KINDS);
export type FeatureKind = z.infer<typeof FeatureKind>;

export const Feature = z.object({
  id: z.string(),
  kind: FeatureKind,
  label: z.string(),
  x: z.number(),
  z: z.number(),
  w: z.number(), // along x before rotation
  d: z.number(), // along z before rotation
  h: z.number(),
  rot: z.number().default(0), // degrees about Y
  /** Seat height for chairs/sofas, top surface for tables and counters. */
  surface: z.number().optional(),
  /** Height of the bottom edge above the floor (window sills, wall shelves). Default 0. */
  elev: z.number().optional(),
});
export type Feature = z.infer<typeof Feature>;

export const SetLayout = z.object({
  preset: z.string(),
  label: z.string(),
  width: z.number(),
  depth: z.number(),
  height: z.number(),
  exterior: z.boolean().default(false),
  features: z.array(Feature),
});
export type SetLayout = z.infer<typeof SetLayout>;

export const Mark = z.object({
  t: z.number(),
  x: z.number(),
  z: z.number(),
  facing: z.number(),
  pose: Pose,
});
export type Mark = z.infer<typeof Mark>;

export const Actor = z.object({
  id: z.string(), // character asset id
  name: z.string(),
  height: z.number().default(1.72),
  marks: z.array(Mark).min(1),
});
export type Actor = z.infer<typeof Actor>;

export const PropHold = z.object({ t: z.number(), actorId: z.string().nullable() });

export const PropPlacement = z.object({
  id: z.string(), // prop asset id
  name: z.string(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  size: z.enum(["small", "medium", "large"]),
  holds: z.array(PropHold).default([]),
  /** Yaw in degrees for props with a long axis (large props: the length runs along local x). */
  rot: z.number().optional(),
});
export type PropPlacement = z.infer<typeof PropPlacement>;

export const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3 = z.infer<typeof Vec3>;

export const CameraKey = z.object({ t: z.number(), pos: Vec3, target: Vec3, lens: z.number() });
export type CameraKey = z.infer<typeof CameraKey>;

export const CAMERA_MOVES = ["static", "push_in", "pull_out", "pan", "track", "orbit"] as const;
export const CameraMove = z.enum(CAMERA_MOVES);
export type CameraMove = z.infer<typeof CameraMove>;

export const Camera = z.object({
  move: CameraMove,
  amount: z.number(), // move-specific: fraction of distance, degrees, or metres
  direction: z.enum(["left", "right"]).default("right"),
  ease: z.enum(["linear", "gentle", "slow_in"]).default("gentle"),
  subjectId: z.string().nullable(),
  /**
   * What the frame is about: the figure (default), a figure's hands (a detail or hero with
   * no prop: the face is deliberately out of frame), or a prop.
   */
  focus: z.enum(["figure", "hands", "prop"]).optional(),
  keys: z.array(CameraKey).min(1).max(2),
});
export type Camera = z.infer<typeof Camera>;

export const Scene = z.object({
  shotId: z.string(),
  duration: z.number().min(1).max(15),
  aspect: z.enum(["16:9", "9:16"]),
  set: SetLayout,
  actors: z.array(Actor).max(3),
  props: z.array(PropPlacement).max(6),
  camera: Camera,
});
export type Scene = z.infer<typeof Scene>;

/* ---------- Astra's structured scene commands ---------- */

const Num = z.number().finite();
const Target = z.string().describe("an actor id, prop id, set feature id, or 'camera'");

export const SceneCommand = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("place_actor"),
    actor: z.string(),
    x: Num.optional(),
    z: Num.optional(),
    near: Target.optional(),
    facing: Num.optional(),
    pose: Pose.optional(),
  }),
  z.object({
    op: z.literal("move_actor"),
    actor: z.string(),
    to: z.object({ x: Num, z: Num }).optional(),
    toward: Target.optional(),
    from: Num.describe("start time, s"),
    until: Num.describe("end time, s"),
  }),
  z.object({ op: z.literal("set_pose"), actor: z.string(), pose: Pose, at: Num.default(0) }),
  z.object({ op: z.literal("face"), actor: z.string(), toward: Target.optional(), facing: Num.optional(), at: Num.default(0) }),
  z.object({ op: z.literal("place_prop"), prop: z.string(), x: Num.optional(), z: Num.optional(), on: z.string().optional() }),
  z.object({ op: z.literal("hand_prop"), prop: z.string(), actor: z.string().nullable(), at: Num }),
  z.object({
    op: z.literal("frame"),
    framing: z.enum(["wide", "medium", "close", "detail", "hero", "ots", "pov"]),
    subject: z.string().optional(),
    side: z.enum(["front", "left", "right", "behind_left", "behind_right"]).optional(),
    height: z.enum(["eye", "low", "high", "overhead"]).optional(),
  }),
  z.object({
    op: z.literal("camera_move"),
    move: CameraMove,
    amount: Num.optional(),
    direction: z.enum(["left", "right"]).optional(),
    ease: z.enum(["linear", "gentle", "slow_in"]).optional(),
  }),
  z.object({ op: z.literal("set_lens"), mm: Num }),
  z.object({ op: z.literal("set_camera_height"), meters: Num }),
  z.object({ op: z.literal("set_duration"), seconds: Num }),
]);
export type SceneCommand = z.infer<typeof SceneCommand>;

/** Poses, moves and limits Astra may use. Anything outside belongs to the full pipeline. */
export const BLOCKING_LIMITS = {
  lensMin: 18,
  lensMax: 135,
  cameraHeightMin: 0.25,
  cameraHeightMax: 3.2,
  pushMax: 0.6, // fraction of camera→subject distance
  panMax: 60, // degrees
  orbitMax: 90, // degrees
  trackMax: 3, // metres
  actorMargin: 0.25,
  fourthWall: 3.5, // how far past the open side the camera may stand
} as const;
