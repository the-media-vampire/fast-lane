/**
 * Deterministic checks for the studio's own rules: timing, idempotent paid jobs, the run
 * budget, crash recovery, staleness and footage reuse. Uses a throwaway database; makes no
 * network calls. Run: pnpm exec tsx --tsconfig tsconfig.json scripts/check-pipeline.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastlane-check-"));
process.env.FASTLANE_DATA_DIR = tmp;
// Spending "on" so the budget rules can be exercised; nothing is dispatched and the network is closed.
process.env.FASTLANE_LIVE = "on";
process.env.FASTLANE_WORKER = "off";
globalThis.fetch = (() => {
  throw new Error("Network forbidden in offline checks");
}) as typeof fetch;

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const { fitDurations, retime } = await import("../lib/creative");
  const { LIMITS } = await import("../lib/types");
  const jobs = await import("../lib/jobs");
  const repo = await import("../lib/repo");
  const { db } = await import("../lib/db");
  const { recover } = await import("../lib/worker");
  const { blockShot, buildManifest } = await import("../lib/pipeline");
  const state = await import("../lib/state");
  const { runOp } = await import("../lib/ops");
  const billing = await import("../lib/billing");
  const { applyCommands } = await import("../lib/blocking/commands");

  /* timing */
  for (const total of [30, 45, 60, 90, 120]) {
    for (const n of [5, 8, 12, 18, 24]) {
      if (n * LIMITS.shotMax < total || n * LIMITS.shotMin > total) continue;
      const out = fitDurations(Array.from({ length: n }, (_, i) => 3 + (i % 4)), total);
      const sum = out.reduce((a, b) => a + b, 0);
      check(`fitDurations ${n} shots → ${total}s`, Math.abs(sum - total) < 1e-9 && out.every((d) => d >= LIMITS.shotMin && d <= LIMITS.shotMax), `sum ${sum}`);
    }
    const b = retime([3, 10, 1, 7, 2], total);
    check(`retime → ${total}s`, b[0] === 0 && b[b.length - 1] === total && b.every((x, i) => i === 0 || x - b[i - 1] >= 2));
  }

  /* jobs: idempotency and budget */
  const pid = repo.createProject({ title: "Check", kind: "commercial", duration: 30, aspect: "16:9", budgetCents: 100 });
  billing.createAuthorization(pid, { kind: "allowance", label: "Planning allowance", covers: ["model", "image", "audio"], ceilingCents: 100 });
  billing.createAuthorization(pid, { kind: "production", label: "Production", covers: ["video"], ceilingCents: 100 });
  const a = jobs.enqueue({ projectId: pid, kind: "image.storyboard", key: { shot: "s1", rev: 1 }, input: {}, estCents: 5 });
  const b = jobs.enqueue({ projectId: pid, kind: "image.storyboard", key: { shot: "s1", rev: 1 }, input: {}, estCents: 5 });
  check("same inputs reuse the job (no second purchase)", a.job.id === b.job.id && b.reused);
  const c = jobs.enqueue({ projectId: pid, kind: "image.storyboard", key: { shot: "s1", rev: 2 }, input: {}, estCents: 5 });
  check("changed inputs make a new job", c.job.id !== a.job.id);
  check("reservations count against the budget", jobs.spend(pid).reservedCents === 10);
  let refused = false;
  try {
    jobs.enqueue({ projectId: pid, kind: "video.clip", key: { big: true }, input: {}, estCents: 500 });
  } catch (e) {
    refused = e instanceof jobs.BudgetError;
  }
  check("over-budget work is refused before submission", refused);
  let noVideo = false;
  const bare = repo.createProject({ title: "No approval", kind: "commercial", duration: 30, aspect: "16:9", budgetCents: 10_000 });
  try {
    jobs.enqueue({ projectId: bare, kind: "video.clip", key: { v: 1 }, input: {}, estCents: 56 });
  } catch (e) {
    noVideo = e instanceof jobs.BudgetError;
  }
  check("video without an approved estimate is refused, whatever the budget", noVideo);
  jobs.succeed(jobs.getJob(a.job.id)!, { mediaId: "m1" }, 4);
  const s1 = jobs.spend(pid);
  check("settling charges actual cost and releases the reservation", s1.spentCents === 4 && s1.reservedCents === 5, JSON.stringify(s1));
  jobs.fail(jobs.getJob(c.job.id)!, "provider said no");
  check("a failed job releases its reservation", jobs.spend(pid).reservedCents === 0);

  /* recovery */
  const paid = jobs.enqueue({ projectId: pid, kind: "video.clip", key: { shot: "s9" }, input: {}, estCents: 10 }).job;
  const think = jobs.enqueue({ projectId: pid, kind: "think.plan", key: { n: 1 }, input: {}, estCents: 4 }).job;
  const polling = jobs.enqueue({ projectId: pid, kind: "image.asset", key: { v: 1 }, input: {}, estCents: 5 }).job;
  db().prepare("update jobs set status = 'submitting' where id = ?").run(paid.id);
  db().prepare("update jobs set status = 'running' where id = ?").run(think.id);
  jobs.claim(polling.id, ["queued"], "submitting");
  jobs.markSubmitted(polling.id, "kie", "task-123");
  recover();
  check("a paid call interrupted mid-submission becomes ambiguous, never re-bought", jobs.getJob(paid.id)!.status === "ambiguous");
  check("an interrupted free/cheap step is re-queued", jobs.getJob(think.id)!.status === "queued");
  check("a submitted task keeps its provider id and resumes polling", jobs.getJob(polling.id)!.status === "submitted" && jobs.getJob(polling.id)!.provider_task_id === "task-123");

  /* staleness and reuse */
  const p2 = repo.createProject({ title: "Reuse", kind: "commercial", duration: 30, aspect: "16:9", budgetCents: 5000 });
  const mara = repo.createAsset({ projectId: p2, kind: "character", name: "Mara", data: { description: "", look: "", role: "", height: 1.68 } });
  const v1 = repo.addAssetVersion({ assetId: mara, projectId: p2, source: "generated", status: "ready", mediaId: "m-a" });
  repo.keepAssetVersion(mara, v1);
  const cafe = repo.createAsset({ projectId: p2, kind: "location", name: "Café", data: { description: "", look: "", role: "", set: "cafe" } });
  repo.addAssetVersion({ assetId: cafe, projectId: p2, source: "generated", status: "ready", mediaId: "m-b" });
  repo.writeDoc(p2, "plan", { title: "P", treatment: "", beats: [{ id: "b1", start: 0, end: 30, visual: "", sound: "", lines: [{ id: "b1l1", kind: "super", text: "Hello" }, { id: "b1l2", kind: "vo", text: "Make room." }] }], voice: { style: "calm" }, music: { mood: "piano" } }, { author: "system" });
  const base = { rev: 1, beatId: "b1", framing: "medium" as const, move: "push_in" as const, lens: 35, description: "Mara by the window", action: "Mara sits at the window table", locationId: cafe, characterIds: [mara], propIds: [], lineIds: [], speakerId: null };
  const shots = [
    { ...base, id: "x1", title: "One", duration: 10 },
    { ...base, id: "x2", title: "Two", duration: 10 },
    { ...base, id: "x3", title: "Three", duration: 10 },
  ];
  repo.writeDoc(p2, "shots", { shots }, { author: "system", inputs: { plan: 1 } });
  const proj = repo.getProject(p2)!;
  const ids = state.assetIdentities(p2);
  for (const s of shots) {
    const sc = repo.writeScene(p2, s.id, blockShot(proj, s, ids), "system");
    repo.addFrame({ projectId: p2, shotId: s.id, kind: "storyboard", mediaId: "m-sb", status: "ready", inputs: { shotRev: 1, pictureKey: sc.pictureKey, sceneId: sc.id, assets: state.identityMap(ids, state.shotAssetIds(s)) } });
  }
  check("fresh storyboards are current", state.shotStates(p2, shots).every((s) => s.storyboardCurrent));

  const before = repo.latestScene(p2, "x2")!;
  const retimed = applyCommands(before.data, [{ op: "set_duration", seconds: 8 }]).scene;
  check("a timing-only change keeps the picture key (footage reused)", repo.pictureKey(retimed) === before.pictureKey);
  // Re-timing a shot with movement, shorter and longer and back, never reads as a new picture.
  const walking = applyCommands(before.data, [{ op: "move_actor", actor: mara, toward: "window-1", from: 1.3, until: 7.7 }]).scene;
  let drift = walking;
  let stable = true;
  for (const secs of [8.5, 7.5, 9, 6.5, 10]) {
    drift = applyCommands(drift, [{ op: "set_duration", seconds: secs }]).scene;
    if (!repo.samePictureScene(walking, drift)) stable = false;
  }
  check("re-timing a moving shot repeatedly keeps the same picture", stable);
  const movedRes = applyCommands(walking, [{ op: "camera_move", move: "orbit", amount: 25 }]);
  check("…while an actual change is still a new picture", movedRes.changes.length > 0 && !repo.samePictureScene(walking, movedRes.scene), movedRes.errors.join("; "));
  const orbit = applyCommands(before.data, [{ op: "camera_move", move: "orbit", amount: 30 }]).scene;
  repo.writeScene(p2, "x2", orbit, "agent", "orbit");
  const after = state.shotStates(p2, shots);
  check("a blocking change outdates only that shot", !after[1].storyboardCurrent && after[0].storyboardCurrent && after[2].storyboardCurrent, after.map((s) => s.storyboardReasons.join("+")).join(" | "));

  const v2 = repo.addAssetVersion({ assetId: mara, projectId: p2, source: "generated", status: "ready", mediaId: "m-a2" });
  repo.keepAssetVersion(mara, v2);
  const afterLook = state.shotStates(p2, shots);
  check("keeping a new look outdates every shot with that character", afterLook.every((s) => !s.storyboardCurrent && s.storyboardReasons.some((r) => r.includes("Mara"))));
  check("nothing was deleted by those changes", afterLook.every((s) => s.storyboard?.status === "ready"));

  const jobsBefore = jobs.projectJobs(p2).length;
  const edit = await runOp(p2, "edit_line", { lineId: "b1l1", text: "A little room" }, "user");
  check("a copy edit succeeds", edit.ok, edit.summary);
  check("a copy edit buys no footage", jobs.projectJobs(p2).filter((j) => j.kind === "video.clip" || j.kind.startsWith("image")).length === jobs.projectJobs(p2).filter((j) => j.kind === "video.clip" || j.kind.startsWith("image")).length && jobs.projectJobs(p2).length === jobsBefore);

  const m = buildManifest(p2);
  check("the cut runs exactly the project length", Math.abs(m.duration - 30) < 1e-9, String(m.duration));
  check("the edited words reach the cut", m.supers.some((s) => s.text === "A little room"));
  check("16:9 cuts are 1920×1080", m.width === 1920 && m.height === 1080);

  const agentPaid = await runOp(p2, "start_production", { confirm: true }, "agent");
  check("the agent cannot start paid production by itself", !agentPaid.ok || !!agentPaid.quote, agentPaid.summary);
  check("…and no video was queued", !jobs.projectJobs(p2).some((j) => j.kind === "video.clip"));

  console.log(`pipeline checks: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
