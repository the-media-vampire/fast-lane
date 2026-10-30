"use client";

import { Check, ImagePlus, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useStudio } from "../studio/Studio";
import { Lightbox, Photo, Spinner } from "../studio/ui";
import type { AssetImage, AssetView } from "@/lib/view-types";

const KIND: Record<AssetView["kind"], string> = { character: "Character", location: "Location", prop: "Prop" };

/** The film's world: one clear main image per asset, separate references, and who approved it. */
export function AssetsView() {
  const { view } = useStudio();
  const planning = view.jobs.active.some((j) => !j.hold && (j.kind === "think.plan" || j.kind === "think.assets"));
  const groups: AssetView["kind"][] = ["character", "location", "prop"];
  return (
    <section className="fl-stage" aria-label="Assets">
      <div className="fl-stage-top">
        <div>
          <div className="fl-eyebrow">Assets</div>
          <h2 className="fl-h2">Cast, places and props</h2>
        </div>
        {planning ? <Spinner label="Casting" /> : null}
      </div>
      {!view.assets.length ? (
        <div className="fl-grid-4">
          {[0, 1, 2, 3].map((i) => (
            <article key={i} className="fl-asset" aria-hidden>
              <Photo media={null} aspect="4 / 5" alt="" working={planning} label={i === 1 ? "Casting" : ""} />
            </article>
          ))}
        </div>
      ) : (
        <div className="fl-grid-4">
          {groups.flatMap((g) => view.assets.filter((a) => a.kind === g)).map((a) => (
            <AssetCard key={a.id} a={a} />
          ))}
        </div>
      )}
    </section>
  );
}

function AssetCard({ a }: { a: AssetView }) {
  const { view, op, notify, refresh, focus, setFocus } = useStudio();
  const [box, setBox] = useState<number | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  const sample = view.project.sample;
  const selected = focus?.kind === "asset" && focus.id === a.id;
  const images: AssetImage[] = [...(a.primary ? [a.primary] : []), ...a.proposals, ...a.gallery];
  const proposal = a.proposals.find((x) => x.status === "ready");

  async function upload(f: File) {
    const form = new FormData();
    form.set("file", f);
    form.set("assetId", a.id);
    form.set("role", "reference");
    const res = await fetch(`/api/projects/${view.project.id}/uploads`, { method: "POST", body: form });
    const body = (await res.json()) as { summary?: string; error?: string };
    notify(body.summary ?? body.error ?? "Added.", res.ok);
    await refresh();
  }

  const status = a.status === "approved" ? { tone: "ok", label: "Approved" } : a.status === "sample" ? { tone: "sample", label: "Sample" } : a.status === "drawing" ? { tone: "neutral", label: "Drawing" } : a.status === "missing" ? { tone: "warn", label: "No image" } : { tone: "warn", label: "Proposed" };

  return (
    <article className="fl-asset" data-kind={a.kind} data-selected={selected || undefined}>
      <button type="button" className="fl-asset-hit" onClick={() => setFocus({ kind: "asset", id: a.id, label: a.name })} aria-pressed={selected} aria-label={`Select ${a.name}`}>
        <Photo media={a.primary?.media} aspect="4 / 5" alt={`${a.name}`} fit="contain" working={a.status === "drawing"} label="Drawing" showProvenance={false} />
      </button>
      <div className="fl-asset-body">
        <div className="fl-asset-title">
          <h3 className="fl-h3">{a.name}</h3>
          <span className="fl-badge" data-tone={status.tone}>
            {status.label}
          </span>
        </div>
        <p className="fl-muted fl-asset-role">
          {KIND[a.kind]} · {a.role}
        </p>
        <div className="fl-gallery" role="group" aria-label={`${a.name} images`}>
          {(images.length > 1 ? images.slice(0, 5) : []).map((img, i) => (
            <button key={img.id} type="button" className="fl-thumb" data-primary={img.id === a.primary?.id || undefined} onClick={() => { setFocus({ kind: "asset", id: a.id, label: a.name }); setBox(i); }} aria-label={`${img.label ?? "Image"} ${i + 1}`} title={img.label ?? undefined}>
              {img.media ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img.media.preview} alt="" />
              ) : (
                <Spinner />
              )}
            </button>
          ))}
          {!sample ? (
            <button type="button" className="fl-thumb fl-thumb--add" onClick={() => file.current?.click()} aria-label={`Add a reference image for ${a.name}`} title="Add a reference">
              <Plus size={14} aria-hidden />
            </button>
          ) : null}
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        </div>
        {images.length ? <button type="button" className="fl-link fl-asset-gallery-link" onClick={() => { setFocus({ kind: "asset", id: a.id, label: a.name }); setBox(0); }}>View {images.length === 1 ? "image" : `all ${images.length} images`}</button> : null}
        {!sample && (a.status === "proposed" || proposal) ? (
          <div className="fl-asset-actions">
            {proposal ? (
              <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" onClick={() => { setFocus({ kind: "asset", id: a.id, label: a.name }); setBox(images.indexOf(proposal)); }}>
                New image proposed · compare
              </button>
            ) : null}
            {a.status === "proposed" && a.primary && !proposal ? (
              <button type="button" className="fl-btn fl-btn--primary fl-btn--sm" onClick={() => void op("approve_asset", { assetId: a.id, versionId: a.primary!.id })}>
                <Check size={12} aria-hidden /> Approve
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {box != null ? (
        <AssetLightbox a={a} images={images} start={box} onClose={() => setBox(null)} />
      ) : null}
    </article>
  );
}

function AssetLightbox({ a, images, start, onClose }: { a: AssetView; images: AssetImage[]; start: number; onClose: () => void }) {
  const { op, view } = useStudio();
  return (
    <Lightbox
      title={a.name}
      start={start}
      onClose={onClose}
      items={images.map((img) => ({
        media: img.media,
        label: img.id === a.primary?.id ? `${img.label ?? "Main image"} · main image` : (img.label ?? (img.role === "reference" ? "Reference" : "Proposed main image")),
        detail: img.note ?? (img.source === "upload" ? "Your file" : img.source === "derived" ? "Separated from a contact sheet" : undefined),
      }))}
      actions={(i) => {
        const img = images[i];
        if (view.project.sample || !img || img.status !== "ready") return null;
        if (img.id === a.primary?.id) {
          return a.status === "approved" ? (
            <span className="fl-badge" data-tone="ok">
              Approved main image
            </span>
          ) : (
            <button type="button" className="fl-btn fl-btn--primary fl-btn--sm" onClick={() => void op("approve_asset", { assetId: a.id, versionId: img.id }).then(onClose)}>
              <Check size={12} aria-hidden /> Approve as main image
            </button>
          );
        }
        return (
          <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" onClick={() => void op("approve_asset", { assetId: a.id, versionId: img.id }).then(onClose)}>
            <ImagePlus size={12} aria-hidden /> Use this as the main image
          </button>
        );
      }}
    />
  );
}
