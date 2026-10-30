import { runOp } from "@/lib/ops";
import { getProject } from "@/lib/repo";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!getProject(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json()) as { op?: string; input?: unknown };
  if (!body.op) return Response.json({ error: "Missing op" }, { status: 400 });
  const result = await runOp(id, body.op, body.input ?? {}, "user");
  return Response.json(result, { status: result.ok ? 200 : 422 });
}
