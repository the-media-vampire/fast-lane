"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, CircleAlert, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { useStudio } from "./Studio";
import { More, QuoteView, Spinner } from "./ui";
import type { MessageView, NextDecision, ProjectView } from "@/lib/view-types";
import type { Stage } from "@/lib/types";

/**
 * Astra, the one place for creative instructions. The panel leads with what is selected, the
 * one decision that matters now and the latest result; earlier conversation folds away.
 */

const SAMPLE_PROMPTS: Partial<Record<Stage, string[]>> = {
  brief: ["Why one character?"],
  concept: ["Why this direction?"],
  assets: ["Why these three?"],
  shots: ["Hold this moment longer.", "Push in more slowly. Keep her beside the window.", "Why no dialogue?"],
  direct: ["Push in more slowly. Keep her beside the window.", "Hold this moment longer.", "Keep the camera still."],
  cut: ["Hold this moment longer."],
};

function suggestions(view: ProjectView, stage: Stage, focusKind: string | undefined, focusId?: string): string[] {
  if (view.mode === "sample") return SAMPLE_PROMPTS[stage] ?? [];
  if (focusKind === "shot" || focusKind === "moment") {
    if (stage === "direct") return ["Push in more slowly", "Keep the camera still", "Move them closer to the window"];
    if (stage === "cut") return ["Hold this moment longer", "Retake this shot with a steadier camera"];
    return ["Hold this moment longer", "Add a close-up after this", "Use the approved character reference", "Remove this shot"];
  }
  if (focusKind === "asset") {
    const kind = view.assets.find((a) => a.id === focusId)?.kind;
    if (kind === "character") return ["Show another angle", "Try a different outfit", "Add a close portrait"];
    if (kind === "location") return ["Show another angle", "Change the lighting", "Show the full space"];
    return ["Show another angle", "Show a close-up", "Match the approved reference"];
  }
  if (focusKind === "concept") return ["Make the ending stronger", "Simplify the story", "Combine the first two"];
  if (stage === "shots") return ["Make the opening stronger", view.project.kind === "film" ? "Tighten the dialogue" : "Tighten the voiceover"];
  if (stage === "brief") return [view.project.duration === 120 ? "Make it 30 seconds" : "Make it two minutes", "Who is it for?"];
  return [];
}

const PLACEHOLDER: Record<string, string> = {
  shot: "What should change in this shot?",
  moment: "A note on this moment…",
  asset: "What should change here?",
  concept: "Ask about this direction…",
};

