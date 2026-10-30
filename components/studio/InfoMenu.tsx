"use client";

import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { useStudio } from "./Studio";
import { money } from "./client";
import { EditableText } from "./ui";

/** Project information kept out of the way: spending, approvals, the reviewer and the providers. */
export function InfoMenu() {
  const { view, op } = useStudio();
  const [open, setOpen] = useState(false);
  const [allowance, setAllowance] = useState("");
  const [limit, setLimit] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const s = view.spend;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="fl-jobs" ref={ref}>
      <button type="button" className="fl-icon-btn fl-info-btn" aria-expanded={open} aria-haspopup="dialog" aria-label="Project information" onClick={() => setOpen((o) => !o)}>
        <Info size={15} aria-hidden />
      </button>
      {open ? (
        <div className="fl-pop" role="dialog" aria-label="Project information">
          <section>
            <h4>Mode</h4>
            <p className="fl-info-line">{view.mode === "sample" ? "Sample project: illustrative content, recorded replies, nothing billed." : view.mode === "off" ? (view.modeReason ?? "Spending is off.") : "Live: approved work runs on real providers."}</p>
          </section>
          <section>
            <h4>Creative reviewer</h4>
            <EditableText value={view.project.reviewer ?? ""} placeholder="Name the person who signs off" label="creative reviewer" onSave={(name) => void op("set_reviewer", { name })} />
          </section>
          {view.mode !== "sample" ? (
            <section>
              <h4>Spending</h4>
              <dl className="fl-info-grid">
                <dt>Spent</dt>
                <dd>{money(s.spentCents)}</dd>
                <dt>Project limit</dt>
                <dd>{money(s.budgetCents)}</dd>
                <dt>Held for running work</dt>
                <dd>{money(s.reservedCents)}</dd>
                {s.uncertainCents ? (
                  <>
                    <dt>Uncertain</dt>
                    <dd>{money(s.uncertainCents)}</dd>
                  </>
                ) : null}
                <dt>Planning allowance</dt>
                <dd>{view.allowance ? `${money(view.allowance.remainingCents)} left of ${money(view.allowance.ceilingCents)}` : "None"}</dd>
              </dl>
              {view.mode === "live" ? (
                <form className="fl-inline-add" onSubmit={(e) => { e.preventDefault(); const dollars = Number(limit); if (Number.isFinite(dollars)) void op("set_budget", { dollars }); setLimit(""); }}>
                  <input className="fl-input" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="Project limit, $" aria-label="Project spending limit in dollars" />
                  <button type="submit" className="fl-btn fl-btn--sm fl-btn--ghost" disabled={!limit}>Set limit</button>
                </form>
              ) : null}
              {view.mode === "live" ? (
                <form
                  className="fl-inline-add"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const d = Number(allowance);
                    if (d >= 0) void op("set_allowance", { dollars: d });
                    setAllowance("");
                  }}
                >
                  <input className="fl-input" inputMode="decimal" value={allowance} onChange={(e) => setAllowance(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="New allowance, $" aria-label="Planning allowance in dollars" />
                  <button type="submit" className="fl-btn fl-btn--sm fl-btn--ghost" disabled={!allowance}>
                    Set
                  </button>
                </form>
              ) : null}
              {view.authorizations.filter((a) => a.kind !== "allowance").length ? (
                <ul className="fl-job-log">
                  {view.authorizations
                    .filter((a) => a.kind !== "allowance")
                    .slice(-6)
                    .map((a) => (
                      <li key={a.id}>
                        <span>{a.label}</span>
                        <span className="fl-muted">
                          {money(a.spentCents)} of {money(a.ceilingCents)}
                        </span>
                      </li>
                    ))}
                </ul>
              ) : null}
              <p className="fl-caption">Video always needs an approved estimate. Charges are recorded per call{s.estimatedCents ? `; ${money(s.estimatedCents)} of them are estimates rather than provider-reported` : ""}.</p>
            </section>
          ) : null}
          <section>
            <h4>Providers</h4>
            <ul className="fl-job-log">
              {view.provider.models.map((m) => (
                <li key={m}>
                  <span>{m}</span>
                </li>
              ))}
              {view.provider.kieCredits != null ? (
                <li>
                  <span>Kie balance</span>
                  <span className="fl-muted">{money(Math.round(view.provider.kieCredits * 0.5))}</span>
                </li>
              ) : null}
            </ul>
            <p className="fl-caption">Video receives the storyboard frame and written direction, not the 3D motion track.</p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
