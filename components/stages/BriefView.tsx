"use client";

import { FileText, Film, ImagePlus } from "lucide-react";
import { useRef } from "react";
import { formatDuration, useStudio } from "../studio/Studio";
import { EditableText, More, Photo, Spinner } from "../studio/ui";
import { brevity } from "@/lib/plain";

/** The brief: one summary, a few short facts marked as yours or assumed, and one question at a time. */
export function BriefView() {
  const { view, op, notify, refresh } = useStudio();
  const file = useRef<HTMLInputElement | null>(null);
  const b = view.brief?.data;
  const p = view.project;
  if (!b) return null;
  const reading = !view.brief?.interpreted;
  const sample = p.sample;
  const supplied = b.supplied ?? { purpose: false, audience: false, tone: false };
  const question = b.questions.find((q) => !q.answer);

  async function upload(f: File) {
    const form = new FormData();
    form.set("file", f);
    const res = await fetch(`/api/projects/${p.id}/uploads`, { method: "POST", body: form });
    const body = (await res.json()) as { summary?: string; error?: string };
    notify(body.summary ?? body.error ?? "Added.", res.ok);
    await refresh();
  }

  const fields: { key: "purpose" | "audience" | "tone"; label: string }[] = [
    { key: "purpose", label: "Purpose" },
    { key: "audience", label: "Audience" },
    { key: "tone", label: "Tone" },
  ];

  return (
    <section className="fl-stage fl-brief" aria-label="Brief">
      <div className="fl-eyebrow">What are we making?</div>
      <h2 className="fl-h2">{p.title === "Untitled" ? "Your idea" : p.title}</h2>
      <blockquote className="fl-idea">
        <EditableText value={b.idea} label="the idea" multiline onSave={(idea) => void op("update_brief", { idea })} disabled={sample} />
      </blockquote>

      {reading ? (
        <div className="fl-reading">
          <Spinner label={view.allowance || sample ? "Reading your idea" : "Waiting for a planning allowance"} />
        </div>
      ) : (
        <>
          {b.summary ? <p className="fl-lede">{b.summary}</p> : null}
          <dl className="fl-facts-grid">
            {fields.map((f) => (
              <div key={f.key}>
                <dt>
                  {f.label} <span className="fl-source" data-supplied={supplied[f.key] || undefined}>{supplied[f.key] ? "You" : "Assumed"}</span>
                </dt>
                <dd>
                  <EditableText value={b[f.key]} display={brevity(b[f.key], f.key === "tone" ? 6 : 10)} label={f.label} disabled={sample} onSave={(v) => void op("update_brief", { [f.key]: v })} />
                </dd>
              </div>
            ))}
            <div>
              <dt>
                Length <span className="fl-source" data-supplied>You</span>
              </dt>
              <dd className="fl-pills">
                {[30, 45, 60, 90, 120].map((d) => (
                  <button key={d} type="button" className="fl-pill" aria-pressed={p.duration === d} disabled={sample} onClick={() => void op("update_brief", { duration: d })}>
                    {formatDuration(d)}
                  </button>
                ))}
              </dd>
            </div>
            <div>
              <dt>
                Format <span className="fl-source" data-supplied>You</span>
              </dt>
              <dd className="fl-pills">
                {(["commercial", "film"] as const).map((k) => (
                  <button key={k} type="button" className="fl-pill" aria-pressed={p.kind === k} disabled={sample} onClick={() => void op("update_brief", { kind: k })}>
                    {k === "commercial" ? "Commercial" : "Story"}
                  </button>
                ))}
                {(["16:9", "9:16"] as const).map((a) => (
                  <button key={a} type="button" className="fl-pill" aria-pressed={p.aspect === a} disabled={sample} onClick={() => void op("update_brief", { aspect: a })}>
                    {a}
                  </button>
                ))}
              </dd>
            </div>
          </dl>

          {question ? (
            <div className="fl-question">
              <p>{question.question}</p>
              <div className="fl-choice-row">
                {question.choices.map((c) => (
                  <button key={c.id} type="button" className="fl-pill" data-recommended={c.recommended || undefined} disabled={sample} onClick={() => void op("update_brief", { answer: { questionId: question.id, answer: c.label } })}>
                    {c.label}
                    {c.recommended ? <small className="fl-accent"> · recommended</small> : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="fl-materials">
            {b.uploads.map((u) => {
              const asset = view.assets.find((a) => a.primary?.media?.id === u.mediaId || a.gallery.some((g) => g.media?.id === u.mediaId));
              return (
                <figure key={u.mediaId} className="fl-material">
                  {u.use === "footage" ? <Film size={16} aria-hidden /> : <Photo media={view.footage.find((f) => f.mediaId === u.mediaId)?.media ?? asset?.primary?.media ?? null} aspect="1" alt={u.label} showProvenance={false} />}
                  <figcaption>{asset?.name ?? u.label}</figcaption>
                </figure>
              );
            })}
            {b.script ? (
              <figure className="fl-material">
                <FileText size={16} aria-hidden />
                <figcaption>Your script</figcaption>
              </figure>
            ) : null}
            {!sample ? (
              <button type="button" className="fl-material fl-material--add" onClick={() => file.current?.click()}>
                <ImagePlus size={16} aria-hidden />
                <span>Add images or footage</span>
              </button>
            ) : null}
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          </div>

          <More label="Facts and assumptions">
            <div className="fl-two">
              <div>
                <h4 className="fl-label">You said</h4>
                <ul className="fl-list">{b.facts.length ? b.facts.map((f, i) => <li key={i}>{f}</li>) : <li className="fl-muted">Just the idea</li>}</ul>
              </div>
              <div>
                <h4 className="fl-label">Assumed</h4>
                <ul className="fl-list">
                  {b.assumptions.map((a, i) => (
                    <li key={i}>
                      <EditableText value={a} label="assumption" disabled={sample} onSave={(v) => void op("update_brief", { assumptions: b.assumptions.map((x, j) => (j === i ? v : x)) })} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {b.pacing ? <p className="fl-caption">Pacing: {b.pacing}</p> : null}
            {b.script ? <pre className="fl-script-supplied">{b.script}</pre> : null}
          </More>
        </>
      )}
    </section>
  );
}
