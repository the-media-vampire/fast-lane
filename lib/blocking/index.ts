/** Public surface of the blocking module (capture.ts is server-only and imported directly). */
export * from "./types";
export { aspectNumber, fovs, horizontalFovDeg, lensCharacter, lensMmToFovDeg, LENS_PRESETS } from "./lens";
export { sampleSceneAt, sampleCamera, scenePaths, handPosition, ACTOR_COLORS, ACTOR_COLOR_NAMES, MANNEQUIN_BASE_HEIGHT } from "./sample";
export type { SceneSample, CameraSample, ActorSample, PropSample, ScenePaths } from "./sample";
export { SET_PRESETS, SET_PRESET_IDS, buildSet, setPresetFor, setBounds, featureById, surfaceHeight, footprint } from "./sets";
export { DEFAULT_AMOUNTS, clampAmount, amountLabel, moveKeys, moveEnd, fitMove, cameraBoundsIssue } from "./presets";
export { solveFraming } from "./framing";
export type { FramingName, Side, HeightName } from "./framing";
export { autoBlock } from "./auto";
export type { AutoBlockInput } from "./auto";
export { applyCommands, validateScene, moveName } from "./commands";
export type { ApplyResult } from "./commands";
export { describeForPrompt, describeForAgent, describeCameraMove } from "./describe";
