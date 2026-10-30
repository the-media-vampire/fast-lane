import Link from "next/link";
import { Opening } from "@/components/home/Opening";
import { ensureSample } from "@/lib/create";
import { liveEnabled } from "@/lib/env";
import { listView } from "@/lib/view";

export const dynamic = "force-dynamic";

export default async function Home() {
  await ensureSample();
  const projects = listView();
  const own = projects.filter((p) => !p.sample);
  const sample = projects.find((p) => p.sample);
  return (
    <div className="fl-app fl-app--home">
      <header className="fl-header">
        <Link href="/" className="fl-brand">
          Fast Lane <small>FAST LANE</small>
        </Link>
        <span className="fl-caption">Commercials and short stories · 30 seconds to 2 minutes</span>
      </header>
      <section className="fl-intro" aria-label="Start a film">
        <Opening live={liveEnabled()} />
        <div className="fl-hero-stack" aria-hidden>
          <div className="fl-photo fl-hero-a" style={{ backgroundImage: "url(/sample/frame-1.svg)" }} />
          <div className="fl-photo fl-hero-b" style={{ backgroundImage: "url(/sample/frame-4.svg)" }} />
          <div className="fl-hero-note">Sample frames</div>
        </div>
      </section>
      <section className="fl-work" aria-label="Your work">
        <h2 className="fl-group-title">Your work</h2>
        <div className="fl-projects">
          {own.map((p) => (
            <Link key={p.id} href={`/p/${p.id}`} className="fl-project">
              <span className="fl-photo" style={{ aspectRatio: "16 / 9", backgroundImage: p.cover ? `url(${p.cover.preview})` : undefined }} data-empty={!p.cover || undefined} />
              <span className="fl-project-title">{p.title === "Untitled" ? "A new film" : p.title}</span>
              <span className="fl-muted fl-small">
                {p.kind === "commercial" ? "Commercial" : "Story"} · {p.duration} s · {p.aspect}
                {p.state ? ` · ${p.state}` : ""}
              </span>
            </Link>
          ))}
          {sample ? (
            <Link href={`/p/${sample.id}?stage=shots`} className="fl-project" data-sample>
              <span className="fl-photo" style={{ aspectRatio: "16 / 9", backgroundImage: "url(/sample/frame-3.svg)" }} />
              <span className="fl-project-title">
                {sample.title} <span className="fl-badge" data-tone="sample">Sample</span>
              </span>
              <span className="fl-muted fl-small">Illustrative frames · live 3D blocking · recorded replies</span>
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  );
}
