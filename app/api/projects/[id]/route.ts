import { buildView } from "@/lib/view";
import { deleteProject, getProject } from "@/lib/repo";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const since = new URL(req.url).searchParams.get("rev");
  const p = getProject(id);
  if (!p) return Response.json({ error: "Not found" }, { status: 404 });
  // The studio polls with its last revision; nothing changed means nothing to send.
  if (since && Number(since) === p.rev) return new Response(null, { status: 204 });
  return Response.json(buildView(id));
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = getProject(id);
  if (!p) return Response.json({ error: "Not found" }, { status: 404 });
  deleteProject(id);
  return Response.json({ ok: true });
}