export function AgentPanel() {
  const { view, ask, thinking, stage, go, op, answer, focus, setFocus, agentOpen, setAgentOpen } = useStudio();
  const [draft, setDraft] = useState("");
  const [showEarlier, setShowEarlier] = useState(false);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  // Conversation from before this version of the studio stays under "Earlier conversation".
  const all = view.messages.filter((m) => m.text || m.choices?.length || m.quote);
  const archivedCount = all.filter((m) => m.archived).length;
  const messages = all.filter((m) => !m.archived);
  let lastReply = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role !== "user") {
    lastReply = i;
    break;
  }
  const lastUserIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
    return -1;
  })();
  const pendingUser = lastUserIdx > lastReply ? messages[lastUserIdx] : null;
  const latest = lastReply >= 0 ? messages[lastReply] : null;
  const latestUser = pendingUser ?? (latest ? [...messages.slice(0, lastReply)].reverse().find((m) => m.role === "user") ?? null : null);
  const cutoff = Math.min(...[lastReply, lastUserIdx].filter((i) => i >= 0), messages.length);
  const earlier = [...all.filter((m) => m.archived), ...messages.slice(0, latestUser ? messages.indexOf(latestUser) : cutoff)];
  void archivedCount;
  const chips = suggestions(view, stage, focus?.kind, focus?.id);
  const previewConcept = stage === "concept" && focus?.kind === "concept" ? view.concepts?.items.find((c) => c.id === focus.id) : null;
  const next = previewConcept && !["quote", "uncertain", "allowance", "working"].includes(view.next?.kind ?? "")
    ? previewConcept.id !== view.concepts?.chosenId || previewConcept.storyDraft
      ? { kind: "concept" as const, label: "Review this story", detail: "Approve below to create assets.", stage: "concept" as const }
      : null
    : view.next;

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [latest?.id]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || thinking) return;
    setDraft("");
    await ask(t);
  }

  async function choose(m: MessageView, label: string, id: string) {
    if (m.stage === "concept" && view.concepts?.items.some((c) => c.id === id)) {
      const concept = view.concepts.items.find((c) => c.id === id)!;
      setFocus({ kind: "concept", id, label: concept.title });
      go("concept");
      return;
    }
    if (m.questionId) {
      await op("update_brief", { answer: { questionId: m.questionId, answer: label } });
      return;
    }
    await send(label);
  }

  if (!agentOpen) {
    return (
      <aside className="fl-agent" data-collapsed aria-label="Astra (collapsed)">
        <button type="button" className="fl-agent-rail" onClick={() => setAgentOpen(true)} aria-label="Open Astra">
          <span className="fl-orb" data-thinking={thinking || undefined} aria-hidden />
          <PanelRightOpen size={15} aria-hidden />
          {view.next && ["quote", "approve-sequence", "question", "allowance", "attention", "final", "uncertain"].includes(view.next.kind) ? <span className="fl-rail-dot" aria-label="A decision is waiting" /> : null}
        </button>
      </aside>
    );
  }

  const openQuote = latest?.quote ? view.quotes.find((q) => q.id === latest.quote!.id) : null;

  return (
    <aside className="fl-agent" aria-label="Astra, your creative partner">
      <div className="fl-agent-head">
        <span className="fl-orb" data-thinking={thinking || undefined} aria-hidden />
        <span className="fl-agent-name">
          Astra{view.mode === "sample" ? <span className="fl-muted"> · recorded replies</span> : null}
        </span>
        <button type="button" className="fl-icon-btn" onClick={() => setAgentOpen(false)} aria-label="Collapse Astra">
          <PanelRightClose size={15} aria-hidden />
        </button>
      </div>

      <div className="fl-agent-scroll" ref={scroller}>
        {focus ? (
          <div className="fl-focus" aria-live="polite">
            <span className="fl-focus-label">Editing</span>
            <strong>{focus.label}</strong>
            <button type="button" className="fl-icon-btn fl-icon-btn--sm" onClick={() => setFocus(null)} aria-label="Clear selection">
              <X size={12} aria-hidden />
            </button>
          </div>
        ) : null}

        {next ? <Next next={next} busy={busy} setBusy={setBusy} /> : null}

        <section className="fl-latest" aria-label="Latest" aria-live="polite">
          {latestUser && latestUser.text.length > 180 && !pendingUser ? (
            <More label="Your last request"><p className="fl-latest-you">{latestUser.text}</p></More>
          ) : latestUser ? (
            <p className="fl-latest-you">
              <span>You</span> {latestUser.text}
            </p>
          ) : null}
          {thinking ? (
            <p className="fl-typing" aria-label="Astra is thinking">
              <span />
              <span />
              <span />
            </p>
          ) : latest && !pendingUser ? (
            <Message m={latest} last onChoose={choose} />
          ) : !latest ? (
            <p className="fl-muted fl-latest-empty">{view.mode === "sample" ? "Try a suggestion below. Replies here are recorded, not live." : "Select anything, then tell me what to change."}</p>
          ) : null}
          {openQuote && !thinking && view.next?.quoteId !== openQuote.id ? (
            <QuoteView
              q={openQuote}
              compact
              busy={busy}
              onDecline={async () => {
                setBusy(true);
                await answer(openQuote, "decline");
                setBusy(false);
              }}
              onApprove={async () => {
                setBusy(true);
                await answer(openQuote, "approve");
                setBusy(false);
              }}
            />
          ) : null}
        </section>

        {earlier.length ? (
          <section className="fl-earlier">
            <button type="button" className="fl-more-btn" aria-expanded={showEarlier} onClick={() => setShowEarlier((s) => !s)}>
              Earlier conversation ({earlier.length}) <ChevronDown size={12} aria-hidden />
            </button>
            {showEarlier ? (
              <div className="fl-msgs">
                {earlier.map((m) => (
                  <Message key={m.id} m={m} />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      {chips.length ? (
        <div className="fl-chips" role="group" aria-label="Suggestions">
          {chips.map((c) => (
            <button key={c} type="button" className="fl-chip" onClick={() => void send(c)} disabled={thinking}>
              {c}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className="fl-agent-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <label className="fl-sr" htmlFor="fl-agent-text">
          Tell Astra what to change
        </label>
        <textarea
          id="fl-agent-text"
          rows={2}
          value={draft}
          placeholder={focus ? (PLACEHOLDER[focus.kind] ?? "What should change?") : "Tell Astra what to change…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <button type="submit" className="fl-icon-btn fl-send" aria-label="Send" disabled={!draft.trim() || thinking}>
          <ArrowUpRight size={16} aria-hidden />
        </button>
      </form>
    </aside>
  );
}

function Message({ m, last, onChoose }: { m: MessageView; last?: boolean; onChoose?: (m: MessageView, label: string, id: string) => void }) {
  const { thinking } = useStudio();
  return (
    <div className="fl-msg" data-role={m.role}>
      {m.focus && m.role === "user" ? <span className="fl-msg-focus">{m.focus.label}</span> : null}
      {m.text ? <p>{m.text}</p> : null}
      {m.recorded ? <span className="fl-badge" data-tone="sample">Recorded reply</span> : null}
      {m.results?.length && m.role !== "user" && last ? (
        <ul className="fl-msg-results">
          {m.results.slice(0, 3).map((r, i) => (
            <li key={i} data-ok={r.ok || undefined}>
              {r.ok ? <Check size={12} aria-hidden /> : <CircleAlert size={12} aria-hidden />}
              <span>{r.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {m.choices?.length && last && onChoose ? (
        <div className="fl-choices" role="group" aria-label="Choices">
          {m.choices.map((c) => (
            <button key={c.id} type="button" className="fl-choice-pill" data-recommended={c.recommended || undefined} onClick={() => onChoose(m, c.label, c.id)} disabled={thinking}>
              <span>{c.label}</span>
              {c.recommended ? <small>Recommended</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The one decision that matters now. */
function Next({ next, busy, setBusy }: { next: NextDecision; busy: boolean; setBusy: (b: boolean) => void }) {
  const { view, op, go, stage, answer } = useStudio();
  const quote = next.quoteId ? view.quotes.find((q) => q.id === next.quoteId) : null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const tone = ["working", "producing", "done", "off"].includes(next.kind) ? "quiet" : "decision";
  return (
    <section className="fl-next" data-tone={tone} aria-label="Next decision">
      <span className="fl-next-label">{tone === "quiet" ? "Now" : "Next decision"}</span>
      {quote ? (
        <QuoteView q={quote} busy={busy} onDecline={() => run(() => answer(quote, "decline"))} onApprove={() => run(() => answer(quote, "approve"))} />
      ) : (
        <>
          <p className="fl-next-title">
            {["working", "producing"].includes(next.kind) ? <Spinner /> : null} {next.label}
          </p>
          {next.detail ? <p className="fl-next-detail">{next.detail}</p> : null}
          {next.choices?.length ? (
            <div className="fl-choices">
              {next.choices.map((c) => (
                <button key={c.id} type="button" className="fl-choice-pill" data-recommended={c.recommended || undefined} disabled={busy} onClick={() => run(() => op("update_brief", { answer: { questionId: next.questionId, answer: c.label } }))}>
                  <span>{c.label}</span>
                  {c.recommended ? <small>Recommended</small> : null}
                </button>
              ))}
            </div>
          ) : null}
          {next.kind === "allowance" ? <AllowancePicker /> : null}
          {next.op ? (
            <button type="button" className="fl-btn fl-btn--primary fl-btn--sm" disabled={busy} onClick={() => run(() => op(next.op!, next.input ?? {}))}>
              {next.kind === "generate" ? "See the estimate" : next.label}
            </button>
          ) : next.stage && next.stage !== stage ? (
            <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" onClick={() => go(next.stage!)}>
              Open {next.stage === "cut" ? "the cut" : next.stage}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function AllowancePicker() {
  const { op } = useStudio();
  const [custom, setCustom] = useState("");
  return (
    <div className="fl-allowance">
      {[2, 5].map((d) => (
        <button key={d} type="button" className="fl-pill" onClick={() => void op("set_allowance", { dollars: d })}>
          Allow ${d}
        </button>
      ))}
      <input className="fl-input fl-input--tiny" inputMode="decimal" placeholder="$" aria-label="Other allowance in dollars" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ""))} />
      <button type="button" className="fl-pill" disabled={!(Number(custom) > 0)} onClick={() => void op("set_allowance", { dollars: Number(custom) })}>
        Set
      </button>
    </div>
  );
}
