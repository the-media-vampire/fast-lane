/**
 * Offline checks of the agent-led editing loop. A scripted fake model issues the tool calls a
 * real one would for the brief's example instructions; the checks verify scope, preserved
 * work, outdated dependants, before/after history and one consistent shot list. The selection
 * the person made must reach the model. No network; disposable database.
 *   pnpm exec tsx --tsconfig tsconfig.json scripts/check-agent.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastlane-agent-"));
process.env.FASTLANE_DATA_DIR = tmp;
process.env.FASTLANE_WORKER = "off";
process.env.FASTLANE_LIVE = "on";
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string) => {
  if (String(url).startsWith("data:")) return realFetch(url);
  throw new Error("Network forbidden in offline checks");
}) as typeof fetch;

let passed = 0;
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => (ok ? passed++ : failures.push(`${label}${detail ? ` — ${detail}` : ""}`));

const PNG = path.join(tmp, "f.png");
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x36", "-frames:v", "1", PNG]);
const PNG_URL = `data:image/png;base64,${fs.readFileSync(PNG).toString("base64")}`;

type Call = { name: string; input: Record<string, unknown> };
/** A fake model: each turn plays the given tool calls, then says one sentence. Records what it was sent. */
function scriptedModel() {
  const sent: string[] = [];
  let plan: Call[] = [];
  let step = 0;
  return {
    sent,
    play(calls: Call[]) {
      plan = calls;
      step = 0;
    },
    beta: {
      messages: {
        create: async (body: { messages: { role: string; content: unknown }[] }) => {
          sent.push(JSON.stringify(body.messages));
          const usage = { input_tokens: 800, output_tokens: 120 };
          if (step < plan.length) {
            const c = plan[step++];
            return { usage, model: "claude-opus-5-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${step}`, name: c.name, input: c.input }] };
          }
          return { usage, model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] };
        },
        parse: async () => ({ usage: { input_tokens: 500, output_tokens: 80 }, model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: { drift: "none", followedNote: true, summary: "Matches the references; the hat is there." } }),
      },
    },
  };
}

const media = {
  credits: async () => 1000,
  publish: async (i: { pathname: string }) => ({ url: `https://fake.invalid/${i.pathname}` }),
  imageSubmit: async () => ({ taskId: `img-${Math.random().toString(36).slice(2, 8)}`, model: "fake", estCents: 5 }),
  kiePoll: async () => ({ state: "success", urls: [PNG_URL], cents: 5 }),
};

