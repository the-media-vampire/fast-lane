import type { Feature, FeatureKind, SetLayout } from "./types";
import { headingDeg, rad } from "./vec";

/**
 * Coarse set layouts for blocking. A location asset maps to one preset; the preset gives
 * the room's size, its openings and the furniture actors use as anchors. Ids are stable
 * ("window-1", "table-1") so Astra's commands and the overhead labels stay meaningful
 * across revisions. Interiors have a back wall at z = −depth/2 and side walls at
 * x = ±width/2; the +z side is open for the camera. Exteriors have no walls.
 */

type Opts = { rot?: number; surface?: number; elev?: number };

function f(id: string, kind: FeatureKind, label: string, x: number, z: number, w: number, d: number, h: number, o: Opts = {}): Feature {
  const feature: Feature = { id, kind, label, x, z, w, d, h, rot: o.rot ?? 0 };
  if (o.surface !== undefined) feature.surface = o.surface;
  if (o.elev !== undefined) feature.elev = o.elev;
  return feature;
}

/** A chair at (x, z) turned to face a point (its seat front is local +z). */
function chairFacing(id: string, label: string, x: number, z: number, toward: { x: number; z: number }, size = 0.46, seat = 0.46): Feature {
  return f(id, "chair", label, x, z, size, size, seat > 0.6 ? seat : 0.9, { rot: Math.round(headingDeg(toward.x - x, toward.z - z)), surface: seat });
}

