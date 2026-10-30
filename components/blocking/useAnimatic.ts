"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { advancePlayhead, playbackRange, shotAtTime, shotTimeline, type PlaybackScope, type TimedShot } from "@/lib/animatic";

export function useAnimatic(shots: readonly TimedShot[], selectedId: string | null, onShotChange: (id: string) => void) {
  const slots = useMemo(() => shotTimeline(shots), [shots]);
  const [time, setTime] = useState(() => slots.find((s) => s.id === selectedId)?.start ?? 0);
  const [scope, setScope] = useState<PlaybackScope>("film");
  const [singleId, setSingleId] = useState(selectedId ?? slots[0]?.id ?? "");
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const range = playbackRange(slots, scope, singleId);
  const active = scope === "shot" ? slots.find((s) => s.id === singleId) ?? slots[0] : shotAtTime(slots, time);
  const clock = useRef(time);
  const reported = useRef(selectedId);
  clock.current = time;

  const seek = useCallback((next: number) => {
    const clamped = Math.max(range.start, Math.min(range.end, next));
    clock.current = clamped;
    setTime(clamped);
  }, [range.start, range.end]);

  const select = useCallback((id: string) => {
    const slot = slots.find((s) => s.id === id);
    if (!slot) return;
    setSingleId(id);
    clock.current = slot.start;
    setTime(slot.start);
    reported.current = id;
    onShotChange(id);
  }, [slots, onShotChange]);

  // A shot selected by Astra or another studio control also seeks the player.
  useEffect(() => {
    if (!selectedId || selectedId === reported.current) return;
    setPlaying(false);
    select(selectedId);
  }, [selectedId, select]);

  useEffect(() => {
    if (!active || active.id === reported.current) return;
    reported.current = active.id;
    onShotChange(active.id);
  }, [active?.id, onShotChange]); // Only report shot boundaries, never animation frames.

  useEffect(() => {
    if (clock.current < range.start || clock.current > range.end) {
      setPlaying(false);
      seek(clock.current);
    }
  }, [range.start, range.end, seek]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = advancePlayhead(clock.current, (now - last) / 1000, range, scope === "shot" && loop);
      last = now;
      clock.current = next.time;
      setTime(next.time);
      if (next.ended) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, range.start, range.end, scope, loop]);

  useEffect(() => {
    const pauseWhenHidden = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  const toggle = useCallback(() => {
    if (playing) return setPlaying(false);
    if (range.end <= range.start) return;
    if (clock.current >= range.end - 0.01) seek(range.start);
    setPlaying(true);
  }, [playing, range.start, range.end, seek]);

  const changeScope = useCallback((next: PlaybackScope) => {
    if (active) setSingleId(active.id);
    setScope(next);
  }, [active]);

  return { time, localTime: Math.max(0, time - (active?.start ?? 0)), active, slots, range, scope, changeScope, playing, toggle, pause: () => setPlaying(false), seek, select, loop, setLoop };
}
