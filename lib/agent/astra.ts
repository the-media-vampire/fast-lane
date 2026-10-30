import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MODEL, AGENT_BETAS, boundCents, metered } from "../llm";
import { describeForAgent } from "../blocking/describe";
import { addMessage, getProject, latestScene, listMessages, type MessageContent } from "../repo";
import { opsForAgent, runOp, type OpResult } from "../ops";
import { allowanceOf, authorizations, authUsage, authRemaining, spend, spendGate, SpendBlocked, money } from "../billing";
import { claudeClient } from "../providers";
import { assetIdentities, activeJobs, briefDoc, conceptsDoc, planDoc, shotStates, shotsDoc } from "../state";
import { sequenceStatus } from "../approvals";
import { planText } from "../creative";
import { movementPlain } from "../plain";
import { STAGE_LABELS, type Stage } from "../types";
import { VOICES } from "../voices";
import type { QuoteView } from "../quotes";
import { recordedTurn } from "./recorded";

/**
 * Astra: the conversational layer. Claude reads a compact snapshot of the project, including
 * exactly what the person has selected, and acts only through the validated operations in
 * lib/ops.ts (exposed as tools) plus three read/ask tools. No tool can approve payment or a
 * creative sign-off. Every model response is metered against the person's allowance.
 */

const SYSTEM = `You are Astra, the creative partner in Fast Lane — a studio that takes an idea to a finished 30-second to two-minute film (mostly commercials; also short films and light stories). Journey: Brief → Concept → Assets → Shots → Direct → Cut. Concept shows three cards and a shared story preview below them. Selecting a card only previews its 4–6 beats and actual spoken/on-screen words. Only the person's "Approve story & create assets" button commits the direction. There is no separate Plan screen; detailed timing stays internal.

How you answer:
- At most three short sentences — never more, even for a big change. Lead with what changed or the one thing you need. Don't restate the person's request back to them. No lists or headings unless asked. Plain words: "the camera moves closer", not lens jargon, unless the person uses it.
- Every change goes through a tool. Never say something changed unless a tool result says so. Mention what it affects and any cost in a short clause.
- The person's selection (in <selection>) is the default scope for local instructions ("this", "here", "her in this shot"). If an instruction could reasonably mean the selected item or every shot with that person, place or object, ask one short question with offer_choices (e.g. "This shot or every shot with her?") before changing anything.
- Change only what was asked. Keep every other detail, and treat approved references as fixed.
- Ask only consequential questions, with offer_choices (two or three options, one recommended).
- Keep the person's facts separate from your assumptions. Never invent a business's name, prices, offers, claims, addresses or URLs; use a clearly marked placeholder such as [shop name].

How to do common things:
- Concept story changes ("change the ending", "combine the first two"): get_concepts, then edit_concept_story for the selected concept. Preserve its other beats and exact words unless asked to change them. Drafts stay in the preview until the person approves. Never choose a concept or start assets from a preview click or a request to explore it. Use revise_plan only for production changes after story approval, not for editing a concept preview.
- Shots is the visual plan. Each storyboard card shows its action, duration, movement and any voiceover, dialogue or on-screen words. A spoken line is shown in full where it starts and marked as continuing on linked later shots. Use get_plan for line ids and edit_line for wording; revise_plan for structure. Keep scripts and treatments out of replies unless asked. Voice and music changes also happen through you, without a separate settings form.
- Wardrobe, appearance or background in one shot ("put her in a hat in this shot", "match the shop background"): edit_shot (direction, or the right location/cast ids), then redraw_storyboard with a short note. "Use the approved character reference": redraw_storyboard with a note to match it.
- Timing ("hold this longer"): edit_shot duration; the others adjust automatically. "Add a close-up after this": insert_shot after the selected shot. "Remove this shot": remove_shot.
- Direct is the animatic: the person can watch any combination of Storyboard, Camera and Overhead, play the whole film or one shot, and loop a shot. The selection follows the playing shot. Playback only uses existing media; never generate, redraw or assemble merely to change a view or play the animatic.
- Camera and staging ("push in more slowly", "keep her by the window"): get_shot first, then direct_shot. Coordinates are metres, floor centre is the origin, back wall at −z, open side +z; facing 0° looks toward +z, 90° toward +x. Prefer placement near a feature id. A slower push-in is a smaller amount (0.05–0.6 of the distance) and/or ease "slow_in"; pan and orbit amounts are degrees, track is metres.
- Assets ("another outfit", "a different face", "more angles"): asset_image. A new main image is only proposed until the person approves it; reference views go to the gallery.
- Notes on the cut arrive with the shot and time; act on that shot.

Money and approvals:
- Paid work either runs under the person's planning allowance or comes back as an estimate card that only the person can approve. Say what it costs and that it is waiting; never pressure.
- State a numeric cost only when it comes from the current snapshot or a tool result. Preserve the exact amount and label: spent, reserved, estimate, or ceiling. Never round a ceiling, invent a balance, or describe an estimate as an actual charge. If asked for detail, use get_costs. Approval of an estimate is separate from the project's overall limit.
- Approving the sequence, an asset, an animatic or the final cut, setting allowances and budgets are the person's own buttons. You cannot do them.
- Video always needs an approved estimate. The 3D blocking guides the storyboard frame and the written direction; video doesn't follow the 3D motion exactly.

The lane's limits: ≤3 recurring characters, ≤3 locations, ≤24 shots; simple performances (stand, sit, walk, turn, look, simple prop use); one visible speaker per shot; camera moves static, push_in, pull_out, pan, track, orbit. Bigger ideas (crowds, stunts, choreography) belong to the full production pipeline: offer the closest version within the lane.
Don't narrate tools or ids to the person; speak about the film.`;

