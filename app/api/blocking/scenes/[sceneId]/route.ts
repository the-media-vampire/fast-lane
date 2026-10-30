import { db, json } from "@/lib/db";
import type { Scene } from "@/lib/blocking/types";

/** One stored blocking scene revision, as the capture page and the views read it. */
export async function GET(_req: Request, ctx: { params: Promise<{ sceneId: string }> }) {
  const { sceneId } = await ctx.params;
  const row = db().prepare("select id, shot_id, rev, data from scenes where id = ?").get(sceneId) as
    | { id: string; shot_id: string; rev: number; data: string }
    | undefined;
  if (!row) return Response.json({ error: "No blocking scene with that id." }, { status: 404 });
  const data = json<Scene | null>(row.data, null);
  if (!data) return Response.json({ error: "The stored scene could not be read." }, { status: 500 });
  return Response.json({ id: row.id, shot_id: row.shot_id, rev: row.rev, data }, { headers: { "cache-control": "no-store" } });
}
