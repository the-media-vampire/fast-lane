"use client";

import { Download, Image as ImageIcon, Map, Maximize2, Minimize2, Pause, Play, Repeat2, RotateCcw, Video, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatClock } from "@/lib/animatic";
import { storyboardCaptions } from "@/lib/storyboard";
import type { ShotView } from "@/lib/view-types";
import { useStudio } from "../studio/Studio";
import { remember } from "../studio/client";
import { Filmstrip } from "../studio/Filmstrip";
import { Empty, More } from "../studio/ui";
import { DirectStage, DIRECT_VIEWS, type DirectViewKind } from "../blocking/DirectStage";
import { AnimaticAudio } from "../blocking/AnimaticAudio";
import { useAnimatic } from "../blocking/useAnimatic";

const VIEW_LABELS = { storyboard: "Storyboard", camera: "Camera", overhead: "Overhead" };
const VIEW_ICONS = { storyboard: ImageIcon, camera: Video, overhead: Map };
const NO_SHOTS: ShotView[] = [];

/** Watch one shot or the entire animatic. Creative changes still go through Astra. */
export function DirectView() {
  const { view, shotId, selectShot, op, agentOpen, setAgentOpen } = useStudio();
  const shots = view.shots?.items ?? NO_SHOTS;
  const player = useAnimatic(shots, shotId, selectShot);
  const shot = shots.find((s) => s.id === player.active?.id) ?? shots[0];
  const [views, setViews] = useState<DirectViewKind[]>([...DIRECT_VIEWS]);
  const [muted, setMuted] = useState(false);
  const [audioError, setAudioError] = useState(false);
  const onAudioError = useCallback(() => { setAudioError(true); setMuted(true); }, []);
  const captions = useMemo(() => storyboardCaptions(shots, view.plan?.data ?? null), [shots, view.plan]);
  const hasAudio = !!(view.animatic?.music || view.animatic?.voice.length);

  useEffect(() => {
    const saved = remember("fl-direct-views")?.split(",");
    const valid = DIRECT_VIEWS.filter((v) => saved?.includes(v));
    if (valid.length) setViews(valid);
  }, []);

  // Warm the next local frame before the cut so image loading does not leave a blank view.
  useEffect(() => {
    const next = shots[shots.findIndex((s) => s.id === shot?.id) + 1];
    const media = next?.storyboard?.media ?? next?.capture?.media;
    if (media) { const image = new window.Image(); image.src = media.url; }
  }, [shots, shot?.id]);

  const toggleView = (key: DirectViewKind) => {
    setViews((current) => {
      if (current.length === 1 && current.includes(key)) return current;
      const next = DIRECT_VIEWS.filter((v) => v === key ? !current.includes(v) : current.includes(v));
      remember("fl-direct-views", next.join(","));
      return next;
    });
  };

  if (!shot) return <section className="fl-stage" aria-label="Direct"><div className="fl-eyebrow">Direct</div><Empty title="Nothing to direct yet.">Your shots will play here as an animatic.</Empty></section>;

  const elapsed = player.time - player.range.start;
  const duration = player.range.end - player.range.start;
  const versions = shot.blockingVersions;
  const plannedWords = captions.get(shot.id) ?? [];
  const activeVoice = new Set(view.animatic?.voice.filter((v) => player.time >= v.start && player.time < v.start + v.duration).map((v) => v.lineId));
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("button, input, a, textarea, select, [contenteditable]")) return;
    if (e.key === " ") { e.preventDefault(); player.toggle(); }
    else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      player.pause();
      const step = e.shiftKey ? 1 : 0.1;
      player.seek(e.key === "Home" ? player.range.start : e.key === "End" ? player.range.end : player.time + (e.key === "ArrowLeft" ? -step : step));
    }
  };

  return (
    <section className="fl-stage fl-direct" aria-label="Direct">
      <div className="fl-direct-toolbar">
        <h2 className="fl-h2">Animatic</h2>
        <div className="fl-direct-view-controls">
          <div className="fl-direct-view-toggle" role="group" aria-label="Visible views">
            {DIRECT_VIEWS.map((key) => {
              const Icon = VIEW_ICONS[key];
              const last = views.length === 1 && views.includes(key);
              return <button key={key} type="button" className="fl-pill" aria-pressed={views.includes(key)} aria-disabled={last} title={last ? "Keep at least one view visible" : `Show or hide ${VIEW_LABELS[key].toLowerCase()}`} onClick={() => toggleView(key)}><Icon size={13} aria-hidden />{VIEW_LABELS[key]}</button>;
            })}
          </div>
          <button type="button" className="fl-icon-btn" aria-label={agentOpen ? "Expand preview" : "Show Astra"} title={agentOpen ? "Expand preview" : "Show Astra"} onClick={() => setAgentOpen(!agentOpen)}>{agentOpen ? <Maximize2 size={15} /> : <Minimize2 size={15} />}</button>
        </div>
      </div>

      <div className="bl-stage" tabIndex={0} onKeyDown={onKeyDown} role="group" aria-label="Animatic player">
        <DirectStage shot={shot} time={player.localTime} views={views} aspect={view.project.aspect} />

        <div className="fl-direct-context">
          <div className="fl-direct-shotline"><strong>Shot {shot.number}</strong><span title={shot.summaryText}>{shot.summaryText}</span><span className="fl-muted">{shot.duration} s</span></div>
          <div className="fl-direct-words" aria-label="Words in this shot">
            {plannedWords.length ? plannedWords.map((line) => <span key={`${line.source}:${line.id}`} data-speaking={activeVoice.has(line.id) || undefined}><small>{line.kind === "vo" ? "VO" : line.kind === "dialogue" ? line.speaker ?? "Dialogue" : "On screen"}</small>{line.text}</span>) : <span className="fl-muted">{shot.movement}</span>}
          </div>
        </div>

        <div className="bl-playbar">
          <button type="button" className="bl-play" onClick={player.toggle} aria-label={player.playing ? "Pause animatic" : player.scope === "film" ? "Play whole film" : "Play this shot"} aria-pressed={player.playing}>{player.playing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}</button>
          <div className="fl-direct-scope" role="group" aria-label="Playback range">
            <button type="button" aria-pressed={player.scope === "film"} onClick={() => player.changeScope("film")}>Whole film</button>
            <button type="button" aria-pressed={player.scope === "shot"} onClick={() => player.changeScope("shot")}>This shot</button>
          </div>
          <div className="fl-direct-scrubber">
            <span className="bl-time">{formatClock(elapsed)}</span>
            <input className="bl-scrub" type="range" min={0} max={duration} step={0.01} value={elapsed} onChange={(e) => player.seek(player.range.start + Number(e.target.value))} aria-label={player.scope === "film" ? "Film playhead" : "Shot playhead"} aria-valuetext={`${formatClock(elapsed)} of ${formatClock(duration)} · Shot ${shot.number}`} style={{ ["--bl-progress" as string]: `${duration ? (elapsed / duration) * 100 : 0}%` }} />
            <span className="bl-time bl-time--total">{formatClock(duration, false)}</span>
          </div>
          <div className="fl-direct-transport-extras">
            <button type="button" className="fl-icon-btn" aria-label={player.scope === "film" ? "Restart film" : "Restart shot"} title="Back to start" onClick={() => player.seek(player.range.start)}><RotateCcw size={14} /></button>
            {player.scope === "shot" ? <button type="button" className="fl-icon-btn" aria-label="Loop this shot" aria-pressed={player.loop} title="Loop this shot" onClick={() => player.setLoop(!player.loop)}><Repeat2 size={16} /></button> : null}
            <button type="button" className="fl-icon-btn" disabled={!hasAudio} aria-label={!hasAudio ? "No audio yet" : muted ? "Unmute sound" : "Mute sound"} title={audioError ? "Sound could not play. Click to retry." : !hasAudio ? "No audio yet" : muted ? "Unmute sound" : "Mute sound"} onClick={() => { setMuted(!muted); setAudioError(false); }}>{muted || !hasAudio ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
          </div>
        </div>
        <Filmstrip activeId={shot.id} onSelect={(s) => player.select(s.id)} label="Animatic shots" mediaMode="storyboard" time={player.time} follow />
      </div>

      <AnimaticAudio sound={view.animatic} time={player.time} playing={player.playing} muted={muted} onError={onAudioError} />
      <More label="About this preview" className="fl-direct-more">
        <p className="fl-caption">Storyboard frames, blocking and available audio share one timeline. Generated footage receives the frame and written direction; the 3D motion is a preview.</p>
        {shot.scene ? <div className="fl-direct-versions" role="group" aria-label="Blocking versions">
          {versions.slice(0, 4).reverse().map((v) => <button key={v.rev} type="button" className="fl-pill" aria-pressed={v.rev === shot.scene?.rev} title={v.note ?? undefined} onClick={() => { if (v.rev !== shot.scene?.rev) { player.pause(); void op("restore_blocking", { shotId: shot.id, rev: v.rev }); } }}>v{v.rev}</button>)}
          <a className="fl-btn fl-btn--quiet fl-btn--sm" href={`/api/projects/${view.project.id}/shots/${shot.id}/blocking`}><Download size={12} aria-hidden /> Export blocking</a>
        </div> : null}
      </More>
    </section>
  );
}