const PRESETS: Record<string, SetLayout> = {
  cafe: {
    preset: "cafe",
    label: "Café",
    width: 9,
    depth: 7,
    height: 3.4,
    exterior: false,
    features: [
      f("window-1", "window", "Window", -2.2, -3.44, 3.0, 0.12, 2.2, { elev: 0.45 }),
      f("window-2", "window", "Side window", -4.44, -0.8, 2.4, 0.12, 2.0, { rot: 90, elev: 0.6 }),
      f("door-1", "door", "Door", 2.9, -3.44, 1.1, 0.12, 2.3),
      f("counter-1", "counter", "Counter", 3.3, 0.2, 0.8, 3.6, 1.05, { surface: 1.05 }),
      f("shelf-1", "shelf", "Back shelf", 4.25, 0.2, 0.4, 3.0, 2.2),
      f("table-1", "table", "Window table", -2.2, -2.2, 0.8, 0.8, 0.75, { surface: 0.75 }),
      chairFacing("chair-1", "Chair", -2.2, -1.55, { x: -2.2, z: -2.2 }),
      chairFacing("chair-2", "Chair", -2.2, -2.85, { x: -2.2, z: -2.2 }),
      f("table-2", "table", "Table", -0.4, 0.4, 0.8, 0.8, 0.75, { surface: 0.75 }),
      chairFacing("chair-3", "Chair", -1.05, 0.4, { x: -0.4, z: 0.4 }),
      chairFacing("chair-4", "Chair", 0.25, 0.4, { x: -0.4, z: 0.4 }),
      f("plant-1", "plant", "Plant", -4.0, -3.0, 0.6, 0.6, 1.4),
    ],
  },
  kitchen: {
    preset: "kitchen",
    label: "Kitchen",
    width: 5.5,
    depth: 4.5,
    height: 2.8,
    exterior: false,
    features: [
      f("counter-1", "counter", "Counter", 0, -1.94, 4.2, 0.62, 0.92, { surface: 0.92 }),
      f("window-1", "window", "Window", 0.6, -2.19, 1.6, 0.1, 1.1, { elev: 1.1 }),
      f("counter-2", "counter", "Island", 0.3, -0.1, 1.8, 0.9, 0.92, { surface: 0.92 }),
      f("shelf-1", "shelf", "Fridge", -2.35, -1.6, 0.75, 0.7, 1.9),
      f("door-1", "door", "Door", -2.7, 0.9, 0.9, 0.1, 2.1, { rot: 90 }),
      f("table-1", "table", "Small table", 1.9, 1.1, 0.8, 0.8, 0.75, { surface: 0.75 }),
      chairFacing("chair-1", "Chair", 1.25, 1.1, { x: 1.9, z: 1.1 }),
    ],
  },
  living_room: {
    preset: "living_room",
    label: "Living room",
    width: 6.5,
    depth: 5.5,
    height: 2.8,
    exterior: false,
    features: [
      f("window-1", "window", "Window", -0.8, -2.69, 2.6, 0.1, 1.7, { elev: 0.6 }),
      f("sofa-1", "sofa", "Sofa", -0.5, -1.4, 2.2, 0.9, 0.85, { surface: 0.45 }),
      f("table-1", "table", "Coffee table", -0.5, -0.2, 1.1, 0.6, 0.42, { surface: 0.42 }),
      chairFacing("chair-1", "Armchair", 1.7, -0.5, { x: -0.5, z: -0.2 }, 0.85),
      f("shelf-1", "shelf", "Bookshelf", 3.05, -1.0, 0.35, 1.8, 2.0),
      f("door-1", "door", "Door", 3.2, 1.4, 0.9, 0.1, 2.1, { rot: 90 }),
      f("plant-1", "plant", "Plant", -2.8, -2.3, 0.6, 0.6, 1.3),
    ],
  },
  office: {
    preset: "office",
    label: "Office",
    width: 8,
    depth: 6.5,
    height: 3,
    exterior: false,
    features: [
      f("window-1", "window", "Window", -2, -3.19, 3, 0.1, 1.8, { elev: 0.7 }),
      f("window-2", "window", "Window", 2, -3.19, 3, 0.1, 1.8, { elev: 0.7 }),
      f("desk-1", "desk", "Desk", -2, -1.6, 1.6, 0.8, 0.75, { surface: 0.75 }),
      chairFacing("chair-1", "Desk chair", -2, -2.3, { x: -2, z: -1.6 }, 0.55),
      f("desk-2", "desk", "Desk", 2, -1.6, 1.6, 0.8, 0.75, { surface: 0.75 }),
      chairFacing("chair-2", "Desk chair", 2, -2.3, { x: 2, z: -1.6 }, 0.55),
      f("table-1", "table", "Meeting table", 0, 1.0, 2.2, 1.0, 0.75, { surface: 0.75 }),
      chairFacing("chair-3", "Chair", -0.6, 0.2, { x: -0.6, z: 1.0 }),
      chairFacing("chair-4", "Chair", 0.6, 0.2, { x: 0.6, z: 1.0 }),
      f("shelf-1", "shelf", "Shelving", -3.78, 0.5, 0.4, 2.0, 2.0),
      f("door-1", "door", "Door", 3.95, 1.5, 1.0, 0.1, 2.2, { rot: 90 }),
      f("plant-1", "plant", "Plant", 3.4, -2.7, 0.6, 0.6, 1.5),
    ],
  },
  shop: {
    preset: "shop",
    label: "Shop",
    width: 8,
    depth: 6,
    height: 3.2,
    exterior: false,
    features: [
      f("window-1", "window", "Shop window", -3.94, -0.5, 3.0, 0.12, 2.2, { rot: 90, elev: 0.4 }),
      f("door-1", "door", "Door", -3.94, 1.9, 1.2, 0.12, 2.4, { rot: 90 }),
      f("counter-1", "counter", "Counter", 2.4, -1.6, 2.0, 0.7, 1.0, { surface: 1.0 }),
      f("shelf-1", "shelf", "Shelves", -1.5, -2.75, 3.0, 0.45, 2.2),
      f("shelf-2", "shelf", "Shelves", 3.75, 0.6, 0.45, 2.4, 2.0),
      f("table-1", "table", "Display table", -0.6, 0.3, 1.4, 0.9, 0.85, { surface: 0.85 }),
      f("plant-1", "plant", "Plant", -3.4, -2.5, 0.6, 0.6, 1.5),
    ],
  },
  bar: {
    preset: "bar",
    label: "Bar",
    width: 8,
    depth: 6.5,
    height: 3.2,
    exterior: false,
    features: [
      f("counter-1", "counter", "Bar", 0.5, -1.8, 4.6, 0.7, 1.1, { surface: 1.1 }),
      f("shelf-1", "shelf", "Back bar", 0.5, -3.0, 4.6, 0.4, 2.2),
      chairFacing("chair-1", "Stool", -1.2, -1.05, { x: -1.2, z: -1.8 }, 0.4, 0.75),
      chairFacing("chair-2", "Stool", 0.5, -1.05, { x: 0.5, z: -1.8 }, 0.4, 0.75),
      chairFacing("chair-3", "Stool", 2.2, -1.05, { x: 2.2, z: -1.8 }, 0.4, 0.75),
      f("table-1", "table", "Table", -2.6, 1.2, 0.8, 0.8, 0.75, { surface: 0.75 }),
      chairFacing("chair-4", "Chair", -3.25, 1.2, { x: -2.6, z: 1.2 }),
      chairFacing("chair-5", "Chair", -1.95, 1.2, { x: -2.6, z: 1.2 }),
      f("sofa-1", "sofa", "Booth", 3.4, 0.9, 2.0, 0.8, 1.0, { rot: -90, surface: 0.45 }),
      f("window-1", "window", "Window", -3.94, -1.0, 1.6, 0.12, 1.3, { rot: 90, elev: 1.0 }),
      f("door-1", "door", "Door", -3.0, -3.19, 1.0, 0.12, 2.3),
    ],
  },
  bedroom: {
    preset: "bedroom",
    label: "Bedroom",
    width: 5,
    depth: 4.5,
    height: 2.7,
    exterior: false,
    features: [
      f("bed-1", "bed", "Bed", -0.4, -1.1, 1.6, 2.0, 0.55, { surface: 0.55 }),
      f("table-1", "table", "Nightstand", 0.75, -1.85, 0.45, 0.4, 0.55, { surface: 0.55 }),
      f("window-1", "window", "Window", -2.44, -0.6, 1.5, 0.1, 1.4, { rot: 90, elev: 0.8 }),
      f("desk-1", "desk", "Desk", 2.15, 0.4, 0.6, 1.2, 0.75, { surface: 0.75 }),
      chairFacing("chair-1", "Chair", 1.5, 0.4, { x: 2.15, z: 0.4 }),
      f("shelf-1", "shelf", "Wardrobe", 1.6, -1.95, 1.2, 0.55, 2.1),
      f("door-1", "door", "Door", 2.44, 1.6, 0.9, 0.1, 2.1, { rot: 90 }),
    ],
  },
  gym: {
    preset: "gym",
    label: "Gym",
    width: 12,
    depth: 9,
    height: 4.5,
    exterior: false,
    features: [
      f("window-1", "window", "Window", -2.5, -4.44, 5, 0.12, 2, { elev: 1.2 }),
      f("window-2", "window", "Side window", -5.94, 0, 3, 0.12, 2, { rot: 90, elev: 1.2 }),
      f("block-1", "block", "Squat rack", -3.2, -2.4, 1.4, 1.2, 2.3),
      f("block-2", "block", "Bench", -0.6, -0.2, 0.4, 1.3, 0.45, { surface: 0.45 }),
      f("block-3", "block", "Treadmill", 3.5, -3.0, 0.9, 2.0, 1.4),
      f("block-4", "block", "Treadmill", 4.8, -3.0, 0.9, 2.0, 1.4),
      f("shelf-1", "shelf", "Dumbbell rack", 5.6, 0.5, 0.6, 2.8, 1.0, { surface: 1.0 }),
      f("block-5", "block", "Mat", 1.2, 1.6, 2.2, 1.4, 0.04, { surface: 0.04 }),
      f("door-1", "door", "Door", 5.94, 3.0, 1.2, 0.12, 2.4, { rot: 90 }),
    ],
  },
  street: {
    preset: "street",
    label: "Street",
    width: 14,
    depth: 10,
    height: 8,
    exterior: true,
    features: [
      f("block-1", "block", "Building facade", 0, -4.6, 14, 0.8, 7),
      f("window-1", "window", "Storefront", -3.0, -4.16, 3.5, 0.1, 2.4, { elev: 0.5 }),
      f("door-1", "door", "Shop door", 0.2, -4.16, 1.2, 0.1, 2.4),
      f("window-2", "window", "Window", 3.6, -4.16, 3.0, 0.1, 2.2, { elev: 0.6 }),
      f("table-1", "table", "Terrace table", -3.0, -2.6, 0.7, 0.7, 0.75, { surface: 0.75 }),
      chairFacing("chair-1", "Chair", -3.6, -2.6, { x: -3.0, z: -2.6 }),
      chairFacing("chair-2", "Chair", -2.4, -2.6, { x: -3.0, z: -2.6 }),
      f("plant-1", "plant", "Tree", 4.8, -1.8, 1.8, 1.8, 4.5),
      f("block-2", "block", "Bench", 2.0, -3.3, 1.6, 0.5, 0.45, { surface: 0.45 }),
      f("block-3", "block", "Kerb", 0, 1.5, 14, 0.3, 0.15),
    ],
  },
  park: {
    preset: "park",
    label: "Park",
    width: 16,
    depth: 12,
    height: 8,
    exterior: true,
    features: [
      f("plant-1", "plant", "Tree", -4.5, -3.5, 2.6, 2.6, 6),
      f("plant-2", "plant", "Tree", 4.0, -4.2, 2.8, 2.8, 7),
      f("plant-3", "plant", "Tree", 6.0, 1.0, 2.2, 2.2, 5),
      f("block-1", "block", "Bench", -1.2, -1.8, 1.8, 0.6, 0.45, { surface: 0.45 }),
      f("table-1", "table", "Picnic table", 2.2, 0.3, 1.8, 0.8, 0.75, { surface: 0.75 }),
      f("block-2", "block", "Path", 0, 0.8, 16, 1.6, 0.02, { surface: 0.02 }),
      f("block-3", "block", "Lamp post", 0.6, -2.4, 0.2, 0.2, 3.5),
    ],
  },
  studio_tabletop: {
    preset: "studio_tabletop",
    label: "Tabletop studio",
    width: 4.5,
    depth: 4,
    height: 3,
    exterior: false,
    features: [
      f("block-1", "block", "Backdrop", 0, -1.8, 4, 0.3, 2.6),
      f("table-1", "table", "Product table", 0, -0.4, 1.2, 0.8, 0.8, { surface: 0.8 }),
      f("block-2", "block", "Light stand", -1.6, 0.4, 0.3, 0.3, 2.2),
      f("window-1", "window", "Softbox", 1.55, -0.2, 0.9, 0.2, 1.2, { rot: -60, elev: 1.0 }),
    ],
  },
  generic_interior: {
    preset: "generic_interior",
    label: "Interior",
    width: 6,
    depth: 5,
    height: 3,
    exterior: false,
    features: [
      f("window-1", "window", "Window", -1.2, -2.44, 2.0, 0.1, 1.6, { elev: 0.8 }),
      f("door-1", "door", "Door", 2.94, 1.2, 0.9, 0.1, 2.1, { rot: 90 }),
      f("table-1", "table", "Table", 0, -0.6, 1.2, 0.8, 0.75, { surface: 0.75 }),
      chairFacing("chair-1", "Chair", -0.85, -0.6, { x: 0, z: -0.6 }),
      chairFacing("chair-2", "Chair", 0.85, -0.6, { x: 0, z: -0.6 }),
      f("shelf-1", "shelf", "Shelves", -2.78, -0.5, 0.4, 1.6, 2.0),
    ],
  },
};

