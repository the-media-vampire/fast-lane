"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { STAGES, STAGE_LABELS, studioStage, type Stage } from "@/lib/types";
import type { ProjectView, QuoteCard } from "@/lib/view-types";
import { answerQuote, money, remember, runOp, useProject, type OpResponse } from "./client";
import { AgentPanel } from "./AgentPanel";
import { JobsMenu } from "./JobsMenu";
import { InfoMenu } from "./InfoMenu";
import { Toast, Modal, QuoteView } from "./ui";
import { BriefView } from "../stages/BriefView";
import { ConceptView } from "../stages/ConceptView";
import { AssetsView } from "../stages/AssetsView";
import { ShotsView } from "../stages/ShotsView";
import { DirectView } from "../stages/DirectView";
import { CutView } from "../stages/CutView";

/** What the person has selected: the agent's default scope for local instructions. */
export type Focus = { kind: "shot" | "asset" | "concept" | "line" | "moment" | "cut" | "beat"; id?: string; label: string; time?: number; cutId?: string };

type StudioCtx = {
  view: ProjectView;
  stage: Stage;
  go: (stage: Stage, shot?: string | null) => void;
  shotId: string | null;
  selectShot: (id: string | null) => void;
  focus: Focus | null;
  setFocus: (f: Focus | null) => void;
  /** Run a validated operation; shows the result, follows navigation, surfaces estimates. */
  op: (name: string, input?: Record<string, unknown>) => Promise<OpResponse>;
  /** The person's answer to an estimate. */
  answer: (q: QuoteCard, action: "approve" | "decline") => Promise<void>;
  /** Send a message to Astra with the current stage and selection. */
  ask: (text: string) => Promise<void>;
  thinking: boolean;
  refresh: () => Promise<void>;
  notify: (message: string, ok?: boolean) => void;
  showQuote: (q: QuoteCard) => void;
  agentOpen: boolean;
  setAgentOpen: (open: boolean) => void;
};

const Ctx = createContext<StudioCtx | null>(null);

export function useStudio() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useStudio outside Studio");
  return c;
}

export function shotFocus(s: { id: string; number: string; title: string }): Focus {
  return { kind: "shot", id: s.id, label: `Shot ${s.number} · ${s.title}` };
}

