"use client";

import { useStudio } from "./Studio";
import type { ShotView } from "@/lib/view-types";
import { useEffect, useRef } from "react";

/** The shot filmstrip shared by Direct and Cut: the same numbers and order everywhere. */
export function Filmstrip({ activeId, onSelect, label = "Shots", mediaMode = "cut", time, follow = false }: { activeId: string | null; onSelect: (shot: ShotView) => void; label?: string; mediaMode?: "cut" | "storyboard"; time?: number; follow?: boolean }) {
  const { view } = useStudio();
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!follow) return;
    const el = strip.current;
    const selected = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !selected) return;
    const reveal = (behavior: ScrollBehavior) => {
      const left = selected.getBoundingClientRect().left - el.getBoundingClientRect().left;
      if (left < 0 || left + selected.offsetWidth > el.clientWidth) el.scrollTo({ left: el.scrollLeft + left - (el.clientWidth - selected.offsetWidth) / 2, behavior });
    };
    reveal("smooth");
    const resize = new ResizeObserver(() => reveal("instant"));
    resize.observe(el);
    return () => resize.disconnect();
  }, [activeId, follow]);
  const shots = view.shots?.items ?? [];
  if (!shots.length) return null;
  const total = shots.reduce((a, s) => a + s.duration, 0);
  return (
    <div ref={strip} className="fl-strip" role="listbox" aria-label={label} data-aspect={view.project.aspect}>
      {shots.map((s) => {
        const media = (mediaMode === "cut" ? s.pick?.media : null) ?? s.storyboard?.media ?? s.capture?.media ?? null;
        return (
          <button key={s.id} type="button" role="option" aria-selected={s.id === activeId} className="fl-strip-item" style={{ flexGrow: s.duration / total }} onClick={() => onSelect(s)} title={`${s.number} · ${s.summaryText} · ${s.duration} s`}>
            <span className="fl-strip-thumb">
              {media ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={media.kind === "video" ? `${media.url}?v=preview` : media.preview} alt="" loading="lazy" />
              ) : null}
              {mediaMode === "cut" && s.pick?.kind === "take" ? <span className="fl-strip-live" aria-label="Footage" /> : null}
              {s.storyboard && !s.storyboard.current ? <span className="fl-strip-stale" aria-label="Outdated" /> : null}
              {time !== undefined && s.id === activeId ? <span className="fl-strip-progress" style={{ width: `${Math.min(100, Math.max(0, (time - s.start) / s.duration * 100))}%` }} /> : null}
            </span>
            <span className="fl-strip-meta">
              <span>{s.number}</span>
              <span>{s.duration}s</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