export const SET_PRESETS: Readonly<Record<string, SetLayout>> = PRESETS;
export const SET_PRESET_IDS = Object.keys(PRESETS);

/** Ordered: the more specific settings win ("coffee shop" is a café, "yoga studio" a gym). */
const MATCHERS: [string, RegExp][] = [
  ["studio_tabletop", /tabletop|table-top|packshot|pack shot|product (shot|table|studio)|seamless|photo studio|white studio|backdrop/],
  ["cafe", /caf[eé]|coffee|espresso|bakery|patisserie|tea ?room|tea ?house|diner|brunch|roaster/],
  ["bar", /\bbar\b|\bpub\b|tavern|cocktail|wine bar|brewery|speakeasy/],
  ["kitchen", /kitchen|stove|\bcook/],
  ["bedroom", /bedroom|hotel room|\bdorm/],
  ["office", /office|workspace|co-?working|agency|start-?up|meeting room|boardroom|\bdesk\b/],
  ["gym", /\bgym\b|fitness|yoga|pilates|workout|training|boxing|crossfit/],
  ["shop", /\bshop\b|store|boutique|retail|salon|showroom|florist|barber|pharmacy|bookshop|gallery/],
  ["living_room", /living|sitting room|apartment|\bhome\b|sofa|couch|\bflat\b|lounge/],
  ["street", /street|sidewalk|pavement|storefront|shopfront|downtown|\bcity\b|terrace|exterior|outside/],
  ["park", /\bpark\b|garden|forest|field|beach|outdoor|nature|lawn|meadow|woods/],
];

