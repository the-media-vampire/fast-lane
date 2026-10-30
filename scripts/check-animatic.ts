/** Offline timing regressions for Direct. No providers, database or media writes. */
import assert from "node:assert/strict";
import { advancePlayhead, formatClock, playbackRange, sceneTime, shotAtTime, shotTimeline } from "../lib/animatic";

let passed = 0;
const check = (name: string, run: () => void) => { run(); passed++; console.log(`✓ ${name}`); };
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);
const durations = [7, 5, 5, 5, 7, 5, 10, 5, 5, 10, 7, 3, 5, 5, 6, 4, 5, 7, 4, 10];
const slots = shotTimeline(durations.map((duration, i) => ({ id: `s${i + 1}`, duration })));

check("twenty story shots occupy exactly two minutes", () => assert.equal(slots.at(-1)?.end, 120));
check("every shot owns its opening instant", () => { for (const slot of slots) assert.equal(shotAtTime(slots, slot.start)?.id, slot.id); });
check("the final film frame stays on the last shot", () => assert.equal(shotAtTime(slots, 120)?.id, "s20"));
check("whole-film playback ignores the selected shot's bounds", () => assert.deepEqual(playbackRange(slots, "film", "s10"), { start: 0, end: 120 }));
check("single-shot playback uses the selected shot's full duration", () => assert.deepEqual(playbackRange(slots, "shot", "s10"), { start: 54, end: 64 }));
check("single-shot playback stops at the final frame", () => assert.deepEqual(advancePlayhead(63.98, .05, { start: 54, end: 64 }, false), { time: 64, ended: true }));
check("a looping shot preserves overshoot at its boundary", () => { const next = advancePlayhead(63.9, .3, { start: 54, end: 64 }, true); close(next.time, 54.2); assert.equal(next.ended, false); });
check("looping survives a delayed frame without entering another shot", () => close(advancePlayhead(62, 31, { start: 54, end: 64 }, true).time, 63));
check("the entire two-minute sequence advances through all twenty shots", () => {
  let time = 0;
  const visited = new Set<string>();
  let ended = false;
  while (!ended) {
    visited.add(shotAtTime(slots, time)!.id);
    const next = advancePlayhead(time, .037, { start: 0, end: 120 }, false);
    time = next.time;
    ended = next.ended;
  }
  assert.equal(visited.size, 20);
  assert.equal(time, 120);
});
check("a five-second blocking scene fills a seven-second shot", () => { close(sceneTime(3.5, 7, 5), 2.5); close(sceneTime(7, 7, 5), 5); });
check("a longer blocking scene fits a shorter shot", () => close(sceneTime(3, 3, 8), 8));
check("scene sampling clamps seeks at either end", () => { assert.equal(sceneTime(-1, 7, 5), 0); assert.equal(sceneTime(9, 7, 5), 5); });
check("fractional shots introduce no cumulative gaps", () => {
  const timeline = shotTimeline(Array.from({ length: 300 }, (_, i) => ({ id: `${i}`, duration: .1 })));
  assert.equal(timeline.at(-1)?.end, 30);
  assert.ok(timeline.every((s, i) => !i || s.start === timeline[i - 1].end));
});
check("empty playback cannot spin an animation loop", () => assert.equal(advancePlayhead(0, .1, playbackRange([], "film", ""), true).ended, true));
check("clock labels roll over cleanly at two minutes", () => { assert.equal(formatClock(119.99), "01:59.9"); assert.equal(formatClock(120), "02:00.0"); assert.equal(formatClock(120, false), "02:00"); });
console.log(`\nAnimatic timing: ${passed} passed, 0 failed. No network or database access.`);
