import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Studio } from "@/components/studio/Studio";
import { buildView } from "@/lib/view";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = buildView(id);
  if (!view) notFound();
  return (
    <Suspense>
      <Studio projectId={id} initial={view} />
    </Suspense>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = buildView(id);
  return { title: view ? `${view.project.title === "Untitled" ? "A new film" : view.project.title} · Fast Lane` : "Fast Lane" };
}