const ReadShot = z.object({ shotId: z.string() });
const OfferChoices = z.object({
  question: z.string(),
  choices: z.array(z.object({ label: z.string(), detail: z.string().optional(), recommended: z.boolean().optional() })).min(2).max(3),
});

export type Focus = { kind: "shot" | "asset" | "concept" | "line" | "moment" | "cut" | "beat"; id?: string; label: string; time?: number; cutId?: string };

function toolDefs(): Anthropic.Beta.BetaToolUnion[] {
  const defs: Anthropic.Beta.BetaToolUnion[] = opsForAgent().map((o) => ({ name: o.name, description: o.description, input_schema: jsonSchema(o.schema) }));
  defs.push({ name: "get_shot", description: "Read one shot in full: its plan fields, its grey 3D blocking (set features with ids and positions, actors, props, camera), its storyboard and take status.", input_schema: jsonSchema(ReadShot) });
  defs.push({ name: "get_plan", description: "Read the full current plan with beat and line ids.", input_schema: jsonSchema(z.object({})) });
  defs.push({ name: "get_concepts", description: "Read all concept ideas and their complete story previews, including pending edits. Use before changing or combining story directions.", input_schema: jsonSchema(z.object({})) });
  defs.push({ name: "get_costs", description: "Read the recorded spend, reservations, project limit, and remaining authorizations. These are studio records, not a provider account balance.", input_schema: jsonSchema(z.object({})) });
  defs.push({ name: "offer_choices", description: "Show the person 2–3 tappable choices for one consequential question, one marked recommended. Use instead of asking open questions.", input_schema: jsonSchema(OfferChoices) });
  return defs;
}

function jsonSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  return { type: "object", ...js } as Anthropic.Beta.BetaTool.InputSchema;
}

/* ---------------- snapshot ---------------- */

