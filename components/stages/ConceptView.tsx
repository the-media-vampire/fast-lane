"use client";

import { ArrowRight, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDuration, useStudio } from "../studio/Studio";
import { Photo } from "../studio/ui";

/** Selecting a card previews its story. Only approval starts development. */
export function ConceptView() {
  const { view, op, go, ask, focus, setFocus } = useStudio();
  const [approving, setApproving] = useState(false);
  const c = view.concepts;
  const working = view.jobs.active.some((j) => j.kind === "think.concepts");
  const current = c?.items.find((k) => focus?.kind === "concept" && k.id === focus.id)
    ?? c?.items.find((k) => k.id === c.chosenId)
    ?? c?.items.find((k) => k.recommended)
    ?? c?.items[0];
  const selected = current?.id;
  const story = current?.storyDraft ?? current?.story;
  const chosen = !!current && c?.chosenId === current.id && !current.storyDraft;

  useEffect(() => {
    if (current && (focus?.kind !== "concept" || focus.id !== current.id)) setFocus({ kind: "concept", id: current.id, label: current.title });
  }, [current?.id, current?.title, focus?.kind, focus?.id, setFocus]);

  async function approve() {
    if (!current || !c || approving) return;
    setApproving(true);
    try {
      await op("choose_concept", { conceptId: current.id, conceptVersion: c.version });
    } finally {
      setApproving(false);
    }
  }

  if (!c) return (
    <section className="fl-stage fl-concepts" aria-label="Concept">
      <div className="fl-eyebrow">Concept</div>
      <h2 className="fl-h2">Three directions</h2>
      <div className="fl-grid-3">
        {[0, 1, 2].map((i) => (
          <article key={i} className="fl-choice" aria-hidden>
            <Photo media={null} aspect="16 / 9" alt="" working={working || !view.brief?.interpreted} label={i === 1 ? "Developing" : ""} />
          </article>
        ))}
      </div>
    </section>
  );

  return (
    <section className="fl-stage fl-concepts" aria-label="Concept">
      <div className="fl-stage-top">
        <div><div className="fl-eyebrow">Concept</div><h2 className="fl-h2">Three directions</h2></div>
        <span className="fl-caption">Choose one to explore</span>
      </div>
      <div className="fl-grid-3" role="radiogroup" aria-label="Directions">
        {c.items.map((k, index) => (
          <article key={k.id} className="fl-choice" data-selected={k.id === selected || undefined}>
            <button type="button" className="fl-choice-hit" role="radio" aria-checked={k.id === selected} aria-controls="fl-concept-preview" tabIndex={k.id === selected ? 0 : -1}
              onClick={() => setFocus({ kind: "concept", id: k.id, label: k.title })}
              onKeyDown={(e) => {
                const offset = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (!offset) return;
                e.preventDefault();
                const next = c.items[(index + offset + c.items.length) % c.items.length];
                setFocus({ kind: "concept", id: next.id, label: next.title });
                document.getElementById(`concept-${next.id}`)?.focus();
              }}
              id={`concept-${k.id}`} aria-label={`${k.title}${k.recommended ? ", recommended" : ""}`} />
            <Photo media={k.media} aspect="16 / 9" alt={k.title} working={k.imageStatus === "pending"} label={k.imageStatus === "none" ? "Story direction" : k.imageStatus === "failed" ? "Frame unavailable" : "Drawing"} showProvenance={false} />
            <div className="fl-choice-body">
              <div className="fl-choice-title"><h3 className="fl-h3">{k.title}</h3></div>
              <p>{k.pitchText}</p>
              <div className="fl-choice-state">
                {k.id === selected ? <Check size={12} aria-hidden /> : null}
                {c.chosenId === k.id ? "Current direction" : k.recommended ? "Recommended" : k.id === selected ? "Previewing" : k.tag}
              </div>
            </div>
          </article>
        ))}
      </div>

      {current ? (
        <section id="fl-concept-preview" className="fl-concept-preview" aria-labelledby="fl-story-title" aria-live="polite">
          <header className="fl-story-head">
            <div><div className="fl-eyebrow">The story</div><h3 id="fl-story-title">{current.title}</h3></div>
            <span className="fl-pill">{formatDuration(view.project.duration)}</span>
          </header>
          <p className="fl-story-pitch">{current.pitchText}</p>
          <h4 className="fl-story-label">How it unfolds</h4>
          {story?.length ? (
            <ol className="fl-story-beats" aria-label={`${current.title}: story beats`}>
              {story.map((beat, index) => (
                <li key={index} className="fl-story-beat">
                  <span className="fl-story-beat-title">{beat.title}</span>
                  <div>
                    <p className="fl-story-action">{beat.visual}</p>
                    {beat.lines.map((line, i) => (
                      <p className="fl-story-line" data-kind={line.kind} key={i}>
                        <span>{line.kind === "vo" ? "VO" : line.kind === "dialogue" ? line.speaker || "Dialogue" : "On screen"}</span>
                        <span>{line.text}</span>
                      </p>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="fl-story-action">{current.structure}</p>}
          <footer className="fl-story-footer">
            <span className="fl-caption">{current.storyDraft ? "Changes ready for your review" : chosen ? "Your current direction" : "Adjust any part with Astra"}</span>
            {chosen ? (
              <button type="button" className="fl-btn fl-btn--ghost" onClick={() => go("assets")}>View assets <ArrowRight size={14} aria-hidden /></button>
            ) : story?.length ? (
              <button type="button" className="fl-btn fl-btn--primary" disabled={approving || view.project.sample} onClick={() => void approve()}>
                {approving ? "Preparing assets…" : "Approve story & create assets"} <ArrowRight size={14} aria-hidden />
              </button>
            ) : (
              <button type="button" className="fl-btn fl-btn--ghost" disabled={view.project.sample} onClick={() => void ask("Expand this direction into a complete 4–6 beat story preview, including the actual spoken and on-screen words. Keep the existing idea.")}>Expand story with Astra <ArrowRight size={14} aria-hidden /></button>
            )}
          </footer>
        </section>
      ) : null}
    </section>
  );
}
