"use client";

import { ArrowUpRight, FileText, Paperclip, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DURATION_PRESETS, MAX_DURATION, MIN_DURATION } from "@/lib/types";

/**
 * The opening: one question. A script, images and footage are optional. The planning
 * allowance is stated plainly here because starting the project is what spends it.
 */
export function Opening({ live }: { live: boolean }) {
  const router = useRouter();
  const [idea, setIdea] = useState("");
  const [kind, setKind] = useState<"commercial" | "film">("commercial");
  const [duration, setDuration] = useState(30);
  const [aspect, setAspect] = useState<"16:9" | "9:16">("16:9");
  const [files, setFiles] = useState<File[]>([]);
  const [script, setScript] = useState<string | null>(null);
  const [allowance, setAllowance] = useState("3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  async function start() {
    if (!idea.trim()) return setError("Tell me what you have in mind. A sentence is enough.");
    if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) return setError(`Length is ${MIN_DURATION} to ${MAX_DURATION} seconds.`);
    const dollars = Number(allowance || 0);
    if (!(dollars >= 0) || dollars > 50) return setError("The planning allowance is between $0 and $50.");
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("idea", idea.trim());
    form.set("kind", kind);
    form.set("duration", String(duration));
    form.set("aspect", aspect);
    form.set("autopilot", "false");
    form.set("allowance", String(dollars));
    if (script?.trim()) form.set("script", script.trim());
    for (const f of files) form.append("files", f);
    try {
      const res = await fetch("/api/projects", { method: "POST", body: form });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? "The studio couldn't start this project.");
      router.push(`/p/${body.id}?stage=brief`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="fl-intro-copy">
      <div className="fl-eyebrow">An idea is enough</div>
      <h1 className="fl-h1">
        What are
        <br />
        we making?
      </h1>
      <form
        className="fl-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <label className="fl-sr" htmlFor="fl-idea">
          Your idea
        </label>
        <textarea
          id="fl-idea"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="A 30-second spot for our bike repair shop: the first ride of spring."
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start();
          }}
        />
        {script !== null ? (
          <div className="fl-script-box">
            <label className="fl-label" htmlFor="fl-script">
              Your script (kept word for word)
            </label>
            <textarea id="fl-script" value={script} rows={5} onChange={(e) => setScript(e.target.value)} placeholder="Paste a script or AV plan" />
          </div>
        ) : null}
        {files.length ? (
          <ul className="fl-files" aria-label="Your material">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {f.type.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={URL.createObjectURL(f)} alt="" />
                ) : (
                  <span className="fl-file-video">▶</span>
                )}
                <span>{f.name}</span>
                <button type="button" className="fl-icon-btn fl-icon-btn--sm" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  <X size={11} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="fl-prompt-bottom">
          <div className="fl-prompt-add">
            <button type="button" className="fl-quiet-btn" onClick={() => picker.current?.click()}>
              <Paperclip size={13} aria-hidden /> Images or footage
            </button>
            <button type="button" className="fl-quiet-btn" onClick={() => setScript(script === null ? "" : null)} aria-pressed={script !== null}>
              <FileText size={13} aria-hidden /> {script === null ? "Paste a script" : "No script"}
            </button>
          </div>
          <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime" multiple hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 8))} />
          <button type="submit" className="fl-btn fl-btn--primary" disabled={busy}>
            {busy ? "Starting…" : "Start"} <ArrowUpRight size={14} aria-hidden />
          </button>
        </div>
      </form>
      {error ? (
        <p className="fl-banner" data-tone="bad" role="alert">
          {error}
        </p>
      ) : null}
      <div className="fl-options" role="group" aria-label="Format">
        {(["commercial", "film"] as const).map((k) => (
          <button key={k} type="button" className="fl-pill" aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k === "commercial" ? "Commercial" : "Story"}
          </button>
        ))}
        <span className="fl-options-split" />
        {DURATION_PRESETS.map((d) => (
          <button key={d} type="button" className="fl-pill" aria-pressed={duration === d} onClick={() => setDuration(d)}>
            {d === 120 ? "2 min" : d === 60 ? "1 min" : d === 90 ? "1:30" : `${d} s`}
          </button>
        ))}
        <span className="fl-options-split" />
        {(["16:9", "9:16"] as const).map((a) => (
          <button key={a} type="button" className="fl-pill" aria-pressed={aspect === a} onClick={() => setAspect(a)}>
            {a}
          </button>
        ))}
      </div>
      <div className="fl-options fl-options--money" role="group" aria-label="Spending">
        {live ? (
          <>
            <label className="fl-allowance-line">
              <span>Astra may spend up to $</span>
              <input className="fl-input fl-input--tiny" inputMode="decimal" value={allowance} onChange={(e) => setAllowance(e.target.value.replace(/[^0-9.]/g, "").slice(0, 5))} aria-label="Planning allowance in dollars" />
              <span className="fl-muted">on drafts, references and storyboard frames. Video always asks first.</span>
            </label>
          </>
        ) : (
          <span className="fl-muted">Spending is off on this server: you can plan and direct, but nothing is generated.</span>
        )}
      </div>
    </div>
  );
}