export function snapshot(pid: string, stage: Stage, focus?: Focus | null): string {
  const p = getProject(pid)!;
  const brief = briefDoc(pid)?.data;
  const concepts = conceptsDoc(pid)?.data;
  const plan = planDoc(pid)?.data;
  const ids = assetIdentities(pid);
  const shots = shotsDoc(pid)?.data.shots ?? [];
  const states = shotStates(pid, shots, ids);
  const s = spend(pid);
  const allowance = allowanceOf(pid);
  const jobs = activeJobs(pid);
  const seq = shots.length ? sequenceStatus(pid, states) : null;
  const lines: string[] = [];
  lines.push(`Project "${p.title}": ${p.duration}s ${p.kind}, ${p.aspect}. The person is looking at: ${STAGE_LABELS[stage]}.`);
  lines.push(`Spent ${money(s.spentCents)}. Planning allowance: ${allowance ? `${money(Math.max(0, authRemaining(allowance)))} left` : "none set"}. Jobs running: ${jobs.length ? jobs.map((j) => j.kind).join(", ") : "none"}.`);
  if (brief) {
    lines.push(`Brief: ${brief.idea}`);
    if (brief.purpose) lines.push(`Purpose: ${brief.purpose} | Audience: ${brief.audience} | Tone: ${brief.tone} | Pacing: ${brief.pacing}`);
    if (brief.facts.length) lines.push(`Facts (from the person): ${brief.facts.join("; ")}`);
    if (brief.assumptions.length) lines.push(`Assumptions (yours): ${brief.assumptions.join("; ")}`);
    const open = brief.questions.filter((q) => !q.answer);
    if (open.length) lines.push(`Open questions: ${open.map((q) => `[${q.id}] ${q.question} (${q.choices.map((c) => c.label).join(" / ")})`).join("; ")}`);
  }
  if (concepts) lines.push(`Directions: ${concepts.concepts.map((c) => `[${c.id}] ${c.title}${c.recommended ? " (recommended)" : ""}${concepts.chosenId === c.id ? " ← CHOSEN" : ""}`).join("; ")}`);
  if (plan) lines.push(`Plan "${plan.title}": ${plan.beats.length} beats. Voice: ${VOICES.find((v) => v.id === plan.voice.voiceId)?.name ?? plan.voice.style}. Music: ${plan.music.mood}. End card: ${plan.endCard?.line ?? "none"}. (get_plan for lines)`);
  if (ids.length) lines.push(`Assets: ${ids.map((i) => `[${i.asset.id}] ${i.asset.kind} ${i.asset.name}${i.asset.approved_version_id ? " (approved)" : " (proposed)"}${i.version?.status === "pending" ? " (drawing)" : ""}`).join("; ")}`);
  if (shots.length) {
    lines.push(`Shots (sequence ${seq?.allApproved ? "approved for production" : seq?.approvedAt ? `approved, ${seq.changed.length} changed since` : "not yet approved"}):`);
    for (const st of states) {
      const sh = st.shot;
      const takeState = st.pick?.kind === "take" ? "footage ready" : st.pendingTake ? "footage generating" : st.takes.length ? "takes outdated/failed" : "no footage";
      lines.push(`  [${sh.id}] ${String(states.indexOf(st) + 1).padStart(2, "0")} ${sh.title} — ${sh.duration}s ${sh.framing}, ${movementPlain(sh, st.scene?.data)}; cast ${sh.characterIds.map((c) => ids.find((i) => i.asset.id === c)?.asset.name).filter(Boolean).join(", ") || "none"}; storyboard ${st.storyboardCurrent ? (st.storyboard?.status === "ready" ? "ready" : "drawing") : st.storyboard ? "outdated" : "missing"}; ${takeState}${sh.direction ? `; direction: ${sh.direction}` : ""}`);
    }
  }
  return lines.join("\n");
}

function selectionBlock(pid: string, focus?: Focus | null): string {
  if (!focus) return "<selection>Nothing selected.</selection>";
  const lines = [`Selected: ${focus.label}${focus.id ? ` [${focus.id}]` : ""}${focus.time != null ? ` at ${focus.time.toFixed(1)} s` : ""}.`];
  if ((focus.kind === "shot" || focus.kind === "moment") && focus.id) {
    const scene = latestScene(pid, focus.id);
    if (scene) lines.push(`Its blocking (v${scene.rev}):\n${describeForAgent(scene.data)}`);
  }
  if (focus.kind === "concept" && focus.id) {
    const c = conceptsDoc(pid)?.data.concepts.find((x) => x.id === focus.id);
    if (c) lines.push(`Story preview (not an instruction to approve): ${JSON.stringify(c.storyDraft ?? c.story ?? { hook: c.hook, structure: c.structure })}`);
  }
  return `<selection>\n${lines.join("\n")}\n</selection>`;
}

/* ---------------- turn ---------------- */

