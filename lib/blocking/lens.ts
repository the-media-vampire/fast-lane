/**
 * Lens maths: focal length to field of view on a sensor gate. Fast Lane always shoots on
 * the full-frame gate: the frame is cropped to the shot aspect inside the 36 × 24 mm gate,
 * so a 35 mm lens means the same field of view as a 35 mm lens on a full-frame camera (or a
 * Blender camera with a 36 mm sensor width).
 */

export const GATE = { widthMm: 36, heightMm: 24 } as const;
export const LENS_PRESETS = [18, 24, 35, 50, 85, 135] as const;

export function aspectNumber(aspect: "16:9" | "9:16"): number {
  return aspect === "9:16" ? 9 / 16 : 16 / 9;
}

/** Vertical field of view in degrees for a focal length at the shot aspect. */
export function lensMmToFovDeg(lensMm: number, aspect: number): number {
  const f = Math.max(8, Math.min(400, lensMm));
  const usedH = aspect > 0 ? Math.min(GATE.heightMm, GATE.widthMm / aspect) : GATE.heightMm;
  return (2 * Math.atan(usedH / (2 * f)) * 180) / Math.PI;
}

/** Horizontal field of view in degrees, derived from the vertical one and the aspect. */
export function horizontalFovDeg(fovVDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((fovVDeg * Math.PI) / 360) * aspect) * 180) / Math.PI;
}

export function fovs(lensMm: number, aspect: "16:9" | "9:16"): { fovV: number; fovH: number } {
  const a = aspectNumber(aspect);
  const fovV = lensMmToFovDeg(lensMm, a);
  return { fovV, fovH: horizontalFovDeg(fovV, a) };
}

/** Plain-language lens character, for prompts and labels. */
export function lensCharacter(lensMm: number): string {
  if (lensMm < 22) return "ultra-wide";
  if (lensMm < 30) return "wide";
  if (lensMm < 45) return "standard wide";
  if (lensMm < 70) return "normal";
  if (lensMm < 110) return "portrait";
  return "long";
}