export function setPresetFor(text: string): string {
  const s = (text || "").toLowerCase();
  for (const [id, re] of MATCHERS) if (re.test(s)) return id;
  return "generic_interior";
}

/** A fresh copy of a preset (callers may mutate it). Unknown ids fall back to a plain interior. */
export function buildSet(presetId: string): SetLayout {
  const preset = PRESETS[presetId] ?? PRESETS.generic_interior;
  return JSON.parse(JSON.stringify(preset)) as SetLayout;
}

export type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number };

export function setBounds(set: SetLayout): Bounds {
  return { minX: -set.width / 2, maxX: set.width / 2, minZ: -set.depth / 2, maxZ: set.depth / 2 };
}

export function featureById(set: SetLayout, featureId: string): Feature | undefined {
  return set.features.find((x) => x.id === featureId);
}

/** Top of a feature a prop can rest on (tables, counters, seats); null when it has none. */
export function surfaceHeight(feature: Feature): number | null {
  if (feature.surface !== undefined) return feature.surface;
  if (feature.kind === "shelf" || feature.kind === "desk" || feature.kind === "block") return feature.h;
  return null;
}

/** Corners of a feature's footprint in world XZ (rotation about Y). */
export function footprint(feature: Feature): { x: number; z: number }[] {
  const r = rad(feature.rot ?? 0);
  const c = Math.cos(r);
  const s = Math.sin(r);
  const hw = feature.w / 2;
  const hd = feature.d / 2;
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ].map(([lx, lz]) => ({ x: feature.x + lx * c + lz * s, z: feature.z - lx * s + lz * c }));
}

