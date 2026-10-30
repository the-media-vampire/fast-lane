import { addMessage, latestScene, type MessageContent } from "../repo";
import { runOp, type OpResult } from "../ops";
import { shotsDoc } from "../state";
import type { Stage } from "../types";
import type { AgentTurn, Focus } from "./astra";

/**
 * The sample project's conversation. It never calls a model: a few recorded exchanges replay
 * real, free operations (blocking and timing), and anything else gets a plain explanation.
 * Every reply is marked as recorded in the panel.
 */

export const SAMPLE_PROMPTS: Partial<Record<Stage, string[]>> = {
  brief: ["Why one character?"],
  concept: ["Why this direction?"],
  assets: ["Why these three?"],
  shots: ["Hold this moment longer.", "Push in more slowly. Keep her beside the window.", "Why no dialogue?"],
  direct: ["Push in more slowly. Keep her beside the window.", "Hold this moment longer.", "Keep the camera still."],
  cut: ["Hold this moment longer."],
};

const norm = (t: string) => t.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

const EXPLAIN: Record<string, string> = {
  [norm("Why one character?")]: "One person carries the feeling and keeps every shot consistent. A second character would split 45 seconds in two.",
  [norm("Why this direction?")]: "The quiet hour has one character and one beautiful room, so the feeling has space. The other two lean on craft or a second person.",
  [norm("Why no dialogue?")]: "A single voice line lands harder in a quiet film, and words on screen carry the brand line.",
  [norm("Why these three?")]: "Mara, the café and the cup appear in almost every shot. Keeping them fixed is what makes the film hold together.",
};

export async function recordedTurn(pid: string, text: string, ctx: { stage: Stage; focus?: Focus | null }): Promise<AgentTurn> {
  const said = norm(text);
  const shots = shotsDoc(pid)?.data.shots ?? [];
  const focusShot = ctx.focus && (ctx.focus.kind === "shot" || ctx.focus.kind === "moment") ? shots.find((s) => s.id === ctx.focus!.id) : null;
  const results: OpResult[] = [];
  let reply: string;

  if (EXPLAIN[said]) {
    reply = EXPLAIN[said];
  } else if (said.includes("push in") && said.includes("window")) {
    const shot = focusShot && focusShot.characterIds.length ? focusShot : (shots.find((s) => s.id === "s04") ?? shots[0]);
    const scene = shot ? latestScene(pid, shot.id) : null;
    const window = scene?.data.set.features.find((f) => f.kind === "window");
    const actor = scene?.data.actors[0];
    if (!shot || !scene || !window || !actor) reply = "That shot has no one to place by the window. Select a shot with Mara.";
    else {
      const r = await runOp(pid, "direct_shot", { shotId: shot.id, commands: [{ op: "place_actor", actor: actor.id, near: window.id }, { op: "camera_move", move: "push_in", amount: 0.12, ease: "slow_in" }], summary: "Slower push-in; Mara by the window" }, "agent");
      results.push(r);
      reply = r.ok ? `The camera now eases in more slowly and ${actor.name} stays by the window. Only shot ${String(shots.indexOf(shot) + 1).padStart(2, "0")} changes.` : r.summary;
    }
  } else if (said.includes("longer") || said.includes("hold this")) {
    const shot = focusShot ?? shots[0];
    if (!shot) reply = "Select a shot first.";
    else {
      const r = await runOp(pid, "edit_shot", { shotId: shot.id, duration: Math.min(10, shot.duration + 1) }, "agent");
      results.push(r);
      reply = r.ok ? `Shot ${String(shots.indexOf(shot) + 1).padStart(2, "0")} now holds a second longer; the others give up the time. No pictures change.` : r.summary;
    }
  } else if (said.includes("camera still") || said.includes("lock") || said.includes("static")) {
    const shot = focusShot ?? shots[0];
    if (!shot) reply = "Select a shot first.";
    else {
      const r = await runOp(pid, "direct_shot", { shotId: shot.id, commands: [{ op: "camera_move", move: "static" }], summary: "Camera holds still" }, "agent");
      results.push(r);
      reply = r.ok ? "The camera now holds still. Both views follow." : r.summary;
    }
  } else {
    reply = "This is the sample project, so I don't call the model here and nothing costs money. Try a suggestion below, or start your own project to talk to me.";
  }

  const content: MessageContent & { cents?: number } = { text: reply, results: results.map((r) => ({ label: r.summary, ok: r.ok })), stage: ctx.stage, recorded: true, cents: 0 };
  addMessage(pid, "agent", content);
  return { text: reply, results, cents: 0, recorded: true, navigate: results.find((r) => r.navigate)?.navigate };
}
