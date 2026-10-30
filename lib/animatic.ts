/** The animatic follows shot durations; scene keyframes may have a different duration. */
export type TimedShot = { id: string; duration: number };
export type ShotSlot = { id: string; start: number; end: number; duration: number };
export type PlaybackScope = "film" | "shot";

export function shotTimeline(shots: readonly TimedShot[]): ShotSlot[] {
  let cursor = 0;
  return shots.map((shot) => {
    const start = cursor;
    const duration = Number.isFinite(shot.duration) ? Math.max(0, shot.duration) : 0;
    cursor = Math.round((cursor + duration) * 1e6) / 1e6;
    return { id: shot.id, start, end: cursor, duration };
  });
}

export function shotAtTime(slots: readonly ShotSlot[], time: number): ShotSlot | undefined {
  return slots.find((s) => time < s.end) ?? slots.at(-1);
}

export function playbackRange(slots: readonly ShotSlot[], scope: PlaybackScope, shotId: string) {
  const shot = slots.find((s) => s.id === shotId) ?? slots[0];
  return scope === "shot" && shot ? { start: shot.start, end: shot.end } : { start: 0, end: slots.at(-1)?.end ?? 0 };
}

export function advancePlayhead(time: number, elapsed: number, range: { start: number; end: number }, loop: boolean) {
  const duration = range.end - range.start;
  const next = Math.max(range.start, time) + Math.max(0, elapsed);
  if (duration <= 0) return { time: range.start, ended: true };
  if (next < range.end) return { time: next, ended: false };
  return loop
    ? { time: range.start + ((next - range.start) % duration), ended: false }
    : { time: range.end, ended: true };
}

export function sceneTime(localTime: number, shotDuration: number, sceneDuration: number) {
  return shotDuration > 0 ? Math.max(0, Math.min(1, localTime / shotDuration)) * sceneDuration : 0;
}

export function formatClock(time: number, tenths = true) {
  const ticks = Math.max(0, Math.floor(time * 10 + 1e-6));
  const seconds = Math.floor(ticks / 10);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}${tenths ? `.${ticks % 10}` : ""}`;
}
