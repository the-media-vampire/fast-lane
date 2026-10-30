"use client";

import { Check, Download, Film, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../studio/Studio";
import { clock, pad } from "../studio/client";
import { Filmstrip } from "../studio/Filmstrip";
import { Badge, More, Spinner } from "../studio/ui";
import type { CutView as Cut, ShotView } from "@/lib/view-types";

/**
 * The cut: play it, compare versions, review each shot's footage. Notes go to Astra with the
 * shot and the playhead time already attached.
 */
export function CutView() {
  const { view, shotId, selectShot, setFocus } = useStudio();
  const cuts = view.cuts;
  const ready = cuts.filter((c) => c.status === "ready");
  const [cutId, setCutId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const cut = cuts.find((c) => c.id === cutId) ?? ready[0] ?? null;
  const pendingCut = cuts.find((c) => c.status === "pending");
  const [time, setTime] = useState(0);
  const video = useRef<HTMLVideoElement | null>(null);
  const shots = view.shots?.items ?? [];

  const atShot = useMemo(() => {
    if (!cut) return null;
    const slot = [...cut.manifest.shots].reverse().find((s) => s.start <= time + 0.01);
    return slot?.shotId ?? null;
  }, [cut, time]);
  const current = shots.find((s) => s.id === (atShot ?? shotId)) ?? null;

  // The selection is the moment under the playhead: Astra receives shot and time with a note.
  useEffect(() => {
    if (!current) return;
    setFocus({ kind: "moment", id: current.id, label: `Shot ${current.number} at ${clock(time, true)}`, time, cutId: cut?.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, Math.round(time * 2), cut?.id]);

  useEffect(() => {
    if (atShot && atShot !== shotId) selectShot(atShot);
  }, [atShot, shotId, selectShot]);

  const seekToShot = (s: ShotView) => {
    selectShot(s.id);
    const slot = cut?.manifest.shots.find((x) => x.shotId === s.id);
    if (slot && video.current) {
      video.current.currentTime = slot.start + 0.05;
      setTime(slot.start + 0.05);
    }
  };

  return (
    <section className="fl-stage fl-cut" aria-label="Cut">
      <div className="fl-stage-top">
        <div>
          <div className="fl-eyebrow">Cut</div>
          <h2 className="fl-h2">{view.project.title === "Untitled" ? "Your film" : view.project.title}</h2>
        </div>
        {cut ? <span className="fl-pill" aria-pressed>Version {pad(cut.version)}</span> : pendingCut ? <Spinner label="Assembling" /> : null}
      </div>

      <StateBar cut={cut} pending={!!pendingCut} />
      {cut?.review?.creativeNotes?.length ? (
        <div className="fl-cut-notes" aria-label="Creative review notes">
          <More label={`${cut.review.creativeNotes.length} creative notes before approval`}>
            <ul>{cut.review.creativeNotes.map((note) => <li key={note}>{note}</li>)}</ul>
          </More>
        </div>
      ) : null}

      {cut?.media ? (
        <div className="fl-cut-stage" data-compare={compareId ? "" : undefined}>
          <figure className="fl-player" data-aspect={view.project.aspect}>
            <video
              ref={video}
              key={cut.id}
              src={cut.media.url}
              poster={`${cut.media.url}?v=preview`}
              controls
              playsInline
              preload="metadata"
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onSeeked={(e) => setTime(e.currentTarget.currentTime)}
              aria-label={`Version ${pad(cut.version)}`}
            />
            <figcaption>
              <span>Version {pad(cut.version)}</span>
              <CutKind c={cut} />
            </figcaption>
          </figure>
          {compareId ? <Compare cut={cuts.find((c) => c.id === compareId)!} onClose={() => setCompareId(null)} /> : null}
        </div>
      ) : null}

      <Filmstrip activeId={current?.id ?? null} onSelect={seekToShot} label="Shots in the cut" />

      <div className="fl-cut-grid">
        <Takes shot={current} />
        <Versions cuts={cuts} current={cut} onPlay={setCutId} compareId={compareId} onCompare={setCompareId} />
      </div>

      {cut?.review ? (
        <More label="Delivery checks">
          <ul className="fl-checks">
            {cut.review.checks.map((c) => (
              <li key={c.label} data-ok={c.ok || undefined}>
                {c.ok ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
                <span>{c.label}</span>
                <span className="fl-muted">{c.detail}</span>
              </li>
            ))}
          </ul>
          <p className="fl-caption">
            MP4 · {cut.manifest.width}×{cut.manifest.height} · {cut.manifest.duration} s · −14 LUFS. {cut.footageShots ? `Generated footage is ${view.provider.videoResolution}, scaled into this frame.` : "Storyboard frames are held as stills."}
          </p>
        </More>
      ) : null}
    </section>
  );
}

function CutKind({ c }: { c: Cut }) {
  if (c.acceptance === "final") return <Badge tone="ok">Final cut</Badge>;
  if (c.kind === "animatic") return <Badge tone="warn">Storyboard animatic{c.acceptance === "animatic" ? " · approved" : ""}</Badge>;
  if (c.kind === "partial") return <Badge tone="warn">{c.footageShots} of {c.totalShots} shots are footage</Badge>;
  return <Badge tone="live">Footage · for review</Badge>;
}

/** Which of the four states the film is in, and the one action that moves it on. */
function StateBar({ cut, pending }: { cut: Cut | null; pending: boolean }) {
  const { view, op, go } = useStudio();
  const prod = view.production;
  const live = view.mode === "live";
  const canGenerate = !!view.estimate?.shots.length;
  const name = (c: Cut) => `${view.project.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${pad(c.version)}${c.acceptance === "final" ? "" : c.kind === "footage" ? "-review" : "-preview"}-${view.project.aspect === "16:9" ? "16x9" : "9x16"}.mp4`;
  const exportLink = cut?.media ? (
    <a className="fl-btn fl-btn--ghost fl-btn--sm" href={`${cut.media.url}?download=${encodeURIComponent(name(cut))}`} download={name(cut)}>
      <Download size={12} aria-hidden /> {cut.acceptance === "final" ? "Export MP4" : "Export preview"}
    </a>
  ) : null;
  const generate = canGenerate ? (
    <button type="button" className="fl-btn fl-btn--primary fl-btn--sm" disabled={!live || !view.sequence?.allApproved} title={!live ? (view.modeReason ?? "Spending is off") : !view.sequence?.allApproved ? "Approve the sequence on the Shots screen first" : undefined} onClick={() => void op("start_production", {})}>
      Generate footage
    </button>
  ) : null;

  if (prod.state === "running") {
    return (
      <div className="fl-state" data-state="generating">
        <Spinner />
        <div>
          <strong>Generating footage</strong>
          <span className="fl-muted">
            {prod.footage} of {prod.total} shots · keeps going if you close the studio
          </span>
        </div>
      </div>
    );
  }
  if (!cut) {
    return (
      <div className="fl-state" data-state="empty">
        <Film size={16} aria-hidden />
        <div>
          <strong>{pending ? "Assembling the first version" : "Nothing assembled yet"}</strong>
          <span className="fl-muted">{pending ? "" : "A storyboard animatic is free."}</span>
        </div>
        <div className="fl-state-actions">
          <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" disabled={pending || !(view.shots?.items.length ?? 0)} onClick={() => void op("assemble_cut", { note: "Storyboard animatic" })}>
            Assemble animatic
          </button>
          {generate}
        </div>
      </div>
    );
  }
  if (cut.acceptance === "final") {
    return (
      <div className="fl-state" data-state="final">
        <Check size={16} aria-hidden />
        <div>
          <strong>Approved final cut</strong>
          <span className="fl-muted">
            Version {pad(cut.version)}
            {cut.acceptedBy ? ` · ${cut.acceptedBy}` : ""}
          </span>
        </div>
        <div className="fl-state-actions">{exportLink}</div>
      </div>
    );
  }
  if (cut.kind === "footage") {
    return (
      <div className="fl-state" data-state="review">
        <Film size={16} aria-hidden />
        <div>
          <strong>{cut.finalReady.ok ? "Ready for your review" : "Needs attention"}</strong>
          <span className="fl-muted">{cut.finalReady.ok ? cut.finalReady.manualShots ? `${cut.finalReady.manualShots} shots manually chosen · delivery checks pass.` : "Delivery checks pass. Review the picture and sound." : cut.finalReady.reasons.join("; ")}</span>
        </div>
        <div className="fl-state-actions">
          {exportLink}
          {cut.finalReady.reasons.some((r) => r.includes(" in Assets")) ? <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" onClick={() => go("assets")}>Review assets</button> : null}
          {cut.finalReady.reasons.some((r) => r.includes("assemble a new version")) ? <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" disabled={pending} onClick={() => void op("assemble_cut", { note: "Updated edit" })}>Update cut · free</button> : null}
          {generate}
          <button type="button" className="fl-btn fl-btn--primary fl-btn--sm" disabled={!cut.finalReady.ok} onClick={() => void op("accept_final", { cutId: cut.id })}>
            Accept as final
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="fl-state" data-state="animatic">
      <Film size={16} aria-hidden />
      <div>
        <strong>{cut.kind === "animatic" ? "Storyboard animatic" : `Partly filmed · ${cut.footageShots} of ${cut.totalShots} shots`}</strong>
        <span className="fl-muted">{prod.state === "attention" ? "Some shots need your call; their stand-ins are marked." : cut.kind === "animatic" ? "Real sound over storyboard frames. Not final footage." : "Stand-in frames hold the other slots."}</span>
      </div>
      <div className="fl-state-actions">
        {exportLink}
        {cut.kind === "animatic" && cut.acceptance !== "animatic" ? (
          <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" onClick={() => void op("approve_animatic", { cutId: cut.id })}>
            Approve animatic
          </button>
        ) : null}
        {generate}
      </div>
    </div>
  );
}

function Takes({ shot }: { shot: ShotView | null }) {
  const { op } = useStudio();
  if (!shot) {
    return (
      <div className="fl-panel">
        <h3 className="fl-panel-title">Takes</h3>
        <p className="fl-muted fl-small">Pick a shot in the strip to see its takes.</p>
      </div>
    );
  }
  const takes = shot.takes.filter((t) => t.status !== "failed" || t.current).slice(0, 4);
  return (
    <div className="fl-panel">
      <h3 className="fl-panel-title">
        Shot {shot.number} · Takes
      </h3>
      {takes.length ? (
        <div className="fl-takes">
          {takes.map((t) => (
            <div key={t.id} className="fl-take" data-verdict={t.verdict} data-current={t.current || undefined}>
              {t.media ? <video src={t.media.url} poster={t.poster ?? undefined} controls muted playsInline preload="none" aria-label={`Take ${t.attempt}`} /> : <div className="fl-take-empty">{t.status === "pending" ? <Spinner label="Generating" /> : <span className="fl-muted">{t.error ?? "Failed"}</span>}</div>}
              <div className="fl-take-meta">
                <span>
                  {t.source === "upload" ? "Your clip" : `Take ${t.attempt}`}
                  {!t.current ? " · outdated" : ""}
                </span>
                {t.verdict === "accepted" ? <Badge tone="ok">{t.review?.usable ? "Chosen" : "Manually chosen"}</Badge> : t.review ? <Badge tone={t.review.usable ? "ok" : "bad"}>{t.review.usable ? "Passed review" : "Flagged"}</Badge> : t.status === "ready" ? <Badge tone="warn">Needs review</Badge> : null}
              </div>
              {t.review?.summary ? <More label="Review details"><p className="fl-muted fl-small">{t.review.summary}</p></More> : null}
              {t.status === "ready" ? (
                <div className="fl-row-actions">
                  <button type="button" className="fl-btn fl-btn--sm fl-btn--ghost" aria-pressed={t.verdict === "accepted"} onClick={() => void op("accept_take", { takeId: t.id })}>
                    {t.verdict === "accepted" ? "Chosen" : t.review?.usable ? "Use this take" : "Use after my review"}
                  </button>
                  <button type="button" className="fl-btn fl-btn--sm fl-btn--quiet" aria-pressed={t.verdict === "rejected"} onClick={() => void op("reject_take", { takeId: t.id })}>
                    Set aside
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="fl-muted fl-small">No footage yet. This slot plays the storyboard frame.</p>
      )}
    </div>
  );
}

function Versions({ cuts, current, onPlay, compareId, onCompare }: { cuts: Cut[]; current: Cut | null; onPlay: (id: string) => void; compareId: string | null; onCompare: (id: string | null) => void }) {
  return (
    <div className="fl-panel">
      <h3 className="fl-panel-title">Versions</h3>
      {cuts.length ? (
        <ul className="fl-versions-list">
          {cuts.map((c) => (
            <li key={c.id} data-current={c.id === current?.id || undefined}>
              <button type="button" className="fl-link" onClick={() => onPlay(c.id)} disabled={c.status !== "ready"}>
                Version {pad(c.version)}
              </button>
              <span className="fl-muted fl-small">
                {c.status === "pending" ? "assembling" : c.status === "failed" ? "failed" : c.acceptance === "final" ? "final cut" : c.kind === "animatic" ? `animatic${c.acceptance === "animatic" ? " · approved" : ""}` : `${c.footageShots}/${c.totalShots} footage`}
              </span>
              {c.status === "ready" && c.id !== current?.id ? (
                <button type="button" className="fl-btn fl-btn--sm fl-btn--quiet" aria-pressed={compareId === c.id} onClick={() => onCompare(compareId === c.id ? null : c.id)}>
                  Compare
                </button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="fl-muted fl-small">No versions yet.</p>
      )}
    </div>
  );
}

function Compare({ cut, onClose }: { cut: Cut; onClose: () => void }) {
  const { view } = useStudio();
  if (!cut?.media) return null;
  return (
    <figure className="fl-player fl-player--compare" data-aspect={view.project.aspect}>
      <video src={cut.media.url} poster={`${cut.media.url}?v=preview`} controls playsInline preload="metadata" aria-label={`Version ${pad(cut.version)} for comparison`} />
      <figcaption>
        <span>Version {pad(cut.version)}</span>
        <CutKind c={cut} />
        <button type="button" className="fl-btn fl-btn--sm fl-btn--quiet" onClick={onClose}>
          Close
        </button>
      </figcaption>
    </figure>
  );
}
