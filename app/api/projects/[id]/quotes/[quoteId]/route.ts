import { approveQuote, declineQuote } from "@/lib/ops";
import { getProject } from "@/lib/repo";

/**
 * The person's answer to an estimate. This endpoint is the only way a quote is accepted: the
 * agent has no tool that reaches it. Approval is single use and re-checks the price first.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; quoteId: string }> }) {
  const { id, quoteId } = await ctx.params;
  if (!getProject(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action === "decline") return Response.json(declineQuote(id, quoteId));
  if (body.action !== "approve") return Response.json({ error: "Say approve or decline." }, { status: 400 });
  const result = await approveQuote(id, quoteId);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