export type AgentTurn = { text: string; results: OpResult[]; navigate?: Stage; choices?: MessageContent["choices"]; quote?: QuoteView; cents: number; recorded?: boolean };

export async function runAgentTurn(pid: string, userText: string, ctx: { stage: Stage; focus?: Focus | null }): Promise<AgentTurn> {
  const p = getProject(pid)!;
  addMessage(pid, "user", { text: userText, stage: ctx.stage, focus: ctx.focus ?? undefined });

  // The sample never calls the model: it replays clearly labelled recorded replies.
  if (p.sample) return recordedTurn(pid, userText, ctx);

  const gate = spendGate(pid);
  if (!gate.ok) return reply(pid, ctx, { text: `${gate.reason} I can't answer live, but direct edits on the canvas still work.`, results: [], cents: 0 });

  const history = listMessages(pid, 20).slice(0, -1);
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of history) {
    if (m.role === "system") continue;
    const role = m.role === "user" ? "user" : "assistant";
    const text = m.content.text?.trim();
    if (!text) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === "string") last.content += `\n\n${text}`;
    else messages.push({ role, content: text });
  }
  while (messages.length && messages[0].role !== "user") messages.shift();
  const turnText = `<studio_state>\n${snapshot(pid, ctx.stage, ctx.focus)}\n</studio_state>\n${selectionBlock(pid, ctx.focus)}\n\n${userText}`;
  if (messages.length && messages[messages.length - 1].role === "user") messages[messages.length - 1] = { role: "user", content: `${messages[messages.length - 1].content as string}\n\n${turnText}` };
  else messages.push({ role: "user", content: turnText });

  const tools = toolDefs();
  const toolChars = JSON.stringify(tools).length;
  const results: OpResult[] = [];
  let navigate: Stage | undefined;
  let choices: MessageContent["choices"];
  let quote: QuoteView | undefined;
  let cents = 0;
  let finalText = "";
  const allowance = allowanceOf(pid);

  try {
    for (let step = 0; step < 8; step++) {
      const inputChars = SYSTEM.length + toolChars + JSON.stringify(messages).length;
      const res = await metered({ projectId: pid, purpose: "Astra conversation", authId: allowance?.id ?? null }, boundCents(inputChars, 0, 6000), () =>
        claudeClient().beta.messages.create({
          model: MODEL,
          max_tokens: 6000,
          betas: AGENT_BETAS,
          fallbacks: "default",
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          tools,
          output_config: { effort: "medium" },
          messages,
        } as Anthropic.Beta.MessageCreateParamsNonStreaming),
      );
      cents += res.cents;
      const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) finalText = text;
      if (res.stop_reason === "refusal") {
        finalText = "I can't help with that one. Tell me what you'd like the film to do instead.";
        break;
      }
      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !uses.length) break;

      messages.push({ role: "assistant", content: res.content });
      const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        let out: unknown;
        let isError = false;
        if (u.name === "get_shot") {
          const parsed = ReadShot.safeParse(u.input);
          out = parsed.success ? readShot(pid, parsed.data.shotId) : "Invalid input.";
        } else if (u.name === "get_concepts") {
          out = conceptsDoc(pid)?.data ?? "No directions yet.";
        } else if (u.name === "get_plan") {
          const plan = planDoc(pid);
          out = plan ? `${plan.data.title}\n${plan.data.treatment}\n${planText(plan.data)}\nEnd card: ${plan.data.endCard?.line ?? "none"}${plan.data.endCard?.detail ? ` / ${plan.data.endCard.detail}` : ""}` : "No plan yet.";
        } else if (u.name === "get_costs") {
          out = { currency: "USD", unit: "cents", recorded: spend(pid), approvals: authorizations(pid, true).map((a) => ({ label: a.label, ceilingCents: a.ceiling_cents, ...authUsage(a.id), remainingCents: authRemaining(a) })), note: "Studio records. Provider balance is not available here." };
        } else if (u.name === "offer_choices") {
          const parsed = OfferChoices.safeParse(u.input);
          if (parsed.success) {
            const recIdx = Math.max(0, parsed.data.choices.findIndex((c) => c.recommended));
            choices = parsed.data.choices.map((c, i) => ({ id: `ch${i}`, label: c.label, detail: c.detail, recommended: i === recIdx }));
            out = "The choices are shown to the person. End your turn with the question, in one short sentence.";
          } else {
            out = "Invalid choices.";
            isError = true;
          }
        } else {
          const r = await runOp(pid, u.name, u.input, "agent");
          results.push(r);
          if (r.navigate) navigate = r.navigate;
          if (r.quote) quote = r.quote;
          isError = !r.ok;
          out = { ok: r.ok, summary: r.summary, results: r.results, jobIds: r.jobIds, awaitingApproval: r.quote ? { label: r.quote.label, estimate: money(r.quote.cents), ceiling: money(r.quote.ceilingCents) } : undefined, data: r.data };
        }
        toolResults.push({ type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : JSON.stringify(out), is_error: isError || undefined });
      }
      messages.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    // Whatever was already said and done stays recorded, and so do the charges for it.
    if (err instanceof SpendBlocked) {
      return reply(pid, ctx, {
        text: results.length ? `${results.map((r) => r.summary).join(" ")} I stopped there: ${err.message}` : `I need a planning allowance to answer. ${err.code === "no-authorization" || err.code === "ceiling" ? "Set one in the panel; it covers my replies, drafts and storyboard frames." : err.message}`,
        results,
        navigate,
        choices,
        quote,
        cents,
      });
    }
    if (results.length || cents) return reply(pid, ctx, { text: `${results.map((r) => r.summary).join(" ")} Then the connection failed; try again for the rest.`.trim(), results, navigate, choices, quote, cents });
    throw err;
  }

  if (!finalText) finalText = results.length ? results.map((r) => r.summary).join(" ") : "Done.";
  return reply(pid, ctx, { text: finalText, results, navigate, choices, quote, cents });
}