async function main() {
  const { setProviders } = await import("../lib/providers");
  const billing = await import("../lib/billing");
  const jobs = await import("../lib/jobs");
  const repo = await import("../lib/repo");
  const state = await import("../lib/state");
  const pipeline = await import("../lib/pipeline");
  const worker = await import("../lib/worker");
  const { db } = await import("../lib/db");
  const { runAgentTurn } = await import("../lib/agent/astra");
  const { buildView } = await import("../lib/view");
  const { saveMedia } = await import("../lib/media");
  const { fitDurations } = await import("../lib/creative");

  const model = scriptedModel();
  setProviders({ media: media as never, claude: model as never });

  // A 30-second commercial at the storyboard: four shots with Mara in a shop.
  const pid = repo.createProject({ title: "Agent", kind: "commercial", duration: 30, aspect: "16:9", budgetCents: 300 });
  billing.createAuthorization(pid, { kind: "allowance", label: "Planning allowance", covers: ["model", "image", "audio"], ceilingCents: 300 });
  const img = () => saveMedia({ projectId: pid, bytes: fs.readFileSync(PNG), mime: "image/png", provenance: "live" }).id;
  repo.writeDoc(pid, "brief", { idea: "x", title: "Agent", kind: "commercial", duration: 30, aspect: "16:9", purpose: "p", audience: "a", tone: "t", pacing: "p", facts: [], assumptions: [], questions: [], needsProductImage: false, uploads: [] }, { author: "system" });
  repo.writeDoc(pid, "concepts", { concepts: [0, 1, 2].map((i) => ({ id: `k${i}`, title: "C", tag: "T", logline: "L", hook: "H", structure: "S", why: "W", look: "Warm", imagePrompt: "", recommended: i === 0 })), chosenId: "k0" }, { author: "system" });
  repo.writeDoc(pid, "plan", { title: "P", treatment: "", beats: [{ id: "b1", start: 0, end: 30, visual: "v", sound: "s", lines: [{ id: "b1l1", kind: "vo", text: "Ride into spring." }] }], voice: { style: "calm" }, music: { mood: "piano" } }, { author: "system", inputs: { conceptId: "k0" } });
  const mara = repo.createAsset({ projectId: pid, kind: "character", name: "Mara", data: { description: "", look: "", role: "Lead", height: 1.68 } });
  repo.keepAssetVersion(mara, repo.addAssetVersion({ assetId: mara, projectId: pid, source: "generated", status: "ready", mediaId: img() }));
  const shop = repo.createAsset({ projectId: pid, kind: "location", name: "The Shop", data: { description: "", look: "", role: "", set: "shop" } });
  repo.keepAssetVersion(shop, repo.addAssetVersion({ assetId: shop, projectId: pid, source: "generated", status: "ready", mediaId: img() }));
  const street = repo.createAsset({ projectId: pid, kind: "location", name: "The Street", data: { description: "", look: "", role: "", set: "street" } });
  repo.keepAssetVersion(street, repo.addAssetVersion({ assetId: street, projectId: pid, source: "generated", status: "ready", mediaId: img() }));
  const d = fitDurations([7, 8, 8, 7], 30);
  const shots = ["Arrives", "Waits", "Smiles", "Leaves"].map((t, i) => ({ id: `s${i + 1}`, rev: 1, title: t, summary: `${t} in the shop`, beatId: "b1", duration: d[i], framing: "medium" as const, move: "static" as const, lens: 35, description: `Mara ${t.toLowerCase()}`, action: "Mara stands", locationId: i === 2 ? street : shop, characterIds: [mara], propIds: [], lineIds: i === 0 ? ["b1l1"] : [], speakerId: null }));
  repo.writeDoc(pid, "shots", { shots }, { author: "system", inputs: { plan: 1 } });
  state.setPipeline(pid, { assetsForPlan: 1 });
  const p = repo.getProject(pid)!;
  const ids = state.assetIdentities(pid);
  for (const s of shots) {
    const sc = repo.writeScene(pid, s.id, pipeline.blockShot(p, s, ids), "system");
    const cap = repo.addFrame({ projectId: pid, shotId: s.id, kind: "capture", status: "ready", mediaId: img(), inputs: { shotRev: 1, pictureKey: sc.pictureKey, sceneId: sc.id } });
    repo.addFrame({ projectId: pid, shotId: s.id, kind: "storyboard", status: "ready", mediaId: img(), inputs: { shotRev: 1, pictureKey: sc.pictureKey, sceneId: sc.id, assets: state.identityMap(ids, state.shotAssetIds(s)), captureId: cap } });
  }
  const drain = async () => {
    for (let r = 0; r < 10; r++) {
      db().prepare("update jobs set next_run_at = null").run();
      const due = jobs.dueJobs(50).filter((j) => j.kind !== "capture");
      if (!due.length) {
        // Captures need Chromium; stand in for them so storyboards can follow.
        for (const f of db().prepare("select id from frames where project_id = ? and kind = 'capture' and status = 'pending'").all(pid) as { id: string }[]) repo.updateFrame(f.id, { mediaId: img(), status: "ready" });
        db().prepare("update jobs set status = 'succeeded' where project_id = ? and kind = 'capture' and status = 'queued'").run(pid);
        await pipeline.advance(pid);
        if (!jobs.dueJobs(50).filter((j) => j.kind !== "capture").length) return;
        continue;
      }
      for (const j of due) await worker.processJob(j);
    }
  };
  const focus = (id: string) => {
    const v = buildView(pid)!;
    const s = v.shots!.items.find((x) => x.id === id)!;
    return { kind: "shot" as const, id, label: `Shot ${s.number} · ${s.title}` };
  };
  const numbers = () => {
    const v = buildView(pid)!;
    return v.shots!.items.map((s) => `${s.number}:${s.id}:${s.start}+${s.duration}`).join(" ");
  };

  /* the selection reaches the model */
  model.play([]);
  await runAgentTurn(pid, "What do you think of this one?", { stage: "shots", focus: focus("s3") });
  const lastSent = model.sent[model.sent.length - 1];
  check("the selected shot reaches the model as explicit context", lastSent.includes("Selected: Shot 03 · Smiles [s3]") && lastSent.includes("<selection>"), lastSent.slice(-400));
  check("its blocking comes with it", /Its blocking \(v1\)/.test(lastSent));

  /* "Hold this moment longer." */
  model.play([{ name: "edit_shot", input: { shotId: "s3", duration: d[2] + 1.5 } }]);
  const before = state.shotsDoc(pid)!.data.shots.map((s) => s.duration);
  const hold = await runAgentTurn(pid, "Hold this moment longer.", { stage: "shots", focus: focus("s3") });
  const after = state.shotsDoc(pid)!.data.shots.map((s) => s.duration);
  check("holding longer changes that shot", after[2] === before[2] + 1.5, `${before} → ${after}`);
  check("…and the film keeps its length", Math.abs(after.reduce((a, b) => a + b, 0) - 30) < 1e-9);
  check("…and no picture is outdated by a timing change", buildView(pid)!.shots!.items.every((s) => s.storyboard?.current));
  check("the reply reports the change", hold.results.some((r) => r.ok && /Shot 03 is now/.test(r.summary)), hold.results.map((r) => r.summary).join(" | "));

  /* "Put her in a hat in this shot." */
  model.play([
    { name: "edit_shot", input: { shotId: "s2", direction: "Mara wears a dark green wool hat." } },
    { name: "redraw_storyboard", input: { shotId: "s2", note: "She wears a dark green wool hat; keep everything else." } },
  ]);
  const frames0 = repo.frameHistory(pid, "s2").length;
  const hat = await runAgentTurn(pid, "Put her in a hat in this shot.", { stage: "shots", focus: focus("s2") });
  check("a local change only touches the selected shot", hat.results[0]?.ok && /Now outdated: Shot 02 storyboard\./.test(hat.results[0].summary), hat.results[0]?.summary);
  await drain();
  const v2 = buildView(pid)!;
  const s2 = v2.shots!.items.find((s) => s.id === "s2")!;
  check("the redraw runs under the allowance, without a quote", !v2.quotes.length && s2.storyboard?.current === true, JSON.stringify(s2.storyboard));
  check("the previous frame is kept for before/after", repo.frameHistory(pid, "s2").length === frames0 + 1 && s2.storyboards.filter((f) => f.media).length >= 2);
  check("the redraw carried the note and the previous frame as reference", s2.storyboards[0].note?.includes("hat") === true);
  check("the redraw was checked for drift", s2.storyboards[0].drift?.drift === "none", JSON.stringify(s2.storyboards[0].drift));
  check("the direction stays with the shot for later frames and video", state.shotsDoc(pid)!.data.shots.find((s) => s.id === "s2")!.direction === "Mara wears a dark green wool hat.");
  check("other shots kept their frames", v2.shots!.items.filter((s) => s.id !== "s2").every((s) => s.storyboard?.current));

  /* "Keep this character, but match the shop background." */
  model.play([
    { name: "edit_shot", input: { shotId: "s3", locationId: shop } },
    { name: "redraw_storyboard", input: { shotId: "s3", note: "Keep Mara exactly; match The Shop's background." } },
  ]);
  await runAgentTurn(pid, "Keep this character, but match the shop background.", { stage: "shots", focus: focus("s3") });
  await drain();
  const s3 = buildView(pid)!.shots!.items.find((s) => s.id === "s3")!;
  check("matching the background moves the shot to the shop and redraws it", s3.locationName === "The Shop" && s3.storyboard?.current === true && s3.storyboards[0].note?.includes("Shop") === true);

  /* "Add a close-up after this." */
  model.play([{ name: "insert_shot", input: { afterShotId: "s2", title: "Hat close-up", summary: "Close on Mara under the hat", description: "Close-up of Mara's face under a dark green wool hat", action: "Mara looks up", framing: "close" } }]);
  const add = await runAgentTurn(pid, "Add a close-up after this.", { stage: "shots", focus: focus("s2") });
  await drain();
  const v3 = buildView(pid)!;
  check("a close-up is added right after the selected shot", v3.shots!.items[2].title === "Hat close-up" && v3.shots!.items.length === 5, numbers());
  check("…the film keeps its length", Math.abs(v3.shots!.items.reduce((a, s) => a + s.duration, 0) - 30) < 1e-9);
  check("…and the new shot gets blocking and a frame", !!v3.shots!.items[2].scene && v3.shots!.items[2].storyboard?.status === "ready");
  check("the reply says later shots move up a number", add.results.some((r) => /later shots move up one number/.test(r.summary)), add.results.map((r) => r.summary).join(" | "));

  /* "Remove this shot." */
  const lastId = v3.shots!.items[4].id;
  model.play([{ name: "remove_shot", input: { shotId: lastId } }]);
  await runAgentTurn(pid, "Remove this shot.", { stage: "shots", focus: focus(lastId) });
  const v4 = buildView(pid)!;
  check("the selected shot is removed and the length is kept", v4.shots!.items.length === 4 && !v4.shots!.items.some((s) => s.id === lastId) && Math.abs(v4.shots!.items.reduce((a, s) => a + s.duration, 0) - 30) < 1e-9);
  check("its frames are kept, not deleted", repo.frameHistory(pid, lastId).length > 0);

  /* The storyboard, Direct strip and Cut read the same sequence. */
  const v5 = buildView(pid)!;
  const list = v5.shots!.items;
  check("numbers run 01..n in order with contiguous timing", list.every((s, i) => s.number === String(i + 1).padStart(2, "0") && Math.abs(s.start - list.slice(0, i).reduce((a, x) => a + x.duration, 0)) < 1e-9));
  const cut = pipeline.buildManifest(pid);
  check("the cut uses the same shots, order and timing", cut.shots.map((s) => `${s.shotId}:${s.start}:${s.duration}`).join() === list.map((s) => `${s.id}:${s.start}:${s.duration}`).join());
  check("the voice line stays with its shot", list[0].words.some((w) => w.text === "Ride into spring."));

  /* Captions preserve the AV plan without a separate Plan screen. */
  const { storyboardCaptions } = await import("../lib/storyboard");
  const { studioStage } = await import("../lib/types");
  const captionPlan = structuredClone(state.planDoc(pid)!.data);
  captionPlan.endCard = { line: "Ride into spring.", detail: "Our shop" };
  captionPlan.beats[0].lines.push({ id: "duplicate-end", kind: "super", text: "Ride into spring." });
  captionPlan.beats.push({ id: "last", start: 10, end: 15, visual: "", sound: "", lines: [{ id: "unplaced", kind: "dialogue", speaker: "Mara", text: "Come along." }] });
  const board = [
    { id: "one", number: "01", start: 0, duration: 5, lineIds: ["b1l1", "duplicate-end"] },
    { id: "two", number: "02", start: 5, duration: 5, lineIds: ["b1l1"] },
    { id: "three", number: "03", start: 10, duration: 3, lineIds: [] },
    { id: "four", number: "04", start: 13, duration: 2, lineIds: [] },
  ];
  const copy = storyboardCaptions(board, captionPlan);
  const allCopy = [...copy.values()].flat();
  check("a spanning VO is written once, with a continuation pointing to its start", copy.get("one")!.some((w) => w.kind === "vo" && !w.continues) && copy.get("two")!.some((w) => w.kind === "vo" && w.continues && w.firstShotId === "one") && allCopy.filter((w) => w.kind === "vo" && !w.continues).length === 1);
  check("unlinked dialogue at a shot boundary stays visible on the correct frame", copy.get("three")!.some((w) => w.id === "unplaced" && w.speaker === "Mara"));
  check("end-card words are not duplicated as an earlier super", !allCopy.some((w) => w.id === "duplicate-end") && copy.get("three")!.some((w) => w.source === "end-title" && !w.continues) && copy.get("four")!.some((w) => w.source === "end-title" && w.continues));
  check("shots without words have no caption placeholders", [...storyboardCaptions(board, null).values()].every((rows) => rows.length === 0));
  check("old Plan navigation resolves to the storyboard", studioStage("plan") === "shots" && studioStage("assets") === "assets" && studioStage("unknown") === null);

  const docsBeforeCopy = state.shotsDoc(pid)!.version;
  const jobsBeforeCopy = jobs.projectJobs(pid).length;
  await (await import("../lib/ops")).runOp(pid, "edit_line", { lineId: "b1l1", text: "A fresh start." }, "user");
  const edited = storyboardCaptions(buildView(pid)!.shots!.items, state.planDoc(pid)!.data);
  check("editing storyboard words persists without changing shots or starting generation", [...edited.values()].flat().some((w) => w.text === "A fresh start.") && state.shotsDoc(pid)!.version === docsBeforeCopy && jobs.projectJobs(pid).length === jobsBeforeCopy);

  /* Re-planning the shots never draws frames for the list it is replacing. */
  const draws = () => jobs.projectJobs(pid).filter((j) => j.kind === "image.storyboard").length;
  const drawsBefore = draws();
  // Make every frame outdated, then ask for new shots: nothing may be drawn until the new list exists.
  const look2 = repo.addAssetVersion({ assetId: mara, projectId: pid, source: "generated", status: "ready", mediaId: img() });
  repo.keepAssetVersion(mara, look2);
  const { runOp } = await import("../lib/ops");
  await runOp(pid, "revise_shots", { note: "Tighter pacing" }, "agent");
  await pipeline.advance(pid);
  check("re-planning shots draws nothing for the outgoing list", draws() === drawsBefore, `${draws() - drawsBefore} frames queued`);
  db().prepare("update jobs set status = 'cancelled' where project_id = ? and kind = 'think.shots' and status = 'queued'").run(pid);
  state.setPipeline(pid, { develop: false });

  /* Ambiguous scope gets one question, not a guess. */
  model.play([{ name: "offer_choices", input: { question: "This shot or every shot with her?", choices: [{ label: "Just this shot", recommended: true }, { label: "Every shot with Mara" }] } }]);
  const ask = await runAgentTurn(pid, "Give her a red scarf.", { stage: "shots", focus: focus(list[1].id) });
  check("an ambiguous scope becomes one short question with choices", ask.choices?.length === 2 && jobs.projectJobs(pid).filter((j) => j.kind === "image.storyboard" && j.status === "queued").length === 0);

  /* Spending stayed inside the allowance and was recorded per response. */
  const s = billing.spend(pid);
  check("all of it ran inside the planning allowance", s.spentCents + s.reservedCents <= 300 && s.spentCents > 0, JSON.stringify(s));

  /* Story previews do not become generation until the person approves the version they read. */
  const { EXAMPLE_STORIES } = await import("../lib/concept-examples");
  const { ConceptStory } = await import("../lib/types");
  const previewOps = await import("../lib/ops");
  const previewId = repo.createProject({ title: "Story checkpoint", kind: "commercial", duration: 30, aspect: "16:9", budgetCents: 300 });
  repo.updateProject(previewId, { autopilot: 1 });
  billing.createAuthorization(previewId, { kind: "allowance", label: "Preview checks", covers: ["model", "image"], ceilingCents: 300 });
  repo.writeDoc(previewId, "brief", state.briefDoc(pid)!.data, { author: "system" });
  const draft = structuredClone(EXAMPLE_STORIES["The quiet hour"]);
  repo.writeDoc(previewId, "concepts", { chosenId: null, concepts: state.conceptsDoc(pid)!.data.concepts.map((c) => ({ ...c, story: draft })) }, { author: "system" });
  await pipeline.advance(previewId);
  buildView(previewId);
  check("opening a concept preview cannot advance even an old autopilot project", state.conceptsDoc(previewId)!.data.chosenId === null && jobs.projectJobs(previewId).length === 0 && repo.listAssets(previewId).length === 0);
  const noAutoApproval = await previewOps.runOp(previewId, "choose_concept", { conceptId: "k0" }, "agent");
  check("Astra cannot approve a story or start its assets", !noAutoApproval.ok && jobs.projectJobs(previewId).length === 0);
  const readVersion = state.conceptsDoc(previewId)!.version;
  draft[3].visual = "Mara makes room for a friend at the window table.";
  const proposal = await previewOps.runOp(previewId, "edit_concept_story", { conceptId: "k0", story: draft }, "agent");
  check("a story change is a preview draft with no production side effects", proposal.ok && state.conceptsDoc(previewId)!.data.concepts[0].storyDraft?.[3].visual === draft[3].visual && state.conceptsDoc(previewId)!.data.chosenId === null && jobs.projectJobs(previewId).length === 0);
  const staleApproval = await previewOps.runOp(previewId, "choose_concept", { conceptId: "k0", conceptVersion: readVersion }, "user");
  check("a stale approval cannot accept unseen story changes", !staleApproval.ok && jobs.projectJobs(previewId).length === 0);
  const approval = await previewOps.runOp(previewId, "choose_concept", { conceptId: "k0", conceptVersion: state.conceptsDoc(previewId)!.version }, "user");
  const accepted = state.conceptsDoc(previewId)!.data.concepts[0];
  check("explicit story approval commits its words and begins development in Assets", approval.ok && approval.navigate === "assets" && accepted.story?.[3].visual === draft[3].visual && !accepted.storyDraft && jobs.projectJobs(previewId).some((j) => j.kind === "think.plan"));
  const approvedJobs = jobs.projectJobs(previewId).length;
  await previewOps.runOp(previewId, "choose_concept", { conceptId: "k0", conceptVersion: state.conceptsDoc(previewId)!.version }, "user");
  check("reopening an already chosen story does not start duplicate work", jobs.projectJobs(previewId).length === approvedJobs);
  const replacement = structuredClone(draft);
  replacement[3].visual = "Mara closes her eyes and listens to the café.";
  await previewOps.runOp(previewId, "edit_concept_story", { conceptId: "k0", story: replacement }, "agent");
  check("revising a chosen story preserves its committed version until another approval", state.conceptsDoc(previewId)!.data.concepts[0].story?.[3].visual === draft[3].visual && state.conceptsDoc(previewId)!.data.concepts[0].storyDraft?.[3].visual === replacement[3].visual && jobs.projectJobs(previewId).length === approvedJobs);
  check("every demo direction has a complete concise preview", Object.values(EXAMPLE_STORIES).length === 9 && Object.values(EXAMPLE_STORIES).every((story) => ConceptStory.safeParse(story).success));

  console.log(`agent checks: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
