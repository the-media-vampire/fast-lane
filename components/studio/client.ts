"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView, QuoteCard } from "@/lib/view-types";

/** Studio data: one polled view per project, plus the write paths (ops, quotes and Astra). */

export type OpResponse = {
  ok: boolean;
  summary: string;
  navigate?: string;
  quote?: QuoteCard;
  data?: unknown;
};

export async function runOp(projectId: string, op: string, input: Record<string, unknown> = {}): Promise<OpResponse> {
  const res = await fetch(`/api/projects/${projectId}/ops`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, input }) });
  try {
    return (await res.json()) as OpResponse;
  } catch {
    return { ok: false, summary: `The studio didn't answer (${res.status}).` };
  }
}

/** The person's answer to an estimate. Only this path can accept one. */
export async function answerQuote(projectId: string, quoteId: string, action: "approve" | "decline"): Promise<OpResponse> {
  const res = await fetch(`/api/projects/${projectId}/quotes/${quoteId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
  try {
    return (await res.json()) as OpResponse;
  } catch {
    return { ok: false, summary: `The studio didn't answer (${res.status}).` };
  }
}

export function useProject(projectId: string, initial: ProjectView | null) {
  const [view, setView] = useState<ProjectView | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const rev = useRef<number | null>(initial?.project.rev ?? null);
  const busy = useRef(false);

  const refresh = useCallback(
    async (force = false) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const q = !force && rev.current != null ? `?rev=${rev.current}` : "";
        const res = await fetch(`/api/projects/${projectId}${q}`, { cache: "no-store" });
        if (res.status === 204) return;
        if (!res.ok) throw new Error(res.status === 404 ? "This project no longer exists." : `The studio didn't answer (${res.status}).`);
        const next = (await res.json()) as ProjectView;
        rev.current = next.project.rev;
        setView(next);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        busy.current = false;
      }
    },
    [projectId],
  );

  const activeCount = view?.jobs.active.length ?? 0;
  useEffect(() => {
    const ms = activeCount > 0 ? 1500 : 5000;
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
  }, [refresh, activeCount]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { view, error, refresh };
}

export function money(cents: number) {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

export function clock(seconds: number, tenths = false) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${tenths ? r.toFixed(1).padStart(4, "0") : String(Math.floor(r)).padStart(2, "0")}`;
}

export function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function secs(n: number) {
  return `${Number.isInteger(n) ? n : n.toFixed(1)} s`;
}

/** Remembered per-viewer conveniences; never required for anything to work. */
export function remember(key: string, value?: string): string | null {
  try {
    if (value === undefined) return window.localStorage.getItem(key);
    window.localStorage.setItem(key, value);
    return value;
  } catch {
    return null;
  }
}
