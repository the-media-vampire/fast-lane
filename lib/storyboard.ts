import type { Plan } from "./types";
import type { ShotView, Words } from "./view-types";

type BoardShot = Pick<ShotView, "id" | "number" | "start" | "duration" | "lineIds">;
export type StoryboardCaption = Words & {
  source: "line" | "end-title" | "end-detail";
  continues: boolean;
  firstShotId: string;
  firstShotNumber: string;
};

/** Present existing line-to-shot links without repeating a whole speech on every frame. */
export function storyboardCaptions(shots: BoardShot[], plan: Plan | null): Map<string, StoryboardCaption[]> {
  const result = new Map(shots.map((s) => [s.id, [] as StoryboardCaption[]]));
  if (!plan || !shots.length) return result;
  const norm = (s: string) => s.trim().toLowerCase().replace(/[.!?]+$/, "");
  const endWords = new Set([plan.endCard?.line, plan.endCard?.detail].filter((s): s is string => !!s).map(norm));
  const at = (time: number) => shots.find((s) => time >= s.start && time < s.start + s.duration) ?? (time < shots[0].start ? shots[0] : shots[shots.length - 1]);
  const add = (line: Words, targets: BoardShot[], source: StoryboardCaption["source"]) => {
    targets.forEach((s, i) => result.get(s.id)!.push({ ...line, source, continues: i > 0, firstShotId: targets[0].id, firstShotNumber: targets[0].number }));
  };
  const seen = new Set<string>();
  for (const beat of plan.beats) {
    for (const line of beat.lines) {
      if (seen.has(line.id) || (line.kind === "super" && endWords.has(norm(line.text)))) continue;
      seen.add(line.id);
      const linked = shots.filter((s) => s.lineIds.includes(line.id));
      // Unlinked lines use the same beat-time fallback as assembly, so copy never disappears.
      add(line, linked.length ? linked : [at(beat.start)], "line");
    }
  }
  if (plan.endCard) {
    const total = shots[shots.length - 1].start + shots[shots.length - 1].duration;
    const first = at(Math.max(0, total - 3.2));
    const targets = shots.slice(shots.indexOf(first));
    add({ id: "end-title", kind: "super", text: plan.endCard.line }, targets, "end-title");
    if (plan.endCard.detail) add({ id: "end-detail", kind: "super", text: plan.endCard.detail }, [first], "end-detail");
  }
  return result;
}
