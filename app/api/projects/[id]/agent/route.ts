import { runAgentTurn, type Focus } from "@/lib/agent/astra";
import { addMessage, getProject } from "@/lib/repo";
import { studioStage } from "@/lib/types";

export const maxDuration = 300;

const KINDS = new Set(["shot", "asset", "concept", "line", "moment", "cut", "beat"]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!getProject(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json()) as { text?: string; stage?: string; focus?: Partial<Focus> | null };
  const text = (body.text ?? "").trim();
  if (!text) return Response.json({ error: "Say something first." }, { status: 400 });
  const stage = studioStage(body.stage) ?? "brief";
  const f = body.focus;
  const focus: Focus | null =
    f && typeof f.label === "string" && KINDS.has(String(f.kind))
      ? { kind: f.kind as Focus["kind"], id: typeof f.id === "string" ? f.id : undefined, label: f.label.slice(0, 120), time: typeof f.time === "number" ? f.time : undefined, cutId: typeof f.cutId === "string" ? f.cutId : undefined }
      : null;
  try {
    const turn = await runAgentTurn(id, text.slice(0, 4000), { stage, focus });
    return Response.json(turn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addMessage(id, "system", { text: `Astra couldn't answer just now (${message.slice(0, 160)}). Your message is saved; try again in a moment.` });
    return Response.json({ error: message }, { status: 502 });
  }
}
