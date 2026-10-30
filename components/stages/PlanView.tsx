"use client";

import { Fragment } from "react";
import { shotFocus, useStudio, formatDuration } from "../studio/Studio";
import { clock } from "../studio/client";
import { EditableText, More, Spinner } from "../studio/ui";
import { VOICES } from "@/lib/voices";
import type { ShotView, Words } from "@/lib/view-types";
import { brevity } from "@/lib/plain";

/**
 * The plan as the actual sequence: one row per shot, the same numbers and timing as Shots,
 * Direct and Cut. Commercials read as a simplified AV plan; stories carry action and dialogue.
 */
export function PlanView() {
  const { view, op, shotId, selectShot, setFocus } = useStudio();
  const plan = view.plan;
  const p = view.project;
  const writing = view.jobs.active.some((j) => j.kind === "think.plan" || j.kind === "think.shots");
  const sample = p.sample;

  if (!plan) {
    return (
      <section className="fl-stage" aria-label="Plan">
        <div className="fl-eyebrow">{p.kind === "commercial" ? "AV plan" : "Scene script"}</div>
        <h2 className="fl-h2">The sequence</h2>
        <div className="fl-reading">{writing ? <Spinner label="Writing the plan" /> : <span className="fl-muted">The plan follows the direction you choose.</span>}</div>
      </section>
    );
  }

  const d = plan.data;
  const isAd = p.kind === "commercial";
  const shots = view.shots?.items ?? [];
  const normalizeCopy = (text: string) => text.trim().toLowerCase().replace(/[.!?]+$/, "");
  const endCopy = new Set([d.endCard?.line, d.endCard?.detail].filter((s): s is string => !!s).map(normalizeCopy));
  const words = (s: ShotView): Words[] => {
    // A line spanning several shots is spoken once, at its first anchor.
    const own = s.words.filter((w) => shots.find((x) => x.words.some((line) => line.id === w.id))?.id === s.id);
    const first = shots.find((x) => x.beatId === s.beatId) === s;
    const extra = first ? plan.unplaced.filter((w) => d.beats.find((b) => b.lines.some((l) => l.id === w.id))?.id === s.beatId) : [];
    return [...own, ...extra].filter((w) => w.kind !== "super" || !endCopy.has(normalizeCopy(w.text)));
  };
  const placeholders = [...new Set([...d.beats.flatMap((b) => b.lines.map((l) => l.text)), d.endCard?.line ?? "", d.endCard?.detail ?? ""].flatMap((t) => t.match(/\[[^\]]+\]/g) ?? []))];
  const select = (s: ShotView) => {
    selectShot(s.id);
    setFocus(shotFocus(s));
  };
  let lastScene = "";

  return (
    <section className="fl-stage fl-plan" aria-label="Plan">
      <div className="fl-stage-top">
        <div>
          <div className="fl-eyebrow">{isAd ? "AV plan" : "Scene script"}</div>
          <h2 className="fl-h2">{d.title}</h2>
        </div>
        <span className="fl-pill" aria-pressed>
          {shots.length ? `${shots.length} shots · ` : ""}
          {formatDuration(p.duration)}
          {writing ? " · revising" : ""}
        </span>
      </div>
      <p className="fl-lede">{plan.summaryText}</p>
      {placeholders.length ? <p className="fl-banner" data-tone="warn">Needs your words: {placeholders.join(", ")}.</p> : null}

      {shots.length ? (
        <div className="fl-rows" role="table" aria-label="Shot list">
          <div className="fl-rows-head" role="row">
            <span role="columnheader">Shot</span>
            <span role="columnheader">What happens</span>
            <span role="columnheader">Camera</span>
            <span role="columnheader">{isAd ? "Words and sound" : "Dialogue and sound"}</span>
          </div>
          {shots.map((s) => {
            const beat = d.beats.find((b) => b.id === s.beatId);
            const heading = !isAd && beat?.scene && beat.scene !== lastScene ? beat.scene : null;
            if (beat?.scene) lastScene = beat.scene;
            const firstOfBeat = shots.find((x) => x.beatId === s.beatId) === s;
            const w = words(s);
            return (
              <Fragment key={s.id}>
                {heading ? (
                  <div className="fl-rows-scene" role="row">
                    <span role="cell">{heading}</span>
                  </div>
                ) : null}
                <div className="fl-row" role="row" data-selected={s.id === shotId || undefined} onClick={() => select(s)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && select(s)} aria-label={`Shot ${s.number}`}>
                  <span className="fl-row-id" role="cell">
                    <strong>{s.number}</strong>
                    <span>
                      {clock(s.start)}–{clock(s.start + s.duration)}
                    </span>
                  </span>
                  <span className="fl-row-what" role="cell">
                    <EditableText value={s.summaryText} label={`what happens in shot ${s.number}`} disabled={sample} onSave={(summary) => void op("edit_shot", { shotId: s.id, summary })} />
                    {s.id === shotId ? (
                      <More label="Full description">
                        <dl className="fl-detail">
                          <dt>Picture</dt>
                          <dd>
                            <EditableText value={s.description} label="picture description" multiline disabled={sample} onSave={(description) => void op("edit_shot", { shotId: s.id, description })} />
                          </dd>
                          <dt>Action</dt>
                          <dd>
                            <EditableText value={s.action} label="action" multiline disabled={sample} onSave={(action) => void op("edit_shot", { shotId: s.id, action })} />
                          </dd>
                          {s.direction ? (
                            <>
                              <dt>Direction</dt>
                              <dd>{s.direction}</dd>
                            </>
                          ) : null}
                          <dt>Frame</dt>
                          <dd>
                            {s.framingText}, {s.lens} mm · {s.castNames.join(", ") || "no cast"}
                            {s.locationName ? ` · ${s.locationName}` : ""}
                          </dd>
                        </dl>
                      </More>
                    ) : null}
                  </span>
                  <span className="fl-row-camera" role="cell">
                    {s.movement}
                  </span>
                  <span className="fl-row-words" role="cell">
                    {w.map((l) => (
                      <span key={l.id} className="fl-word" data-kind={l.kind}>
                        <span className="fl-word-tag">{l.kind === "vo" ? "Voice" : l.kind === "super" ? "On screen" : l.speaker}</span>
                        <EditableText value={l.text} label={l.kind === "vo" ? "voiceover" : l.kind === "super" ? "on-screen words" : `${l.speaker}'s line`} disabled={sample} onSave={(text) => void op("edit_line", { lineId: l.id, text })} />
                      </span>
                    ))}
                    {firstOfBeat && beat?.sound ? (
                      <span className="fl-word-sound" title={beat.sound}>
                        {brevity(beat.sound, 9)}
                      </span>
                    ) : null}
                  </span>
                </div>
              </Fragment>
            );
          })}
          {d.endCard ? (
            <div className="fl-row fl-row--end" role="row">
              <span className="fl-row-id" role="cell">
                <strong>End</strong>
                <span>{clock(Math.max(0, p.duration - 3))}</span>
              </span>
              <span className="fl-row-what" role="cell">
                <EditableText value={d.endCard.line} label="end card line" disabled={sample} onSave={(line) => void op("edit_end_card", { line, detail: d.endCard?.detail })} />
              </span>
              <span className="fl-row-camera" role="cell">
                End card
              </span>
              <span className="fl-row-words" role="cell">
                {d.endCard.detail ? <EditableText value={d.endCard.detail} label="end card detail" disabled={sample} onSave={(detail) => void op("edit_end_card", { line: d.endCard!.line, detail })} /> : null}
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="fl-rows" role="table" aria-label="Draft beats">
          <p className="fl-caption fl-rows-note">{writing || view.pipeline.develop ? <Spinner label="Planning the shots" /> : "Shots are planned from these beats."}</p>
          {d.beats.map((b) => (
            <div key={b.id} className="fl-row" role="row">
              <span className="fl-row-id" role="cell">
                <span>
                  {clock(b.start)}–{clock(b.end)}
                </span>
              </span>
              <span className="fl-row-what" role="cell">
                {b.visual}
              </span>
              <span className="fl-row-camera" role="cell" />
              <span className="fl-row-words" role="cell">
                {b.lines.map((l) => (
                  <span key={l.id} className="fl-word" data-kind={l.kind}>
                    <span className="fl-word-tag">{l.kind === "vo" ? "Voice" : l.kind === "super" ? "On screen" : l.speaker}</span>
                    {l.text}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="fl-plan-meta">
        <label className="fl-field fl-field--inline">
          <span className="fl-label">Voice</span>
          <select className="fl-select" value={d.voice.voiceId ?? ""} disabled={sample} onChange={(e) => void op("set_voice", { voiceId: e.target.value })}>
            {!d.voice.voiceId ? <option value="">Chosen to fit</option> : null}
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <div className="fl-field fl-field--inline">
          <span className="fl-label">Music</span>
          <EditableText value={d.music.mood} label="music direction" disabled={sample} onSave={(mood) => void op("set_music", { mood })} />
        </div>
        {!d.endCard ? (
          <div className="fl-field fl-field--inline">
            <span className="fl-label">End card</span>
            <EditableText value="" placeholder="None" label="end card line" disabled={sample} onSave={(line) => void op("edit_end_card", { line })} />
          </div>
        ) : null}
        <More label="Treatment">
          <p className="fl-treatment">{d.treatment}</p>
        </More>
      </div>
    </section>
  );
}
