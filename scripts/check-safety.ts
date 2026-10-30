/**
 * Offline proof of the coding-review fixes (handoff/CODING-REVIEW.md, findings 1–6).
 * Disposable database, fake providers, and spies that fail if a paid adapter is touched.
 * No network: fetch is replaced and only data: URLs resolve.
 *   pnpm exec tsx --tsconfig tsconfig.json scripts/check-safety.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastlane-safety-"));
process.env.FASTLANE_DATA_DIR = tmp;
process.env.FASTLANE_WORKER = "off";
process.env.FASTLANE_LIVE = "on";

const realFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u.startsWith("data:")) return realFetch(u, init);
  networkAttempts++;
  throw new Error(`Network forbidden in offline checks: ${u.slice(0, 60)}`);
}) as typeof fetch;

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}
const section = (t: string) => console.log(`\n${t}`);

/* ---------------- media fixtures (made locally with ffmpeg) ---------------- */

const fx = path.join(tmp, "fixtures");
fs.mkdirSync(fx, { recursive: true });
const PNG = path.join(fx, "f.png");
const JPG = path.join(fx, "f.jpg");
const MP4 = path.join(fx, "f.mp4");
const MP3 = path.join(fx, "f.mp3");
const ff = (args: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args]);
ff(["-f", "lavfi", "-i", "color=c=gray:s=64x36", "-frames:v", "1", PNG]);
ff(["-f", "lavfi", "-i", "color=c=gray:s=64x36", "-frames:v", "1", JPG]);
ff(["-f", "lavfi", "-i", "color=c=black:s=320x180:d=5", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", MP4]);
ff(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1.5", "-q:a", "9", MP3]);
const dataUrl = (file: string, mime: string) => `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
const PNG_URL = dataUrl(PNG, "image/png");
const MP4_URL = dataUrl(MP4, "video/mp4");

/* ---------------- fake providers ---------------- */

const PAID = new Set(["imageSubmit", "clipSubmit", "musicSubmit", "speak", "publish"]);
type Call = { method: string; args: unknown };

function fakeMedia(opts: { tripwire?: boolean; kiePoll?: (id: string) => unknown; clipPoll?: (h: string) => unknown; imageSubmit?: () => unknown } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const rec = (method: string, args?: unknown) => {
    calls.push({ method, args });
    if (opts.tripwire && PAID.has(method)) throw new Error(`TRIPWIRE: ${method} reached a paid provider`);
  };
  const m = {
    calls,
    paidCalls: () => calls.filter((c) => PAID.has(c.method)).length,
    ping: async () => ({ mdRoot: "fake", node: process.version, keys: {}, videoProvider: "fake" }),
    dryRun: async () => ({ model: "fake", input: {}, estCents: 0 }),
    credits: async () => (rec("credits"), 1000),
    publish: async (i: { pathname: string }) => (rec("publish", i), { url: `https://fake.invalid/${i.pathname}` }),
    imageSubmit: async (i: unknown) => {
      rec("imageSubmit", i);
      if (opts.imageSubmit) return opts.imageSubmit();
      return { taskId: `img-${++n}`, model: "fake-image", estCents: 5 };
    },
    kiePoll: async (taskId: string) => (rec("kiePoll", taskId), opts.kiePoll?.(taskId) ?? { state: "success", urls: [PNG_URL], cents: 5 }),
    clipSubmit: async (i: unknown) => (rec("clipSubmit", i), { handle: `clip-${++n}`, providerTaskId: `p-${n}`, estCents: 56, model: "fake-video" }),
    clipPoll: async (h: string) => (rec("clipPoll", h), opts.clipPoll?.(h) ?? { status: "done", url: MP4_URL, cents: null }),
    speak: async (i: { outPath: string }) => {
      rec("speak", i);
      fs.mkdirSync(path.dirname(i.outPath), { recursive: true });
      fs.copyFileSync(MP3, i.outPath);
      return { durationMs: 1500, words: [], cents: 1 };
    },
    musicSubmit: async (i: unknown) => (rec("musicSubmit", i), { taskId: `mus-${++n}`, estCents: 6 }),
    musicPoll: async (id: string) => (rec("musicPoll", id), { state: "success", trackUrls: ["data:audio/mpeg;base64,AA=="], cents: 6 }),
    musicFinish: async (i: { outDir: string; name: string; seconds: number }) => {
      rec("musicFinish", i);
      const p = path.join(i.outDir, `${i.name}.mp3`);
      fs.copyFileSync(MP3, p);
      return { path: p, durationMs: i.seconds * 1000 };
    },
    renderOverlay: async (i: { outPath: string }) => (rec("renderOverlay"), fs.copyFileSync(PNG, i.outPath), { path: i.outPath }),
    assemble: async (spec: { outPath: string; clips: { durationMs: number }[]; width: number; height: number }) => {
      rec("assemble");
      fs.mkdirSync(path.dirname(spec.outPath), { recursive: true });
      fs.copyFileSync(MP4, spec.outPath);
      return { path: spec.outPath, durationMs: spec.clips.reduce((a, c) => a + c.durationMs, 0), width: spec.width, height: spec.height, hasAudio: true, loudness: { integrated: -14, truePeak: -1.5 } };
    },
    inspect: async () => (rec("inspect"), { durationMs: 5000, width: 1920, height: 1080, hasAudio: false }),
    frameAt: async (i: { outPath: string }) => (rec("frameAt"), fs.copyFileSync(JPG, i.outPath), { path: i.outPath }),
    stillToClip: async (i: { outPath: string }) => (rec("stillToClip"), { path: i.outPath }),
  };
  return m;
}

type Scripted = { parse?: (body: Record<string, unknown>) => unknown; create?: (body: Record<string, unknown>, n: number) => unknown };
function fakeClaude(script: Scripted = {}, tripwire = false) {
  const calls: { kind: string; body: Record<string, unknown> }[] = [];
  let creates = 0;
  return {
    calls,
    beta: {
      messages: {
        parse: async (body: Record<string, unknown>) => {
          calls.push({ kind: "parse", body });
          if (tripwire || !script.parse) throw new Error("TRIPWIRE: the model was called");
          return script.parse(body);
        },
        create: async (body: Record<string, unknown>) => {
          calls.push({ kind: "create", body });
          if (tripwire || !script.create) throw new Error("TRIPWIRE: the model was called");
          return script.create(body, creates++);
        },
      },
    },
  };
}
const usage = { input_tokens: 1000, output_tokens: 500 }; // = 2 cents at the Opus list price

async function main() {
  const { setProviders } = await import("../lib/providers");
  const billing = await import("../lib/billing");
  const jobs = await import("../lib/jobs");
  const repo = await import("../lib/repo");
  const { db } = await import("../lib/db");
  const state = await import("../lib/state");
  const pipeline = await import("../lib/pipeline");
  const ops = await import("../lib/ops");
  const worker = await import("../lib/worker");
  const { runAgentTurn } = await import("../lib/agent/astra");
  const { structured } = await import("../lib/llm");
  const creative = await import("../lib/creative");
  const { adoptUploads, ensureSample, SAMPLE_ID } = await import("../lib/create");
  const { saveMedia } = await import("../lib/media");
  const { runTextOnly } = await import("../lib/textonly");
  const { buildView } = await import("../lib/view");
  const { z } = await import("zod");
  const Anthropic = (await import("@anthropic-ai/sdk")).default;

  /* ---------- fixtures ---------- */

  function media(pid: string, kind: "image" | "video" = "image") {
    return kind === "image"
      ? saveMedia({ projectId: pid, bytes: fs.readFileSync(PNG), mime: "image/png", provenance: "live", name: "fx" })
      : saveMedia({ projectId: pid, bytes: fs.readFileSync(MP4), mime: "video/mp4", provenance: "live", name: "fx", duration: 5 });
  }

  /** A project at the storyboard preview: brief, chosen concept, plan with lines, cast, shots, blocking, captures and frames. */
  function preview(title: string, o: { budgetCents?: number; allowanceCents?: number; shots?: number; lines?: string[] } = {}) {
    const pid = repo.createProject({ title, kind: "commercial", duration: 30, aspect: "16:9", budgetCents: o.budgetCents ?? 0 });
    if (o.allowanceCents) billing.createAuthorization(pid, { kind: "allowance", label: "Planning allowance", covers: ["model", "image", "audio"], ceilingCents: o.allowanceCents });
    repo.writeDoc(pid, "brief", { idea: "A bike shop in spring", title, kind: "commercial", duration: 30, aspect: "16:9", purpose: "Bring bikes in", audience: "Locals", tone: "Warm", pacing: "Calm", facts: [], assumptions: [], questions: [], needsProductImage: false, uploads: [] }, { author: "system" });
    repo.writeDoc(pid, "concepts", { concepts: [0, 1, 2].map((i) => ({ id: `k${i}`, title: `C${i}`, tag: "T", logline: "L", hook: "H", structure: "S", why: "W", look: "Warm light", imagePrompt: "", recommended: i === 0 })), chosenId: "k0" }, { author: "system" });
    const lines = (o.lines ?? ["Ride into spring."]).map((t, i) => ({ id: `b1l${i + 1}`, kind: "vo" as const, text: t }));
    repo.writeDoc(pid, "plan", { title, treatment: "", beats: [{ id: "b1", start: 0, end: 30, visual: "v", sound: "s", lines }], voice: { style: "calm", voiceId: "configure-warm-narrator" }, music: { mood: "piano" } }, { author: "system", inputs: { conceptId: "k0" } });
    const mara = repo.createAsset({ projectId: pid, kind: "character", name: "Mara", data: { description: "", look: "", role: "Lead", height: 1.68 } });
    const v = repo.addAssetVersion({ assetId: mara, projectId: pid, source: "generated", status: "ready", mediaId: media(pid).id });
    repo.keepAssetVersion(mara, v);
    const cafe = repo.createAsset({ projectId: pid, kind: "location", name: "Shop", data: { description: "", look: "", role: "", set: "shop" } });
    repo.addAssetVersion({ assetId: cafe, projectId: pid, source: "generated", status: "ready", mediaId: media(pid).id });
    const n = o.shots ?? 3;
    const durations = creative.fitDurations(Array.from({ length: n }, () => 5), 30);
    const shots = durations.map((d, i) => ({ id: `${pid}-s${i}`, rev: 1, title: `Shot ${i}`, beatId: "b1", duration: d, framing: "medium" as const, move: "static" as const, lens: 35, description: "Mara by the bench", action: "Mara stands", locationId: cafe, characterIds: [mara], propIds: [], lineIds: i === 0 ? lines.map((l) => l.id) : [], speakerId: null }));
    repo.writeDoc(pid, "shots", { shots }, { author: "system", inputs: { plan: 1 } });
    state.setPipeline(pid, { assetsForPlan: 1 });
    const p = repo.getProject(pid)!;
    const ids = state.assetIdentities(pid);
    for (const a of ids) db().prepare("update assets set approved_version_id = ? where id = ?").run(a.version!.id, a.asset.id);
    for (const s of shots) {
      const sc = repo.writeScene(pid, s.id, pipeline.blockShot(p, s, ids), "system");
      const cap = repo.addFrame({ projectId: pid, shotId: s.id, kind: "capture", status: "ready", mediaId: media(pid).id, inputs: { shotRev: 1, pictureKey: sc.pictureKey, sceneId: sc.id } });
      repo.addFrame({ projectId: pid, shotId: s.id, kind: "storyboard", status: "ready", mediaId: media(pid).id, inputs: { shotRev: 1, pictureKey: sc.pictureKey, sceneId: sc.id, assets: state.identityMap(ids, state.shotAssetIds(s)), captureId: cap } });
    }
    return { pid, shots };
  }

  /** Run every due job once, the way the worker would (no timers). */
  async function drain(rounds = 12) {
    for (let r = 0; r < rounds; r++) {
      db().prepare("update jobs set next_run_at = null").run();
      const due = jobs.dueJobs(50);
      if (!due.length) return;
      for (const j of due) {
        if (j.kind === "capture") continue; // grey captures need Chromium; not part of these checks
        if (j.status === "queued") {
          const gate = worker.dispatchGate(j);
          if (!gate.ok) {
            jobs.holdJob(j.id, gate.reason);
            continue;
          }
        }
        await worker.processJob(j);
      }
    }
  }

  /** Approve the production estimate the way the studio's confirmation endpoint does. */
  async function approveProduction(pid: string) {
    const q = await ops.runOp(pid, "start_production", {}, "user");
    if (!q.quote) throw new Error(`no quote: ${q.summary}`);
    return { quote: q.quote, result: await ops.approveQuote(pid, q.quote.id) };
  }

  /* =============== 1. a real no-spend mode =============== */
  section("1. Spending off, and the sample, invoke zero paid adapters");
  {
    const mediaSpy = fakeMedia({ tripwire: true });
    const claudeSpy = fakeClaude({}, true);
    setProviders({ media: mediaSpy as never, claude: claudeSpy as never });

    const { pid, shots } = preview("Off", { budgetCents: 5000, allowanceCents: 500 });
    // A paid job queued while spending was on, then a restart with spending off.
    const queued = jobs.enqueue({ projectId: pid, kind: "image.storyboard", key: { x: 1 }, input: { projectId: pid, frameId: "f", shotId: shots[0].id, sceneId: "s" }, estCents: 5, provider: "kie" }).job;
    const thinking = pipeline.thinkJob(pid, "think.plan", { conceptId: "k0" }, "n1").job;
    process.env.FASTLANE_LIVE = "off";
    worker.recover();
    await drain();
    check("queued paid work is held at dispatch after a restart", jobs.getJob(queued.id)!.status === "queued" && !!jobs.getJob(queued.id)!.hold, JSON.stringify(jobs.getJob(queued.id)));
    check("queued model work is held at dispatch", jobs.getJob(thinking.id)!.status === "queued" && !!jobs.getJob(thinking.id)!.hold);

    const turn = await runAgentTurn(pid, "Push in more slowly", { stage: "direct", focus: { kind: "shot", id: shots[0].id, label: "Shot 01" } });
    check("chat does not call the model", claudeSpy.calls.length === 0 && /switched off/i.test(turn.text), turn.text);

    let blocked = false;
    try {
      await creative.interpretBrief({ idea: "x", kind: "commercial", duration: 30, aspect: "16:9", uploads: [], bill: { projectId: pid, purpose: "t" } });
    } catch (e) {
      blocked = e instanceof billing.SpendBlocked;
    }
    check("structured thinking is refused before any call", blocked && claudeSpy.calls.length === 0);

    const up = media(pid);
    await adoptUploads(pid, "idea", [up.id]);
    check("upload classification makes no call", claudeSpy.calls.length === 0);

    let enq = false;
    try {
      jobs.enqueue({ projectId: pid, kind: "video.clip", key: { y: 1 }, input: {}, estCents: 56 });
    } catch (e) {
      enq = e instanceof billing.SpendBlocked && e.code === "off";
    }
    check("new paid work cannot even be queued", enq);

    const r = await ops.runOp(pid, "redraw_storyboard", { shotId: shots[0].id }, "user");
    check("paid operations refuse with the reason", !r.ok && /switched off/i.test(r.summary), r.summary);

    let pub = false;
    try {
      const { mediaFor } = await import("../lib/providers");
      await mediaFor(pid).publish({ absPath: PNG, pathname: "x.png", contentType: "image/png" });
    } catch (e) {
      pub = e instanceof billing.SpendBlocked;
    }
    check("cloud publishing is blocked", pub);

    // A submitted image whose provider failed would fall back to a second paid model: not while spending is off.
    process.env.FASTLANE_LIVE = "on";
    const fb = jobs.enqueue({ projectId: pid, kind: "image.storyboard", key: { fb: 1 }, input: { projectId: pid, frameId: "f2", shotId: shots[0].id, sceneId: "s" }, estCents: 5, provider: "kie" }).job;
    jobs.claim(fb.id, ["queued"], "submitting");
    jobs.markSubmitted(fb.id, "kie", "task-x");
    db().prepare("update jobs set output = ? where id = ?").run(JSON.stringify({ submittedMeta: { engine: "gptImage", request: { prompt: "p", aspect: "16:9", references: [] } } }), fb.id);
    process.env.FASTLANE_LIVE = "off";
    const fbSpy = fakeMedia({ tripwire: true, kiePoll: () => ({ state: "fail", error: "Internal Error", transient: false }) });
    setProviders({ media: fbSpy as never, claude: claudeSpy as never });
    await worker.processJob(jobs.getJob(fb.id)!);
    const fbMedia = fbSpy.paidCalls();
    check("the image fallback is not bought while spending is off", fbMedia === 0 && jobs.getJob(fb.id)!.status === "failed", jobs.getJob(fb.id)!.error ?? "");
    check("the failed fallback releases its money", billing.spend(pid).reservedCents === 5, JSON.stringify(billing.spend(pid)));

    check("no paid adapter was touched with spending off", mediaSpy.paidCalls() === 0 && claudeSpy.calls.length === 0);
    process.env.FASTLANE_LIVE = "on";

    // The sample, with spending on.
    const sMedia = fakeMedia({ tripwire: true });
    const sClaude = fakeClaude({}, true);
    setProviders({ media: sMedia as never, claude: sClaude as never });
    await ensureSample();
    const sampleShot = state.shotsDoc(SAMPLE_ID)!.data.shots[3];
    const reply = await runAgentTurn(SAMPLE_ID, "Push in more slowly. Keep her beside the window.", { stage: "direct", focus: { kind: "shot", id: sampleShot.id, label: "Shot 04" } });
    check("sample chat replays a recorded reply and calls no model", sClaude.calls.length === 0 && reply.recorded === true && reply.results.some((x) => x.ok), reply.text);
    const other = await runAgentTurn(SAMPLE_ID, "Make her a pirate", { stage: "shots" });
    check("sample chat explains its limitation", /sample project/i.test(other.text) && sClaude.calls.length === 0);
    const sOp = await ops.runOp(SAMPLE_ID, "redraw_storyboard", { shotId: sampleShot.id }, "user");
    check("sample refuses paid operations", !sOp.ok);
    let sEnq = false;
    try {
      jobs.enqueue({ projectId: SAMPLE_ID, kind: "image.storyboard", key: { z: 1 }, input: {}, estCents: 5 });
    } catch (e) {
      sEnq = e instanceof billing.SpendBlocked && e.code === "sample";
    }
    check("sample cannot queue paid work", sEnq);
    const sJob = db().prepare("insert into jobs (id, project_id, kind, idem_key, status, input, est_cents, created_at, updated_at, charge_seq) values ('job_sample_x', ?, 'image.storyboard', 'k-sample-x', 'queued', '{}', 5, ?, ?, 1)").run(SAMPLE_ID, new Date().toISOString(), new Date().toISOString());
    void sJob;
    await drain();
    check("a stray queued sample job is held, never dispatched", jobs.getJob("job_sample_x")!.status === "queued" && sMedia.paidCalls() === 0);
  }

  /* =============== 2. payment approval belongs to the person =============== */
  section("2. Only the person can approve payment");
  {
    const claude = fakeClaude({});
    const m = fakeMedia();
    setProviders({ media: m as never, claude: claude as never });
    const agentTools = ops.opsForAgent();
    const leaked = agentTools.filter((t) => {
      const js = JSON.stringify(z.toJSONSchema(t.schema, { unrepresentable: "any" }));
      return /"(confirm|confirmed|authId|approve|approved|quoteId|token)"/.test(js);
    });
    check("no agent tool takes an approval or payment field", leaked.length === 0, leaked.map((t) => t.name).join(", "));
    check("person-only decisions are not agent tools", !agentTools.some((t) => ["approve_sequence", "approve_asset", "approve_animatic", "accept_final", "set_allowance", "set_budget", "resolve_job", "set_autopilot"].includes(t.name)));

    const { pid, shots } = preview("Approvals", { budgetCents: 100_00, allowanceCents: 300 });
    const before = jobs.projectJobs(pid).length;
    const sneaky = await ops.runOp(pid, "retake_shot", { shotId: shots[0].id, confirm: true, authId: "aut_fake" }, "agent");
    check("an agent's retake returns an estimate and buys nothing", !!sneaky.quote && jobs.projectJobs(pid).length === before, sneaky.summary);
    for (const name of ["approve_sequence", "set_allowance", "set_budget", "accept_final", "approve_animatic", "resolve_job"]) {
      const r = await ops.runOp(pid, name, { dollars: 5, cutId: "x", jobId: "x", action: "retry" }, "agent");
      check(`the agent cannot ${name}`, !r.ok && /person/i.test(r.summary), r.summary);
    }
    // Agent conversation: the model tries to pass confirm:true; nothing is bought.
    const agentClaude = fakeClaude({
      create: (_b, n) =>
        n === 0
          ? { usage, model: "claude-opus-5-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "start_production", input: { confirm: true } }] }
          : { usage, model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "It's waiting for your approval." }] },
    });
    setProviders({ media: m as never, claude: agentClaude as never });
    const r = await ops.runOp(pid, "approve_sequence", {}, "user");
    check("the person approves the sequence", r.ok, r.summary);
    const turn = await runAgentTurn(pid, "Make the film", { stage: "shots" });
    check("an agent turn ends with an estimate, not a purchase", !!turn.quote && !jobs.projectJobs(pid).some((j) => j.kind === "video.clip"), turn.text);

    // Repeated approval submits once.
    const q = turn.quote!;
    const first = await ops.approveQuote(pid, q.id);
    const second = await ops.approveQuote(pid, q.id);
    const clips = jobs.projectJobs(pid).filter((j) => j.kind === "video.clip").length;
    check("approving once buys the scope", first.ok && clips === shots.length, first.summary);
    check("approving twice buys nothing more", !second.ok && jobs.projectJobs(pid).filter((j) => j.kind === "video.clip").length === clips, second.summary);
    check("one authorization per approval", billing.authorizations(pid).filter((a) => a.kind === "production").length === 1);

    // A stale quote buys nothing.
    const { pid: p2, shots: s2 } = preview("Stale", { budgetCents: 100_00, allowanceCents: 300 });
    await ops.runOp(p2, "approve_sequence", {}, "user");
    const quote2 = await ops.runOp(p2, "retake_shot", { shotId: s2[1].id }, "user");
    await ops.runOp(p2, "direct_shot", { shotId: s2[1].id, commands: [{ op: "camera_move", move: "orbit", amount: 30 }] }, "user");
    const stale = await ops.approveQuote(p2, quote2.quote!.id);
    check("a quote whose inputs changed buys nothing", !stale.ok && !jobs.projectJobs(p2).some((j) => j.kind === "video.clip"), stale.summary);

    // Repairs pause at the approved ceiling even with money left in the project.
    const reviewFail = fakeClaude({ parse: () => ({ usage, model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: { usable: false, identity: "drifted", location: "consistent", props: "not_applicable", adherence: "poor", generatedText: false, defects: ["face drift"], summary: "Face drifts.", repairHint: "Keep her face as in the reference." } }) });
    setProviders({ media: fakeMedia() as never, claude: reviewFail as never });
    const { pid: p3 } = preview("Ceiling", { budgetCents: 100_00, allowanceCents: 300, shots: 3 });
    await ops.runOp(p3, "approve_sequence", {}, "user");
    await approveProduction(p3);
    // The person's approved ceiling covers the first takes, sound and reviews, but not a repair.
    const prod = billing.authorizations(p3).find((a) => a.kind === "production")!;
    const committed = billing.authUsage(prod.id);
    const tight = committed.spentCents + committed.reservedCents + 3 * pipeline.REVIEW_CENTS.bound + 2;
    db().prepare("update authorizations set ceiling_cents = ? where id = ?").run(tight, prod.id);
    await drain(30);
    const used = billing.authUsage(prod.id);
    const left = billing.spend(p3).remainingCents;
    check("repairs stop at the approved ceiling", used.spentCents + used.reservedCents <= tight, `${used.spentCents}+${used.reservedCents} > ${tight}`);
    check("…even though the project still has money left", left > 1000, String(left));
    const pipe = state.pipelineOf(repo.getProject(p3)!);
    check("production says it paused at the ceiling", !pipe.produce && pipe.paused?.code === "ceiling", JSON.stringify(pipe.paused));
    check("the repairs it couldn't afford were not bought", jobs.projectJobs(p3).filter((j) => j.kind === "video.clip").length === 3);
  }

  /* =============== 3. job ownership and reuse =============== */
  section("3. Jobs belong to one project; reused results reach every record");
  {
    const m = fakeMedia();
    setProviders({ media: m as never, claude: fakeClaude({}) as never });
    const a = preview("Voice A", { budgetCents: 1000, allowanceCents: 300 });
    const b = preview("Voice B", { budgetCents: 1000, allowanceCents: 300 });
    const ja = jobs.enqueue({ projectId: a.pid, kind: "audio.voice", key: { text: "Ride into spring.", voiceId: "v" }, input: { projectId: a.pid, lineId: "x", text: "Ride into spring.", voiceId: "v" }, estCents: 5 });
    const jb = jobs.enqueue({ projectId: b.pid, kind: "audio.voice", key: { text: "Ride into spring.", voiceId: "v" }, input: { projectId: b.pid, lineId: "x", text: "Ride into spring.", voiceId: "v" }, estCents: 5 });
    check("identical narration in two projects makes two jobs", ja.job.id !== jb.job.id && !jb.reused && jb.job.project_id === b.pid);
    check("each project reserves its own money", billing.spend(b.pid).reservedCents === 5 && billing.spend(a.pid).reservedCents === 5);
    const ca = jobs.enqueue({ projectId: a.pid, kind: "image.concept", key: { prompt: "same", aspect: "16:9" }, input: {}, estCents: 5 });
    const cb = jobs.enqueue({ projectId: b.pid, kind: "image.concept", key: { prompt: "same", aspect: "16:9" }, input: {}, estCents: 5 });
    check("identical concept prompts in two projects make two jobs", ca.job.id !== cb.job.id);

    // Repeated lines inside one project, pending reuse and completed reuse.
    const rep = preview("Repeat", { budgetCents: 1000, allowanceCents: 300, lines: ["Ride into spring.", "Ride into spring."] });
    pipeline.startSound(rep.pid, billing.allowanceOf(rep.pid)!.id);
    const voiceJobs = jobs.projectJobs(rep.pid).filter((j) => j.kind === "audio.voice");
    const rows = db().prepare("select * from audio where project_id = ? and kind = 'voice'").all(rep.pid) as { id: string; job_id: string; status: string; media_id: string | null }[];
    check("two identical lines share one recording job", voiceJobs.length === 1 && rows.length === 2 && rows.every((r) => r.job_id === voiceJobs[0].id));
    await drain();
    const after = db().prepare("select * from audio where project_id = ? and kind = 'voice'").all(rep.pid) as { status: string; media_id: string | null }[];
    check("both line records receive the recording", after.every((r) => r.status === "ready" && !!r.media_id), JSON.stringify(after));
    check("the shared recording is charged once", billing.ledgerLines(rep.pid).filter((l) => l.note === "audio.voice").length === 1);
    // A later request for the same words attaches immediately.
    const plan = state.planDoc(rep.pid)!;
    repo.writeDoc(rep.pid, "plan", { ...plan.data, beats: [{ ...plan.data.beats[0], lines: [...plan.data.beats[0].lines, { id: "b1l3", kind: "vo", text: "Ride into spring." }] }] }, { author: "user", inputs: plan.inputs });
    pipeline.startSound(rep.pid, billing.allowanceOf(rep.pid)!.id);
    const late = db().prepare("select status, media_id from audio where project_id = ? and line_key = 'b1l3'").get(rep.pid) as { status: string; media_id: string | null };
    check("a request after completion is attached at once, free", late.status === "ready" && !!late.media_id && jobs.projectJobs(rep.pid).filter((j) => j.kind === "audio.voice").length === 1);

    // Failed reuse: buying again reserves again and lands on the record.
    const fr = preview("Failed reuse", { budgetCents: 1000, allowanceCents: 300 });
    let failNext = true;
    setProviders({ media: { ...fakeMedia(), speak: async (i: { outPath: string }) => { if (failNext) { failNext = false; throw new Error("provider said no"); } fs.mkdirSync(path.dirname(i.outPath), { recursive: true }); fs.copyFileSync(MP3, i.outPath); return { durationMs: 1500, words: [], cents: 1 }; } } as never, claude: fakeClaude({}) as never });
    pipeline.startSound(fr.pid, billing.allowanceOf(fr.pid)!.id);
    await drain();
    const fj = jobs.projectJobs(fr.pid).find((j) => j.kind === "audio.voice")!;
    const voiceLedger = db().prepare("select kind, coalesce(sum(cents), 0) as c from ledger where job_id = ? group by kind").all(fj.id) as { kind: string; c: number }[];
    const vk = Object.fromEntries(voiceLedger.map((r) => [r.kind, Number(r.c)]));
    check("a failed purchase releases its money", fj.status === "failed" && (vk.reserve ?? 0) === (vk.release ?? 0) && !vk.charge, JSON.stringify(vk));
    const rr = worker.retryJob(fj.id);
    await drain();
    const fresh = jobs.getJob(fj.id)!;
    const rowNow = db().prepare("select status, media_id from audio where job_id = ?").get(fj.id) as { status: string; media_id: string | null };
    check("retrying reserves afresh and lands on the same record", rr.ok && fresh.status === "succeeded" && fresh.charge_seq === 2 && rowNow.status === "ready" && !!rowNow.media_id, JSON.stringify({ rr, fresh: fresh.status, rowNow }));
  }

  /* =============== 4. settlement and retries =============== */
  section("4. Settlement is atomic; retries check the budget");
  {
    setProviders({ media: fakeMedia() as never, claude: fakeClaude({}) as never });
    const { pid } = preview("Settle", { budgetCents: 1000, allowanceCents: 300 });
    const j = jobs.enqueue({ projectId: pid, kind: "image.asset", key: { s: 1 }, input: {}, estCents: 5 }).job;
    jobs.claim(j.id, ["queued"], "submitting");
    const one = jobs.succeed(jobs.getJob(j.id)!, { fixture: true }, 5);
    const two = jobs.succeed(jobs.getJob(j.id)!, { fixture: true }, 5);
    check("two completion callbacks settle once", one && !two && billing.spend(pid).spentCents === 5, JSON.stringify(billing.spend(pid)));
    const k = jobs.enqueue({ projectId: pid, kind: "image.asset", key: { s: 2 }, input: {}, estCents: 5 }).job;
    jobs.claim(k.id, ["queued"], "submitting");
    jobs.fail(jobs.getJob(k.id)!, "no");
    jobs.succeed(jobs.getJob(k.id)!, {}, 5);
    check("a completion after failure records nothing", billing.spend(pid).spentCents === 5);

    const poll = jobs.enqueue({ projectId: pid, kind: "image.asset", key: { s: 3 }, input: {}, estCents: 5 }).job;
    jobs.claim(poll.id, ["queued"], "submitting");
    jobs.markSubmitted(poll.id, "kie", "task-1");
    check("two workers cannot own the same poll", jobs.leasePoll(poll.id, 60, "worker-A") && !jobs.leasePoll(poll.id, 60, "worker-B"));

    // Zero-budget retry fails.
    const zero = preview("Zero", { budgetCents: 0 });
    const zjob = db()
      .prepare("insert into jobs (id, project_id, kind, idem_key, status, input, est_cents, created_at, updated_at, charge_seq) values ('job_zero', ?, 'image.storyboard', 'k-zero', 'failed', '{}', 5, ?, ?, 1)")
      .run(zero.pid, new Date().toISOString(), new Date().toISOString());
    void zjob;
    const zr = worker.retryJob("job_zero");
    check("a retry with no approved money is refused", !zr.ok && jobs.getJob("job_zero")!.status === "failed" && billing.spend(zero.pid).reservedCents === 0, zr.summary);

    // Ambiguous work keeps its provider identity and its liability.
    const amb = jobs.enqueue({ projectId: pid, kind: "image.asset", key: { s: 4 }, input: {}, estCents: 5 }).job;
    jobs.claim(amb.id, ["queued"], "submitting");
    jobs.markSubmitted(amb.id, "kie", "task-amb");
    jobs.markAmbiguous(jobs.getJob(amb.id)!, "No result after 45 minutes");
    check("uncertain work keeps its money held", billing.spend(pid).uncertainCents >= 5);
    check("uncertain work cannot be dropped to release money", !jobs.cancel(amb.id) && billing.spend(pid).uncertainCents >= 5);
    const ca = worker.checkAgain(amb.id);
    check("checking again keeps the provider task id", ca.ok && jobs.getJob(amb.id)!.provider_task_id === "task-amb" && jobs.getJob(amb.id)!.status === "submitted");
    jobs.markAmbiguous(jobs.getJob(amb.id)!, "still unknown");
    const spentBefore = billing.spend(pid);
    const ba = worker.buyAgain(amb.id);
    const spentAfter = billing.spend(pid);
    check("buying again reserves new money and keeps the old hold", ba.ok && spentAfter.reservedCents === spentBefore.reservedCents + 5 && jobs.getJob(amb.id)!.status === "ambiguous", JSON.stringify({ ba, spentBefore, spentAfter }));
    jobs.resolveUncertain(amb.id, "not_charged");
    check("a person's ruling releases the hold", billing.spend(pid).uncertainCents === 0);
  }

  /* =============== 5. model usage on every exit path =============== */
  section("5. Every billable model response is recorded");
  {
    const { pid } = preview("Usage", { budgetCents: 1000, allowanceCents: 300 });
    // A failed second conversation call keeps the first call's charge.
    setProviders({
      media: fakeMedia() as never,
      claude: fakeClaude({
        create: (_b, n) => {
          if (n === 0) return { usage, model: "claude-opus-5-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "get_plan", input: {} }] };
          throw new Anthropic.InternalServerError(500, { error: { message: "boom" } }, "boom", new Headers());
        },
      }) as never,
    });
    const before = billing.spend(pid).spentCents;
    let threw = false;
    try {
      await runAgentTurn(pid, "What's the plan?", { stage: "shots" });
    } catch {
      threw = true;
    }
    const s = billing.spend(pid);
    check("a failed second call keeps the first call's charge", !threw ? s.spentCents - before === 2 : s.spentCents - before === 2, `${s.spentCents - before}`);
    check("nothing stays reserved after the failed call", s.reservedCents === 0, JSON.stringify(s));

    // Invalid structured output keeps known usage.
    setProviders({ media: fakeMedia() as never, claude: fakeClaude({ parse: () => ({ usage, model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: null }) }) as never });
    const b2 = billing.spend(pid).spentCents;
    let invalid = false;
    try {
      await structured({ schema: z.object({ a: z.string() }), system: "s", prompt: "p", bill: { projectId: pid, purpose: "test", authId: billing.allowanceOf(pid)!.id } });
    } catch {
      invalid = true;
    }
    check("an invalid structured answer still records its usage", invalid && billing.spend(pid).spentCents - b2 === 2);
    const line = billing.ledgerLines(pid)[0];
    check("charges record model and basis", line.basis === "usage" && (line.meta as { model?: string })?.model === "claude-opus-5-5");

    // Zero budget stops the call.
    const spy = fakeClaude({}, true);
    setProviders({ media: fakeMedia() as never, claude: spy as never });
    const zero = preview("Zero model", { budgetCents: 0 });
    let stopped = false;
    try {
      await structured({ schema: z.object({ a: z.string() }), system: "s", prompt: "p", bill: { projectId: zero.pid, purpose: "test" } });
    } catch (e) {
      stopped = e instanceof billing.SpendBlocked;
    }
    check("no approved money means no model call", stopped && spy.calls.length === 0);
    const zt = await runAgentTurn(zero.pid, "Hello", { stage: "brief" });
    check("chat without an allowance asks for one and calls nothing", spy.calls.length === 0 && /allowance/i.test(zt.text) && billing.spend(zero.pid).spentCents === 0, zt.text);

    // Text-only creation records its costs.
    const canned = (schemaName: string) => {
      switch (schemaName) {
        case "brief":
          return { title: "Seeds", summary: "A short film about two sisters.", purpose: "Grief and reconciliation", audience: "Adults", tone: "Restrained", pacing: "Slow", supplied: { purpose: true, audience: false, tone: false }, facts: ["Two sisters"], assumptions: ["Dawn"], needsProductImage: false, questions: [] };
        case "concepts":
          return { concepts: [0, 1, 2].map((i) => ({ title: `C${i}`, tag: "T", pitch: "One sentence.", logline: "L", hook: "H", structure: "S", story: Array.from({ length: 4 }, (_, b) => ({ title: `Beat ${b + 1}`, visual: "The sisters work in the garden.", lines: [] })), why: "W", look: "Grey light", imagePrompt: "I", recommended: i === 0 })) };
        case "plan":
          return { title: "Seeds", summary: "Two sisters.", treatment: "T", beats: [{ start: 0, end: 30, scene: "INT. SHED", visual: "Ruth finds the tin.", sound: "Wind", lines: [] }, { start: 30, end: 60, scene: "EXT. PLOT", visual: "They plant.", sound: "Birds", lines: [{ kind: "dialogue", speaker: "Claire", text: "I always picked them too soon." }] }], voiceStyle: "none", musicMood: "piano", endCardLine: "", endCardDetail: "" };
        case "assets":
          return { characters: [{ name: "Ruth", description: "d", look: "l", role: "Lead", height: 1.7 }], locations: [{ name: "Plot", description: "d", look: "l", role: "Exterior", setPreset: "park" }], props: [] };
        default:
          return { shots: Array.from({ length: 10 }, (_, i) => ({ title: `S${i}`, summary: "Ruth stands", beatId: i < 5 ? "b1" : "b2", duration: 6, framing: "medium", move: "static", lens: 35, description: "d", action: "Ruth stands", location: "Plot", characters: ["Ruth"], props: [], lineIds: [], speaker: "" })) };
      }
    };
    const order = ["brief", "concepts", "plan", "assets", "shots"];
    let call = 0;
    setProviders({ media: fakeMedia() as never, claude: fakeClaude({ parse: () => ({ usage, model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: canned(order[call++]) }) }) as never });
    const t = await runTextOnly({ idea: "Two sisters at their late father's allotment", kind: "film", duration: 60, aspect: "9:16", allowanceCents: 200 });
    check("a text-only run records every model charge", t.spentCents === 10 && billing.ledgerLines(t.pid).length === 5, `${t.spentCents}`);
  }

  /* =============== 6. animatic versus final =============== */
  section("6. An animatic is never a final cut");
  {
    setProviders({ media: fakeMedia() as never, claude: fakeClaude({}) as never });
    const { pid, shots } = preview("Animatic", { budgetCents: 1000, allowanceCents: 300 });
    const cut = pipeline.queueCut(pid, "Animatic");
    await drain();
    const fin = await ops.runOp(pid, "accept_final", { cutId: cut.id }, "user");
    check("a cut of stand-in frames cannot be accepted as final", !fin.ok && /stand-in/.test(fin.summary), fin.summary);
    const ani = await ops.runOp(pid, "approve_animatic", { cutId: cut.id }, "user");
    check("it can be approved as an animatic", ani.ok && repo.getCut(cut.id)!.acceptance === "animatic");
    const previewFile = db().prepare("select path from media where id = ?").get(repo.getCut(cut.id)!.media_id) as { path: string } | undefined;
    check("the preview file stays exportable and is named as a preview", !!previewFile && /-preview-/.test(previewFile.path), previewFile?.path ?? "none");
    await ops.runOp(pid, "approve_sequence", {}, "user");
    const v = buildView(pid)!;
    check("generating footage stays available beside an existing animatic", v.next?.kind === "generate" && !!v.estimate?.shots.length, JSON.stringify(v.next));
    process.env.FASTLANE_LIVE = "off";
    const off = buildView(pid)!;
    check("…and says why it's unavailable when spending is off", off.next?.kind === "off");
    process.env.FASTLANE_LIVE = "on";

    // Exhausted repairs end in attention, not "every shot has a take".
    const bad = fakeClaude({ parse: () => ({ usage, model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: { usable: false, identity: "drifted", location: "consistent", props: "not_applicable", adherence: "poor", generatedText: false, defects: ["morphing"], summary: "Morphs.", repairHint: "Hold still." } }) });
    setProviders({ media: fakeMedia() as never, claude: bad as never });
    const ex = preview("Exhausted", { budgetCents: 100_00, allowanceCents: 300, shots: 3 });
    await ops.runOp(ex.pid, "approve_sequence", {}, "user");
    await approveProduction(ex.pid);
    // A generous ceiling, so the repairs are limited by the repair rule rather than by money.
    db().prepare("update authorizations set ceiling_cents = 5000 where project_id = ? and kind = 'production'").run(ex.pid);
    await drain(60);
    const pipe = state.pipelineOf(repo.getProject(ex.pid)!);
    const msgs = repo.listMessages(ex.pid, 50).map((m) => m.content.text);
    const takes = repo.takesForProject(ex.pid);
    check("each shot got the first take plus two repairs", takes.length === 3 * 3, String(takes.length));
    check("exhausted repairs end in attention-required", (pipe.attention ?? []).length === 3 && !pipe.produce, JSON.stringify(pipe));
    check("nothing announces completed footage", !msgs.some((t) => /every shot has a take|all \d+ shots have usable takes/i.test(t)), msgs.join(" | "));
    const review = repo.listCuts(ex.pid)[0];
    check("the review cut is labelled as needing attention", !!review && /attention/i.test(review.note ?? ""), review?.note ?? "");
    const finalTry = await ops.runOp(ex.pid, "accept_final", { cutId: review.id }, "user");
    check("…and cannot become final", !finalTry.ok);
    void shots;
  }

  /* =============== the October 14 reproduction, as assertions =============== */
  section("Reproduction cases, now asserting the corrected behaviour");
  {
    setProviders({ media: fakeMedia() as never, claude: fakeClaude({}) as never });
    const a = preview("Repro A", { budgetCents: 100, allowanceCents: 100 });
    const b = preview("Repro B", { budgetCents: 100, allowanceCents: 100 });
    const first = jobs.enqueue({ projectId: a.pid, kind: "audio.voice", key: { text: "Ride into spring.", voiceId: "fixture" }, input: {}, estCents: 5 });
    const second = jobs.enqueue({ projectId: b.pid, kind: "audio.voice", key: { text: "Ride into spring.", voiceId: "fixture" }, input: {}, estCents: 5 });
    check("cross-project reuse: B gets its own job and reservation", !second.reused && second.job.id !== first.job.id && billing.spend(b.pid).reservedCents === 5);
    const c = preview("Repro C", { budgetCents: 100, allowanceCents: 100 });
    const paid = jobs.enqueue({ projectId: c.pid, kind: "image.asset", key: { pid: c.pid }, input: {}, estCents: 5 }).job;
    jobs.succeed(paid, { fixture: true }, 5);
    jobs.succeed(paid, { fixture: true }, 5);
    check("repeated settlement charges 5, not 10", billing.spend(c.pid).spentCents === 5);
    const d = preview("Repro D", { budgetCents: 0 });
    let refused = false;
    try {
      billing.reserve(d.pid, { cls: "model", cents: 20, ref: "direct-charge", note: "fixture" });
    } catch {
      refused = true;
    }
    check("a direct charge on a zero budget is refused", refused && billing.spend(d.pid).remainingCents === 0);
    const retake = ops.opsForAgent().find((x) => x.name === "retake_shot")!;
    const parsed = retake.schema.safeParse({ shotId: "fixture", confirm: true });
    check("the agent's retake schema drops any confirmation field", parsed.success && !("confirm" in (parsed.data as object)));
  }

  section("7. Final review, held reviews, and the separate project limit");
  {
    setProviders({ media: fakeMedia() as never, claude: fakeClaude({ parse: () => ({ usage, model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: { usable: true, identity: "consistent", location: "consistent", props: "consistent", adherence: "good", generatedText: false, defects: [], summary: "Matches the approved references.", repairHint: "" } }) }) as never });
    const { pid, shots } = preview("Final safeguards", { budgetCents: 10000, allowanceCents: 300, shots: 6 });
    await ops.runOp(pid, "approve_sequence", {}, "user");
    await approveProduction(pid);
    await drain(25);
    const cut = repo.listCuts(pid).find((c) => c.status === "ready")!;
    check("reviewed, current footage is eligible for final acceptance", !!cut && ops.finalReadiness(pid, cut.id).ok, cut && JSON.stringify(ops.finalReadiness(pid, cut.id)));
    const manifest = JSON.parse(cut.manifest);
    const takeId = manifest.shots[0].takeId as string;
    const take = repo.getTake(takeId)!;
    const review = take.review;
    db().prepare("update takes set review = null, verdict = 'none' where id = ?").run(takeId);
    check("unreviewed footage cannot pass final readiness", !ops.finalReadiness(pid, cut.id).ok && ops.finalReadiness(pid, cut.id).reasons.some((r) => /needs review/.test(r)));
    check("a missing review is not a usable take", state.shotStates(pid, shots)[0].needsTake);
    const held = jobs.enqueue({ projectId: pid, kind: "review.take", key: { recheck: takeId }, input: { projectId: pid, takeId }, estCents: 0, provider: "anthropic" }).job;
    jobs.holdJob(held.id, "Approved ceiling reached");
    const before = billing.spend(pid);
    const offer = await ops.runOp(pid, "resume_reviews", { jobIds: [held.id] }, "agent");
    check("resuming held reviews offers a quote without spending", !!offer.quote && billing.spend(pid).spentCents === before.spentCents && !!jobs.getJob(held.id)!.hold);
    const resumed = await ops.approveQuote(pid, offer.quote!.id);
    check("review approval reuses the held job and buys no footage", resumed.ok && !jobs.getJob(held.id)!.hold && !state.pipelineOf(repo.getProject(pid)!).produce && billing.spend(pid).budgetCents === before.budgetCents, resumed.summary);
    check("review approval is single use", !(await ops.approveQuote(pid, offer.quote!.id)).ok);
    jobs.holdJob(held.id, "Test pause");
    const denied = await ops.runOp(pid, "accept_take", { takeId }, "agent");
    check("the creative agent cannot override a missing or failed review", !denied.ok && repo.getTake(takeId)!.verdict === "none");
    const chosen = await ops.runOp(pid, "accept_take", { takeId }, "user");
    check("manual selection cancels only its undispatched review", chosen.ok && jobs.getJob(held.id)!.status === "cancelled" && repo.getTake(takeId)!.review === null);
    check("manual selection is explicitly distinguished from automated review", ops.finalReadiness(pid, cut.id).ok && ops.finalReadiness(pid, cut.id).manualShots === 1);
    check("cleanup is idempotent and costs nothing", ops.clearChosenReviews(pid) === 0 && billing.spend(pid).spentCents === before.spentCents);
    db().prepare("update takes set review = ?, verdict = 'rejected' where id = ?").run(review, takeId);
    check("a rejected take cannot be final even if its automated review passed", ops.finalReadiness(pid, cut.id).reasons.some((r) => /set aside/.test(r)));
    db().prepare("update takes set verdict = 'accepted' where id = ?").run(takeId);
    const asset = state.assetIdentities(pid)[0];
    db().prepare("update assets set approved_version_id = null where id = ?").run(asset.asset.id);
    check("an unapproved asset used in the film blocks final acceptance", ops.finalReadiness(pid, cut.id).reasons.some((r) => /in Assets/.test(r)));
    db().prepare("update assets set approved_version_id = ? where id = ?").run(asset.version!.id, asset.asset.id);
    const other = preview("Other project", { budgetCents: 100 });
    check("final readiness checks cut ownership", !ops.finalReadiness(other.pid, cut.id).ok);
    const reordered = [...shots].reverse();
    repo.writeDoc(pid, "shots", { shots: reordered }, { author: "user", inputs: { plan: 1 } });
    check("a changed edit order requires a newly assembled cut", ops.finalReadiness(pid, cut.id).reasons.some((r) => /assemble a new/.test(r)));
    const zero = preview("Hard limit", { budgetCents: 5 });
    let blocked = false;
    try { billing.createAuthorization(zero.pid, { kind: "retry", label: "Over limit", covers: ["model"], ceilingCents: 16 }); } catch (e) { blocked = e instanceof billing.SpendBlocked && e.code === "limit"; }
    check("an approval cannot silently increase the project limit", blocked && billing.spend(zero.pid).budgetCents === 5 && billing.authorizations(zero.pid).length === 0);
    // Lower the hard cap first, then verify failure keeps the prior allowance intact.
    await ops.runOp(pid, "set_budget", { dollars: (billing.spend(pid).spentCents + 1) / 100 }, "user");
    const active = billing.allowanceOf(pid)!;
    const failedAllowance = await ops.runOp(pid, "set_allowance", { dollars: 50 }, "user");
    check("a refused replacement preserves the existing planning allowance", !failedAllowance.ok && billing.allowanceOf(pid)?.id === active.id);
  }

  console.log(`\nsafety checks: ${passed} passed, ${failures.length} failed; network attempts: ${networkAttempts}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures.length || networkAttempts ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