/** Is a world point inside a feature's (rotated) footprint, grown by `pad` metres? */
export function insideFeature(feature: Feature, x: number, z: number, pad = 0): boolean {
  const r = rad(feature.rot ?? 0);
  const dx = x - feature.x;
  const dz = z - feature.z;
  // Inverse rotation into the feature's local frame.
  const lx = dx * Math.cos(r) - dz * Math.sin(r);
  const lz = dx * Math.sin(r) + dz * Math.cos(r);
  return Math.abs(lx) <= feature.w / 2 + pad && Math.abs(lz) <= feature.d / 2 + pad;
}

/** Features that sit on a wall (windows, doors) rather than on the floor. */
export function isWallFeature(feature: Feature): boolean {
  return feature.kind === "window" || feature.kind === "door" || feature.kind === "wall";
}

/** The direction a feature "faces" into the room: for wall features, away from their wall. */
export function featureNormal(set: SetLayout, feature: Feature): { x: number; z: number } {
  if (isWallFeature(feature)) {
    const b = setBounds(set);
    const toBack = Math.abs(feature.z - b.minZ);
    const toLeft = Math.abs(feature.x - b.minX);
    const toRight = Math.abs(feature.x - b.maxX);
    const nearest = Math.min(toBack, toLeft, toRight);
    if (nearest === toLeft) return { x: 1, z: 0 };
    if (nearest === toRight) return { x: -1, z: 0 };
    return { x: 0, z: 1 };
  }
  const r = rad(feature.rot ?? 0);
  return { x: Math.sin(r), z: Math.cos(r) };
}

