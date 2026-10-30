"use client";

import { Check, Columns2 } from "lucide-react";
import { useState } from "react";
import { formatDuration, shotFocus, useStudio } from "../studio/Studio";
import { Badge, EditableText, Modal, Photo, Spinner } from "../studio/ui";
import type { FrameVersion, ShotView } from "@/lib/view-types";
import { storyboardCaptions, type StoryboardCaption } from "@/lib/storyboard";

/** The storyboard: every card readable on its own. Selecting one points Astra at it. */
export function ShotsView() {
  const { view, shotId, selectShot, setFocus } = useStudio();
  const shots = view.shots?.items ?? [];
  const planning = view.jobs.active.some((j) => !j.hold && (j.kind === "think.plan" || j.kind === "think.shots"));
  const aspect = view.project.aspect === "16:9" ? "16 / 9" : "9 / 16";
  const total = shots.reduce((a, s) => a + s.duration, 0);
  const [compare, setCompare] = useState<ShotView | null>(null);
  const captions = storyboardCaptions(shots, view.plan?.data ?? null);
  const select = (s: ShotView) => {
    selectShot(s.id);
    setFocus(shotFocus(s));
  };

  if (!shots.length) {
    return (
      <section className="fl-stage" aria-label="Shots">
        <div className="fl-eyebrow">Shots</div>
        <h2 className="fl-h2">Storyboard</h2>
        <div className="fl-shots" data-aspect={view.project.aspect}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} aria-hidden>
              <Photo media={null} aspect={aspect} alt="" working={planning} label={i === 1 ? "Planning shots" : ""} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="fl-stage" aria-label="Shots">
      <div className="fl-stage-top">
        <div>
          <div className="fl-eyebrow">Shots</div>
          <h2 className="fl-h2">Storyboard</h2>
        </div>
        <span className="fl-pill" aria-pressed>
          {shots.length} shots · {formatDuration(total)}
        </span>
      </div>
      <Checkpoint />
      <div className="fl-shots" data-aspect={view.project.aspect} role="list">
        {shots.map((s) => (
          <ShotCard
            key={s.id}
            s={s}
            aspect={aspect}
            captions={captions.get(s.id) ?? []}
            active={s.id === shotId}
            onSelect={() => select(s)}
            onShowStart={(id) => {
              const first = shots.find((shot) => shot.id === id);
              if (first) select(first);
              document.getElementById(`storyboard-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }}
            onCompare={() => setCompare(s)}
          />
        ))}
      </div>
      {compare ? <Compare s={shots.find((x) => x.id === compare.id) ?? compare} onClose={() => setCompare(null)} /> : null}
    </section>
  );
}

function ShotCard({ s, aspect, captions, active, onSelect, onCompare, onShowStart }: { s: ShotView; aspect: string; captions: StoryboardCaption[]; active: boolean; onSelect: () => void; onCompare: () => void; onShowStart: (id: string) => void }) {
  const { view, op } = useStudio();
  const media = s.storyboard?.media ?? s.capture?.media ?? null;
  const outdated = s.storyboard && !s.storyboard.current;
  const drift = s.storyboards.find((f) => f.current)?.drift;
  const versions = s.storyboards.filter((f) => f.status === "ready" && f.media).length;
  return (
    <article role="listitem" id={`storyboard-${s.id}`} className="fl-shot" data-active={active || undefined} aria-label={`Shot ${s.number}`}>
      <button type="button" className="fl-shot-hit" onClick={onSelect} aria-pressed={active} aria-label={`Shot ${s.number}: ${s.summaryText}, ${s.duration} seconds`}>
        <Photo media={media} aspect={aspect} alt={`Shot ${s.number} storyboard`} working={s.generating && !media} label="Drawing" showProvenance={!s.storyboard?.media} />
        <span className="fl-shot-flags">
          {s.generating ? <Spinner /> : null}
          {outdated ? <Badge tone="warn">Outdated</Badge> : s.approval === "changed" ? <Badge tone="warn">Changed</Badge> : null}
          {drift && drift.drift === "drifted" ? <Badge tone="bad">Check likeness</Badge> : null}
          {s.pick?.kind === "take" ? <Badge tone="live">Footage</Badge> : null}
          {s.attention ? <Badge tone="bad">Needs you</Badge> : null}
        </span>
      </button>
      <div className="fl-shot-meta">
        <strong>{s.number}</strong>
        <span>{s.duration} s</span>
        {active && versions > 1 ? (
          <button type="button" className="fl-link-btn" onClick={onCompare}>
            <Columns2 size={12} aria-hidden /> Compare versions
          </button>
        ) : null}
      </div>
      <div className="fl-shot-action" onFocusCapture={onSelect}>
        <EditableText className="fl-shot-what" value={s.summaryText} label={`what happens in shot ${s.number}`} disabled={view.project.sample} onSave={async (summary) => { await op("edit_shot", { shotId: s.id, summary }); }} />
      </div>
      <p className="fl-shot-move">{s.movement}</p>
      {captions.length ? (
        <div className="fl-shot-copy" aria-label={`Words for shot ${s.number}`}>
          {captions.map((line) => {
            const label = line.source === "end-title" ? "End card" : line.source === "end-detail" ? "End card detail" : line.kind === "vo" ? "VO" : line.kind === "dialogue" ? `Dialogue${line.speaker ? ` · ${line.speaker}` : ""}` : "On screen";
            if (line.continues) return (
              <button key={`${line.source}:${line.id}`} type="button" className="fl-shot-continues" title={line.text} aria-label={`${label} continues from shot ${line.firstShotNumber}. Show the words.`} onClick={() => onShowStart(line.firstShotId)}>
                {label} continues
              </button>
            );
            return (
              <div key={`${line.source}:${line.id}`} className="fl-shot-line" data-kind={line.kind} onFocusCapture={onSelect}>
                {line.source !== "end-detail" ? <span className="fl-shot-copy-label">{label}</span> : null}
                <EditableText value={line.text} label={`${line.kind === "vo" ? "voiceover" : label.toLowerCase()} in shot ${s.number}`} multiline disabled={view.project.sample} onSave={async (text) => {
                  if (line.source === "line") await op("edit_line", { lineId: line.id, text });
                  else {
                    const end = view.plan?.data.endCard;
                    if (end) await op("edit_end_card", { line: line.source === "end-title" ? text : end.line, detail: line.source === "end-detail" ? text : end.detail });
                  }
                }} />
              </div>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}

/** Creative approval of the sequence, separate from any spending. */
function Checkpoint() {
  const { view, op } = useStudio();
  const seq = view.sequence;
  if (!seq) return null;
  const shots = view.shots?.items ?? [];
  const changed = shots.filter((s) => seq.changed.includes(s.id)).map((s) => s.number);
  if (seq.allApproved) {
    return (
      <div className="fl-checkpoint" data-tone="ok">
        <Check size={15} aria-hidden />
        <span>
          Approved for production{seq.reviewer ? ` by ${seq.reviewer}` : ""}
          <span className="fl-muted"> · {new Date(seq.approvedAt!).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
        </span>
      </div>
    );
  }
  if (seq.blockers.length) {
    const outdated = shots.filter((s) => !s.storyboard || !s.storyboard.current).length;
    return (
      <div className="fl-checkpoint">
        <span>Not ready to approve: {seq.blockers.join(", ")}.</span>
        {outdated && !view.project.sample && !view.jobs.active.some((j) => j.kind === "image.storyboard") ? (
          <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" onClick={() => void op("render_storyboards", {})}>
            Redraw {outdated}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="fl-checkpoint" data-tone="decision">
      <span>
        {seq.approvedAt ? `Shot${changed.length === 1 ? "" : "s"} ${changed.join(", ")} changed since approval.` : "Storyboard and blocking ready for review."}
        {seq.reviewer ? <span className="fl-muted"> Reviewer: {seq.reviewer}</span> : null}
      </span>
      <button type="button" className="fl-btn fl-btn--primary fl-btn--sm" onClick={() => void op("approve_sequence", {})}>
        Approve sequence for production
      </button>
    </div>
  );
}

/** Before and after: every earlier frame is kept. */
function Compare({ s, onClose }: { s: ShotView; onClose: () => void }) {
  const { view } = useStudio();
  const frames = s.storyboards.filter((f) => f.status === "ready" && f.media);
  const [beforeId, setBeforeId] = useState<string>(frames[1]?.id ?? frames[0]?.id);
  const after = frames[0];
  const before = frames.find((f) => f.id === beforeId) ?? frames[1];
  const aspect = view.project.aspect === "16:9" ? "16 / 9" : "9 / 16";
  const label = (f: FrameVersion) => `Version ${frames.length - frames.indexOf(f)}`;
  return (
    <Modal title={`Shot ${s.number}: before and after`} onClose={onClose} wide>
      <div className="fl-compare" data-aspect={view.project.aspect}>
        {[before, after].map((f, i) =>
          f ? (
            <figure key={f.id}>
              <Photo media={f.media} aspect={aspect} alt={label(f)} />
              <figcaption>
                <strong>{i === 0 ? "Before" : "After"}</strong> · {label(f)}
                {f.note ? <span className="fl-muted"> · “{f.note}”</span> : null}
                {f.drift ? <span className={f.drift.drift === "drifted" ? "fl-bad" : "fl-muted"}> · {f.drift.check}</span> : null}
              </figcaption>
            </figure>
          ) : null,
        )}
      </div>
      {frames.length > 2 ? (
        <div className="fl-versions" role="group" aria-label="Compare with">
          {frames.slice(1).map((f) => (
            <button key={f.id} type="button" className="fl-thumb" aria-pressed={f.id === beforeId} onClick={() => setBeforeId(f.id)} title={label(f)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.media!.preview} alt={label(f)} />
            </button>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}