function reply(pid: string, ctx: { stage: Stage }, t: AgentTurn): AgentTurn {
  const content: MessageContent & { quote?: QuoteView; cents?: number } = {
    text: t.text,
    choices: t.choices,
    results: t.results.flatMap((r) => [{ label: r.summary, ok: r.ok }]).slice(0, 6),
    stage: t.navigate ?? ctx.stage,
    quote: t.quote,
    cents: t.cents,
    recorded: t.recorded,
  };
  addMessage(pid, "agent", content);
  return t;
}

function readShot(pid: string, shotId: string): string {
  const shots = shotsDoc(pid)?.data.shots ?? [];
  const st = shotStates(pid, shots).find((s) => s.shot.id === shotId);
  if (!st) return "Unknown shot.";
  const ids = assetIdentities(pid);
  const name = (id: string | null) => ids.find((i) => i.asset.id === id)?.asset.name ?? "—";
  const sh = st.shot;
  return [
    `Shot [${sh.id}] ${String(shots.indexOf(sh) + 1).padStart(2, "0")} "${sh.title}" — ${sh.duration}s, ${sh.framing}, ${sh.move}, ${sh.lens}mm (rev ${sh.rev})`,
    `Summary: ${sh.summary ?? "—"}`,
    `Description: ${sh.description}`,
    `Action: ${sh.action}`,
    sh.direction ? `Direction for this shot: ${sh.direction}` : "",
    `Location: ${name(sh.locationId)} | Cast: ${sh.characterIds.map(name).join(", ") || "none"} | Props: ${sh.propIds.map(name).join(", ") || "none"} | Lines: ${sh.lineIds.join(", ") || "none"}`,
    `Storyboard: ${st.storyboardCurrent ? st.storyboard?.status : st.storyboard ? `outdated (${st.storyboardReasons.join(", ")})` : "missing"} | Takes: ${st.takes.length} (${st.takes.map((t) => `${t.status}${t.verdict !== "none" ? `/${t.verdict}` : ""}${t.current ? "" : "/outdated"}`).join(", ") || "none"})`,
    st.scene ? `Blocking (v${st.scene.rev}):\n${describeForAgent(st.scene.data)}` : "No blocking yet.",
  ]
    .filter(Boolean)
    .join("\n");
}
