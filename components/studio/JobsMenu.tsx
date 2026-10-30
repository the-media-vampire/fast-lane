"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, Layers } from "lucide-react";
import { useStudio } from "./Studio";
import { money } from "./client";
import { Spinner } from "./ui";

/** What's running, what failed, and anything uncertain that needs a person's decision. */
export function JobsMenu() {
  const { view, op } = useStudio();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const active = view.jobs.active;
  const attention = view.jobs.attention;
  const held = active.filter((j) => j.hold);

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

  const resolve = (jobId: string, action: string) => void op("resolve_job", { jobId, action });

  return (
    <div className="fl-jobs" ref={ref}>
      <button type="button" className="fl-jobs-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} data-attention={attention.length > 0 || held.length > 0 || undefined}>
        {active.length > held.length ? <Spinner /> : attention.length || held.length ? <CircleAlert size={14} aria-hidden /> : <Layers size={14} aria-hidden />}
        <span>{active.length > held.length ? `${active.length - held.length} working` : attention.length ? `${attention.length} need${attention.length === 1 ? "s" : ""} you` : held.length ? `${held.length} paused` : "Jobs"}</span>
      </button>
      {open ? (
        <div className="fl-pop" role="dialog" aria-label="Jobs">
          {attention.length ? (
            <section>
              <h4>Needs a decision</h4>
              {attention.map((j) => (
                <div key={j.id} className="fl-job" data-status={j.status}>
                  <div>
                    <strong>{j.label}</strong>
                    <p className="fl-muted">{j.status === "ambiguous" ? `Uncertain: ${j.error ?? "the provider may have received it."}` : (j.error ?? "Failed")}</p>
                  </div>
                  <div className="fl-job-actions">
                    {j.status === "ambiguous" ? (
                      <>
                        {j.providerTaskId ? (
                          <button type="button" className="fl-btn fl-btn--sm fl-btn--ghost" onClick={() => resolve(j.id, "check")}>
                            Check again
                          </button>
                        ) : null}
                        <button type="button" className="fl-btn fl-btn--sm fl-btn--quiet" onClick={() => resolve(j.id, "buy_again")} title="The first request stays held until you mark it">
                          Buy again{j.estCents ? ` · ${money(j.estCents)}` : ""}
                        </button>
                        <button type="button" className="fl-btn fl-btn--sm fl-btn--quiet" onClick={() => resolve(j.id, "not_charged")} title="After checking the provider's dashboard">
                          Not charged
                        </button>
                      </>
                    ) : (
                      <button type="button" className="fl-btn fl-btn--sm fl-btn--ghost" onClick={() => resolve(j.id, "retry")}>
                        Retry{j.estCents ? ` · ${money(j.estCents)}` : ""}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </section>
          ) : null}
          <section>
            <h4>{active.length > held.length ? "Working now" : held.length ? "Paused" : "Nothing running"}</h4>
            {held.length && held.length === active.length && held.every((j) => j.kind === "review.take") ? <button type="button" className="fl-btn fl-btn--sm fl-btn--ghost" onClick={() => void op("resume_reviews", { jobIds: held.map((j) => j.id) }).then(() => setOpen(false))}>Get review estimate</button> : null}
            {active.map((j) => (
              <div key={j.id} className="fl-job" data-status={j.status}>
                <div>
                  <strong>{j.label}</strong>
                  <p className="fl-muted">{j.hold ? `Paused: ${j.hold}` : j.status === "submitted" ? "With the provider" : j.status === "queued" ? "Queued" : "Starting"}</p>
                </div>
                {j.hold && j.status === "queued" ? <button type="button" className="fl-btn fl-btn--sm fl-btn--quiet" onClick={() => resolve(j.id, "drop")}>Cancel</button> : <Spinner />}
              </div>
            ))}
            <p className="fl-caption">{held.length === active.length && held.length ? "Paused work needs your decision before it can continue." : "Running jobs continue if you close this window."}</p>
          </section>
          <section>
            <h4>Recent</h4>
            <ul className="fl-job-log">
              {view.jobs.recent.slice(0, 10).map((j) => (
                <li key={j.id} data-status={j.status}>
                  <span>{j.label}</span>
                  <span className="fl-muted">{j.status === "succeeded" ? (j.actualCents ? money(j.actualCents) : "done") : j.status}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  );
}
