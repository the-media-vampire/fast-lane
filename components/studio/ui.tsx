"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import type { MediaRef, Provenance, QuoteCard } from "@/lib/view-types";
import { money } from "./client";

/** Small shared pieces of the studio UI. */

const PROVENANCE: Record<Provenance, string> = {
  sample: "Sample",
  live: "Generated",
  upload: "Your file",
  blocking: "Grey blocking",
  assembled: "Assembled",
};

export function ProvenanceBadge({ provenance, className }: { provenance: Provenance; className?: string }) {
  return (
    <span className={`fl-badge ${className ?? ""}`} data-tone={provenance}>
      {PROVENANCE[provenance]}
    </span>
  );
}

export type Tone = "neutral" | "accent" | "warn" | "ok" | "bad" | "sample" | "live";

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className="fl-badge" data-tone={tone} title={title}>
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="fl-spinner" role="status">
      <Loader2 aria-hidden size={14} />
      {label ? <span>{label}</span> : <span className="fl-sr">Working</span>}
    </span>
  );
}

/** A picture slot: media, a working shimmer, or an empty frame. */
export function Photo({
  media,
  aspect = "16 / 9",
  alt,
  working,
  label,
  className,
  showProvenance = true,
  fit = "cover",
}: {
  media: MediaRef | null | undefined;
  aspect?: string;
  alt: string;
  working?: boolean;
  label?: string;
  className?: string;
  showProvenance?: boolean;
  fit?: "cover" | "contain";
}) {
  return (
    <div className={`fl-photo ${className ?? ""}`} style={{ aspectRatio: aspect }} data-empty={!media || undefined} data-working={working || undefined}>
      {media ? (
        media.kind === "video" ? (
          <video src={media.url} muted playsInline preload="metadata" aria-label={alt} style={{ objectFit: fit }} poster={`${media.url}?v=preview`} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media.preview} alt={alt} loading="lazy" style={{ objectFit: fit }} />
        )
      ) : (
        <span className="fl-photo-empty">{working ? <Spinner label={label ?? "Drawing"} /> : (label ?? "")}</span>
      )}
      {media && showProvenance ? <ProvenanceBadge provenance={media.provenance} className="fl-photo-badge" /> : null}
    </div>
  );
}

/** Click-to-edit text that saves on blur or Enter (Shift+Enter for a new line). */
export function EditableText({
  value,
  display,
  onSave,
  label,
  multiline,
  className,
  placeholder,
  disabled,
}: {
  value: string;
  /** A shorter text to show until editing begins (the full value is what gets edited). */
  display?: string;
  onSave: (next: string) => Promise<void> | void;
  label: string;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  async function commit() {
    const next = draft.trim();
    if (!next || next === value.trim()) {
      setEditing(false);
      setDraft(value);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`fl-editable ${className ?? ""}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) setEditing(true);
        }}
        aria-label={`Edit ${label}`}
        disabled={disabled}
        data-saving={saving || undefined}
        title={display && display !== value ? value : undefined}
      >
        {(display ?? value) || <span className="fl-muted">{placeholder ?? "Add…"}</span>}
      </button>
    );
  }
  return (
    <textarea
      ref={ref}
      className={`fl-editable-input ${className ?? ""}`}
      aria-label={label}
      value={draft}
      rows={multiline ? 3 : 1}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void commit();
        }
      }}
    />
  );
}

export function Modal({ title, onClose, children, actions, wide }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, [href], input, textarea, select")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="fl-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="fl-modal" data-wide={wide || undefined} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="fl-modal-head">
          <h3 id={id} className="fl-h3">
            {title}
          </h3>
          <button type="button" className="fl-icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="fl-modal-body">{children}</div>
        {actions ? <div className="fl-modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function Toast({ message, ok, onDone }: { message: string; ok: boolean; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 5200);
    return () => clearTimeout(t);
  }, [onDone, message]);
  return (
    <div className="fl-toast" role="status" data-ok={ok || undefined}>
      {ok ? <Check size={14} aria-hidden /> : <X size={14} aria-hidden />}
      <span>{message}</span>
    </div>
  );
}

/** A quiet disclosure for detail the default screen leaves out. */
export function More({ label = "Details", children, className }: { label?: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`fl-more ${className ?? ""}`} data-open={open || undefined}>
      <button type="button" className="fl-more-btn" aria-expanded={open} onClick={(e) => (e.stopPropagation(), setOpen((o) => !o))}>
        {label} <ChevronDown size={12} aria-hidden />
      </button>
      {open ? <div className="fl-more-body">{children}</div> : null}
    </div>
  );
}

/** Pictures one at a time: arrow keys move, Escape closes. */
export function Lightbox({ items, start = 0, onClose, title, actions }: { items: { media: MediaRef | null; label: string; detail?: string }[]; start?: number; onClose: () => void; title: string; actions?: (index: number) => ReactNode }) {
  const [i, setI] = useState(start);
  const item = items[i];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setI((x) => Math.min(items.length - 1, x + 1));
      if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length]);
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="fl-lightbox">
        <button type="button" className="fl-icon-btn" aria-label="Previous" disabled={i === 0} onClick={() => setI(i - 1)}>
          <ChevronLeft size={18} aria-hidden />
        </button>
        <figure>
          {item?.media ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.media.url} alt={item.label} />
          ) : (
            <div className="fl-photo" data-empty style={{ aspectRatio: "4 / 3" }} />
          )}
          <figcaption>
            <span>{item?.label}</span>
            {item?.detail ? <span className="fl-muted">{item.detail}</span> : null}
            <span className="fl-muted">
              {i + 1} / {items.length}
            </span>
          </figcaption>
        </figure>
        <button type="button" className="fl-icon-btn" aria-label="Next" disabled={i >= items.length - 1} onClick={() => setI(i + 1)}>
          <ChevronRight size={18} aria-hidden />
        </button>
      </div>
      {actions ? <div className="fl-lightbox-actions">{actions(i)}</div> : null}
    </Modal>
  );
}

/** A priced offer: what will be made, the estimate and the ceiling. Only the person approves it. */
export function QuoteView({ q, onApprove, onDecline, busy, compact }: { q: QuoteCard; onApprove: () => void; onDecline: () => void; busy?: boolean; compact?: boolean }) {
  return (
    <div className="fl-quote" data-compact={compact || undefined}>
      <div className="fl-quote-head">
        <strong>{q.label}</strong>
        <span className="fl-quote-price">{money(q.cents)}</span>
      </div>
      {!compact && q.detail.scope.length ? (
        <ul className="fl-quote-scope">
          {q.detail.scope.slice(0, 4).map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : null}
      <p className="fl-quote-ceiling">
        Ceiling {money(q.ceilingCents)}
        {q.detail.retryCents ? <span className="fl-muted"> · includes {money(q.detail.retryCents)} for retries</span> : null}
      </p>
      {!compact && q.detail.notes.length ? <p className="fl-caption">{q.detail.notes.join(" ")}</p> : null}
      <div className="fl-quote-actions">
        <button type="button" className="fl-btn fl-btn--quiet fl-btn--sm" onClick={onDecline} disabled={busy}>
          Not now
        </button>
        <button type="button" className="fl-btn fl-btn--primary fl-btn--sm" onClick={onApprove} disabled={busy}>
          {busy ? "Approving…" : `Approve up to ${money(q.ceilingCents)}`}
        </button>
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="fl-empty">
      <p className="fl-h3">{title}</p>
      {children ? <div className="fl-muted">{children}</div> : null}
    </div>
  );
}