/** Seats a figure can sit on: chairs, sofas, beds and bench-height blocks. */
export function isSeat(feature: Feature): boolean {
  if (feature.kind === "chair" || feature.kind === "sofa" || feature.kind === "bed") return true;
  return feature.kind === "block" && feature.surface !== undefined && feature.surface > 0.3 && feature.surface < 0.8;
}

/** The seat under a point, if any (used to sit figures at the right height). */
export function seatAt(set: SetLayout, x: number, z: number, pad = 0.35): Feature | undefined {
  return set.features.find((f) => isSeat(f) && insideFeature(f, x, z, pad));
}

/**
 * The first piece of furniture standing between two points, if any. Walls and openings
 * never block; furniture
 * blocks where its top is above the sight line. Features around either end are ignored —
 * the subject's own chair or table is not "in the way".
 */
export function sightBlocked(set: SetLayout, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): Feature | null {
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(2, Math.ceil(length / 0.08));
  for (const f of set.features) {
    if (isWallFeature(f) || f.h < 0.3) continue;
    if (insideFeature(f, to.x, to.z, 0.45) || insideFeature(f, from.x, from.z, 0.15)) continue;
    const top = (f.elev ?? 0) + f.h;
    for (let i = 1; i < steps; i++) {
      const u = i / steps;
      const x = from.x + (to.x - from.x) * u;
      const z = from.z + (to.z - from.z) * u;
      const y = from.y + (to.y - from.y) * u;
      if (y < top - 0.02 && insideFeature(f, x, z)) return f;
    }
  }
  return null;
}

/** Horizontal distance from a point to a feature's footprint (0 inside). */
export function distanceToFeature(feature: Feature, x: number, z: number): number {
  const r = rad(feature.rot ?? 0);
  const dx = x - feature.x;
  const dz = z - feature.z;
  const lx = dx * Math.cos(r) - dz * Math.sin(r);
  const lz = dx * Math.sin(r) + dz * Math.cos(r);
  const ox = Math.max(0, Math.abs(lx) - feature.w / 2);
  const oz = Math.max(0, Math.abs(lz) - feature.d / 2);
  return Math.hypot(ox, oz);
}

/**
 * Furniture right in front of the lens: anything reaching the lens line within `reach`
 * metres, inside a generous view wedge. A plant beside the camera fills a third of the
 * frame even when the subject is in clear view, so placement treats it like a blocker.
 * The subject's own surroundings (within 0.45 m of the aim) are never counted.
 */
export function lensObstruction(set: SetLayout, pos: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }, reach = 1.2): Feature | null {
  const fx = target.x - pos.x;
  const fz = target.z - pos.z;
  const fl = Math.hypot(fx, fz) || 1;
  for (const f of set.features) {
    if (isWallFeature(f)) continue;
    const top = (f.elev ?? 0) + f.h;
    if (top < pos.y - 0.15) continue;
    if (insideFeature(f, target.x, target.z, 0.45)) continue;
    // Plants spread beyond their footprint.
    const spread = f.kind === "plant" ? 0.2 : 0;
    const d = distanceToFeature(f, pos.x, pos.z) - spread;
    if (d > reach) continue;
    const cx = f.x - pos.x;
    const cz = f.z - pos.z;
    const along = (cx * fx + cz * fz) / fl;
    if (along < -0.1) continue; // behind the camera
    const across = Math.abs(cx * fz - cz * fx) / fl;
    // Inside a ~55° half-wedge, allowing for the feature's own size.
    if (across - Math.max(f.w, f.d) / 2 - spread <= Math.max(0.3, along) * 1.45) return f;
  }
  return null;
}

/** A table, desk or counter top within reach in front of someone (seated diners, a barista). */
export function surfaceInFront(set: SetLayout, x: number, z: number, facing: number, reach = 0.45): Feature | undefined {
  const r = rad(facing);
  const px = x + Math.sin(r) * reach;
  const pz = z + Math.cos(r) * reach;
  return set.features.find((f) => (f.kind === "table" || f.kind === "desk" || f.kind === "counter") && surfaceHeight(f) !== null && distanceToFeature(f, px, pz) < 0.12);
}
