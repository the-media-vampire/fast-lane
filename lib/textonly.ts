import { allowanceOf, createAuthorization, spend } from "./billing";
import * as creative from "./creative";
import * as repo from "./repo";
import * as state from "./state";
import * as pipeline from "./pipeline";
import { framingIssues } from "./blocking/visibility";
import type { Aspect, Brief, Kind } from "./types";

/**
 * A text-only run of the creative lane: one sentence → interpreted brief → three directions →
 * plan → cast and places → shots → grey blocking, saved as a real project. Claude only; no
 * images or video. Every model response is charged to the project's ledger through the same
 * meter as the studio, under a planning allowance the person sets for the run.
 */
export async function runTextOnly(input: { idea: string; kind: Kind; duration: number; aspect: Aspect; allowanceCents: number; log?: (line: string) => void }) {
  const log = input.log ?? (() => undefined);
  const pid = repo.createProject({ title: "Untitled", kind: input.kind, duration: input.duration, aspect: input.aspect, budgetCents: input.allowanceCents });
  createAuthorization(pid, { kind: "allowance", label: "Planning allowance (text-only run)", covers: ["model"], ceilingCents: input.allowanceCents });
  const bill = (purpose: string) => ({ projectId: pid, purpose, authId: allowanceOf(pid)?.id ?? null });
  log(`project ${pid}`);

  const b = await creative.interpretBrief({ idea: input.idea, kind: input.kind, duration: input.duration, aspect: input.aspect, uploads: [], bill: bill("Reading the brief") });
  const brief: Brief = { idea: input.idea, title: b.data.title, kind: input.kind, duration: input.duration, aspect: input.aspect, summary: b.data.summary, purpose: b.data.purpose, audience: b.data.audience, tone: b.data.tone, pacing: b.data.pacing, supplied: b.data.supplied, facts: b.data.facts, assumptions: b.data.assumptions, questions: b.data.questions, needsProductImage: b.data.needsProductImage, uploads: [] };
  repo.writeDoc(pid, "brief", brief, { author: "agent", note: "Interpreted the idea" });
  repo.updateProject(pid, { title: brief.title });
  repo.addMessage(pid, "user", { text: input.idea });
  repo.addMessage(pid, "agent", { text: b.data.summary });
  log(`BRIEF ${brief.title} | ${brief.purpose}`);

  const c = await creative.proposeConcepts({ brief, bill: bill("Developing directions") });
  const chosen = c.concepts.find((k) => k.recommended)!;
  repo.writeDoc(pid, "concepts", { concepts: c.concepts, chosenId: chosen.id }, { author: "agent", note: "Three directions (text-only run)" });
  log(`CONCEPTS ${c.concepts.map((k) => `${k.title}${k.recommended ? " *" : ""}`).join(", ")}`);

  const pl = await creative.writePlan({ brief, concept: chosen, bill: bill("Writing the plan") });
  repo.writeDoc(pid, "plan", pl.plan, { author: "agent", note: "First draft", inputs: { brief: 1, concepts: 1, conceptId: chosen.id } });
  log(`PLAN ${pl.plan.title}: ${pl.plan.beats.length} beats`);

  const as = await creative.planAssets({ brief, concept: chosen, plan: pl.plan, existing: [], bill: bill("Planning the cast") });
  for (const a of as.assets) repo.createAsset({ projectId: pid, kind: a.kind, name: a.name, data: a.data });
  state.setPipeline(pid, { assetsForPlan: 1 });
  log(`ASSETS ${as.assets.map((a) => a.name).join(", ")}`);

  const assets = repo.listAssets(pid).map((a) => ({ id: a.id, kind: a.kind, name: a.name }));
  const sh = await creative.proposeShots({ brief, concept: chosen, plan: pl.plan, assets, bill: bill("Planning the shots") });
  repo.writeDoc(pid, "shots", { shots: sh.shots }, { author: "agent", note: "Shot plan", inputs: { plan: 1 } });
  const p = repo.getProject(pid)!;
  const ids = state.assetIdentities(pid);
  let issues = 0;
  for (const s of sh.shots) {
    const scene = pipeline.blockShot(p, s, ids);
    repo.writeScene(pid, s.id, scene, "system", "Automatic blocking from the shot plan");
    issues += framingIssues(scene).length;
  }
  log(`SHOTS ${sh.shots.length}, ${sh.shots.reduce((a, s) => a + s.duration, 0)} s of ${input.duration} s; framing issues: ${issues}`);
  pipeline.queueCaptures(pid);
  repo.addMessage(pid, "agent", { text: "Text-only run: plan, cast, shots and grey blocking are ready. No pictures were bought." });
  const s = spend(pid);
  log(`Recorded model cost: $${(s.spentCents / 100).toFixed(2)}`);
  return { pid, spentCents: s.spentCents, shots: sh.shots.length, issues };
}
