"use client";

import { useEffect, useRef } from "react";
import type { AnimaticSound } from "@/lib/view-types";

/** All tracks follow the visual playhead, including seeks, shot boundaries and loops. */
export function AnimaticAudio({ sound, time, playing, muted, onError }: { sound?: AnimaticSound; time: number; playing: boolean; muted: boolean; onError: () => void }) {
  return <>
    {sound?.voice.map((v) => <SyncedTrack key={v.id} url={v.media.url} start={v.start} duration={v.duration} time={time} playing={playing} muted={muted} volume={1} onError={onError} />)}
    {sound?.music ? <SyncedTrack key={sound.music.media.id} url={sound.music.media.url} start={0} duration={sound.music.duration} time={time} playing={playing} muted={muted} volume={Math.min(1, 10 ** (sound.music.gainDb / 20))} onError={onError} /> : null}
  </>;
}

function SyncedTrack({ url, start, duration, time, playing, muted, volume, onError }: { url: string; start: number; duration: number; time: number; playing: boolean; muted: boolean; volume: number; onError: () => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  const pending = useRef(false);
  const latest = useRef({ time, playing, muted });
  latest.current = { time, playing, muted };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const state = latest.current;
      const offset = state.time - start;
      const length = duration > 0 ? duration : el.duration;
      const audible = state.playing && !state.muted && offset >= 0 && (!Number.isFinite(length) || offset < length);
      el.volume = volume;
      if (!audible) {
        el.pause();
        return;
      }
      if (el.readyState > 0 && Math.abs(el.currentTime - offset) > 0.12) el.currentTime = Math.max(0, offset);
      if (el.paused && !pending.current) {
        pending.current = true;
        void el.play().catch((err: DOMException) => {
          if (err.name !== "AbortError") onError();
        }).finally(() => { pending.current = false; });
      }
    };
    sync();
    el.addEventListener("loadedmetadata", sync);
    return () => el.removeEventListener("loadedmetadata", sync);
  }, [time, playing, muted, start, duration, volume, onError]);

  useEffect(() => {
    const el = ref.current;
    return () => { el?.pause(); };
  }, []);

  return <audio ref={ref} src={url} preload="auto" hidden aria-hidden onError={onError} />;
}