export function Studio({ projectId, initial }: { projectId: string; initial: ProjectView | null }) {
  const { view, error, refresh } = useProject(projectId, initial);
  const router = useRouter();
  const params = useSearchParams();
  const urlStage = params.get("stage");
  const [stage, setStage] = useState<Stage>(studioStage(urlStage) ?? defaultStage(initial));
  const [shotId, setShotId] = useState<string | null>(params.get("shot"));
  const [focus, setFocus] = useState<Focus | null>(null);
  const [thinking, setThinking] = useState(false);
  const [toast, setToast] = useState<{ message: string; ok: boolean } | null>(null);
  const [pending, setPending] = useState<QuoteCard | null>(null);
  const [agentOpen, setAgentOpenState] = useState(true);
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    if (urlStage !== "plan") return;
    const q = new URLSearchParams(window.location.search);
    q.set("stage", "shots");
    window.history.replaceState(null, "", `?${q.toString()}`);
  }, [urlStage]);

  useEffect(() => {
    if (remember("fl-agent") === "closed") setAgentOpenState(false);
  }, []);
  const setAgentOpen = useCallback((open: boolean) => {
    setAgentOpenState(open);
    remember("fl-agent", open ? "open" : "closed");
  }, []);

  const go = useCallback(
    (next: Stage, shot?: string | null) => {
      setStage(next);
      if (shot !== undefined) setShotId(shot);
      const q = new URLSearchParams();
      q.set("stage", next);
      const s = shot === undefined ? shotId : shot;
      if (s && ["shots", "direct", "cut"].includes(next)) q.set("shot", s);
      router.replace(`/p/${projectId}?${q.toString()}`, { scroll: false });
      setAnnounce(`${STAGE_LABELS[next]} screen`);
      document.getElementById("fl-canvas")?.scrollTo({ top: 0 });
    },
    [projectId, router, shotId],
  );

  const notify = useCallback((message: string, ok = true) => setToast({ message, ok }), []);

  const op = useCallback(
    async (name: string, input: Record<string, unknown> = {}) => {
      const res = await runOp(projectId, name, input);
      if (res.quote) setPending(res.quote);
      else notify(res.summary, res.ok);
      if (res.navigate && STAGES.includes(res.navigate as Stage) && res.navigate !== stage && name !== "direct_shot") go(res.navigate as Stage);
      await refresh(true);
      return res;
    },
    [projectId, notify, refresh, go, stage],
  );

  const answer = useCallback(
    async (q: QuoteCard, action: "approve" | "decline") => {
      const res = await answerQuote(projectId, q.id, action);
      notify(res.summary, res.ok);
      if (res.quote) setPending(res.quote);
      if (res.ok && res.navigate && STAGES.includes(res.navigate as Stage) && res.navigate !== stage) go(res.navigate as Stage);
      await refresh(true);
    },
    [projectId, notify, refresh, stage, go],
  );

  const ask = useCallback(
    async (text: string) => {
      setThinking(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, stage, focus }) });
        const body = (await res.json()) as { navigate?: Stage; error?: string };
        if (body.navigate && body.navigate !== stage && !(stage === "shots" && body.navigate === "direct")) go(body.navigate);
      } catch {
        notify("Astra couldn't be reached. Your message is saved.", false);
      } finally {
        setThinking(false);
        await refresh(true);
      }
    },
    [projectId, stage, focus, go, notify, refresh],
  );

  const selectShot = useCallback((id: string | null) => {
    setShotId(id);
    const q = new URLSearchParams(window.location.search);
    // A new stage can select its first shot before router.replace has reached the URL.
    q.set("stage", stage);
    if (id) q.set("shot", id);
    else q.delete("shot");
    window.history.replaceState(null, "", `?${q.toString()}`);
  }, [stage]);

  // Keep a valid selected shot once shots exist.
  const shots = view?.shots?.items;
  useEffect(() => {
    if (!shots?.length) return;
    if (shotId && !shots.some((s) => s.id === shotId)) setShotId(null);
  }, [shots, shotId]);

  // The selection follows the screen: shots on shot screens, nothing elsewhere until chosen.
  useEffect(() => {
    if (!view) return;
    if (stage === "direct") {
      const s = view.shots?.items.find((x) => x.id === shotId) ?? view.shots?.items[0];
      if (s) setFocus(shotFocus(s));
      return;
    }
    if (stage === "shots") {
      const s = view.shots?.items.find((x) => x.id === shotId);
      setFocus(s ? shotFocus(s) : null);
      return;
    }
    if (stage !== "cut") setFocus((f) => (f && ((stage === "assets" && f.kind === "asset") || (stage === "concept" && f.kind === "concept")) ? f : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, shotId, view?.shots?.version]);

  const ctx = useMemo<StudioCtx | null>(
    () => (view ? { view, stage, go, shotId, selectShot, focus, setFocus, op, answer, ask, thinking, refresh: () => refresh(true), notify, showQuote: setPending, agentOpen, setAgentOpen } : null),
    [view, stage, go, shotId, selectShot, focus, op, answer, ask, thinking, refresh, notify, agentOpen, setAgentOpen],
  );

  if (!view || !ctx) {
    return (
      <div className="fl-app">
        <div className="fl-loading">{error ?? "Opening the studio…"}</div>
      </div>
    );
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="fl-app" data-stage={stage}>
        <Header />
        <StageNav />
        <div className="fl-shell" data-agent={agentOpen ? "open" : "closed"}>
          <main className="fl-main" id="fl-canvas" aria-label={`${STAGE_LABELS[stage]} canvas`}>
            {error ? (
              <div className="fl-banner" data-tone="bad">
                {error}
              </div>
            ) : null}
            <StageSwitch stage={stage} />
          </main>
          <AgentPanel />
        </div>
        <div className="fl-sr" aria-live="polite">
          {announce}
        </div>
        {toast ? <Toast message={toast.message} ok={toast.ok} onDone={() => setToast(null)} /> : null}
        {pending ? <QuoteModal q={pending} onClose={() => setPending(null)} /> : null}
      </div>
    </Ctx.Provider>
  );
}

function defaultStage(v: ProjectView | null): Stage {
  if (!v) return "brief";
  if (v.cuts.length) return "cut";
  if (v.shots?.items.length) return "shots";
  if (v.assets.length) return "assets";
  if (v.plan || v.concepts?.chosenId) return "assets";
  if (v.concepts) return "concept";
  return "brief";
}

function StageSwitch({ stage }: { stage: Stage }) {
  switch (stage) {
    case "brief":
      return <BriefView />;
    case "concept":
      return <ConceptView />;
    case "assets":
      return <AssetsView />;
    case "shots":
      return <ShotsView />;
    case "direct":
      return <DirectView />;
    case "cut":
      return <CutView />;
  }
}

function Header() {
  const { view } = useStudio();
  const p = view.project;
  const s = view.spend;
  return (
    <header className="fl-header">
      <Link href="/" className="fl-brand" aria-label="Fast Lane home">
        Fast Lane <small>FAST LANE</small>
      </Link>
      <div className="fl-header-mid">
        <span className="fl-title">{p.title === "Untitled" ? "A new film" : p.title}</span>
        <span className="fl-header-spec">
          {formatDuration(p.duration)} · {p.aspect} · {p.kind === "commercial" ? "Commercial" : "Short film"}
        </span>
      </div>
      <div className="fl-header-right">
        {view.mode === "sample" ? (
          <span className="fl-badge" data-tone="sample" title="Illustrative content. Nothing here is generated or billed.">
            Sample
          </span>
        ) : view.mode === "off" ? (
          <span className="fl-badge" data-tone="warn" title={view.modeReason ?? undefined}>
            Spending off
          </span>
        ) : (
          <span className="fl-spend" title={`Spent ${money(s.spentCents)} · held ${money(s.reservedCents)}${s.uncertainCents ? ` · uncertain ${money(s.uncertainCents)}` : ""}`}>
            {money(s.spentCents)} <span className="fl-muted">spent</span>
          </span>
        )}
        <InfoMenu />
        <JobsMenu />
      </div>
    </header>
  );
}

export function formatDuration(s: number) {
  if (s % 60 === 0) return `${s / 60} min`;
  if (s > 60) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${s} s`;
}

function StageNav() {
  const { view, stage, go } = useStudio();
  return (
    <nav className="fl-nav" aria-label="Stages">
      {STAGES.map((s, i) => {
        const st = view.stages[s];
        return (
          <button key={s} type="button" className="fl-nav-item" aria-current={s === stage ? "step" : undefined} onClick={() => go(s)} data-status={st.status}>
            <span className="fl-nav-num">{String(i + 1).padStart(2, "0")}</span>
            <span>{STAGE_LABELS[s]}</span>
            {st.label ? <span className="fl-nav-state">{st.label}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}

function QuoteModal({ q, onClose }: { q: QuoteCard; onClose: () => void }) {
  const { answer, view } = useStudio();
  const [busy, setBusy] = useState(false);
  const live = view.quotes.find((x) => x.id === q.id) ?? q;
  return (
    <Modal title="Approve spending" onClose={onClose}>
      <QuoteView
        q={live}
        busy={busy}
        onDecline={async () => {
          setBusy(true);
          await answer(live, "decline");
          setBusy(false);
          onClose();
        }}
        onApprove={async () => {
          setBusy(true);
          await answer(live, "approve");
          setBusy(false);
          onClose();
        }}
      />
      <p className="fl-caption">Work stops at the ceiling. Actual charges are recorded per job.</p>
    </Modal>
  );
}
