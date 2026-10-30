import { adoptUploads, attachUpload, storeUpload } from "@/lib/create";
import { assetData, getAsset, getProject, writeDoc } from "@/lib/repo";
import { briefDoc } from "@/lib/state";
import { AssetKind } from "@/lib/types";

/**
 * Bring your own: a photo for an asset (a new main image, or one more gallery reference), a new
 * asset, or footage. Uploading is free and never buys anything.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = getProject(id);
  if (!p) return Response.json({ error: "Not found" }, { status: 404 });
  const form = await req.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return Response.json({ error: "No file." }, { status: 400 });
  if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) return Response.json({ error: "Images (JPEG, PNG, WebP) or video clips (MP4, MOV) only." }, { status: 400 });
  const limit = file.type.startsWith("video/") ? 200 : 20;
  if (file.size > limit * 1024 * 1024) return Response.json({ error: `That file is larger than ${limit} MB.` }, { status: 400 });
  const m = await storeUpload(id, { name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
  if (!m) return Response.json({ error: "That file type isn't supported." }, { status: 400 });

  const brief = briefDoc(id);
  if (m.kind === "video") {
    if (brief) writeDoc(id, "brief", { ...brief.data, uploads: [...brief.data.uploads, { mediaId: m.id, label: file.name, use: "footage" }] }, { author: "user", note: "Added footage", inputs: { brief: brief.version } });
    return Response.json({ ok: true, mediaId: m.id, summary: `Added ${file.name}. Ask Astra to use it for a shot.` });
  }

  const assetId = String(form.get("assetId") ?? "");
  if (assetId) {
    const a = getAsset(assetId);
    if (!a || a.project_id !== id) return Response.json({ error: "Unknown asset." }, { status: 404 });
    const role = form.get("role") === "primary" ? "primary" : "reference";
    const r = attachUpload(id, m.id, a.kind, a.name, assetData(a), a.id, { role, label: String(form.get("label") ?? "") || (role === "primary" ? "Your photo" : "Your reference") });
    return Response.json({ ok: true, ...r, summary: role === "primary" ? `Your photo is now ${a.name}'s approved main image. Shots drawn with the old one are marked outdated.` : `Added to ${a.name}'s gallery.` });
  }
  const kind = AssetKind.safeParse(String(form.get("kind") ?? ""));
  const name = String(form.get("name") ?? "").trim();
  if (kind.success && name) {
    const r = attachUpload(id, m.id, kind.data, name, { description: String(form.get("description") ?? "Supplied by you"), look: "As in the supplied photo", role: "Supplied by you" });
    return Response.json({ ok: true, ...r, summary: `Added ${name}.` });
  }
  if (brief) writeDoc(id, "brief", { ...brief.data, uploads: [...brief.data.uploads, { mediaId: m.id, label: file.name, use: "reference" }] }, { author: "user", note: "Added a reference", inputs: { brief: brief.version } });
  await adoptUploads(id, brief?.data.idea ?? "", [m.id]);
  return Response.json({ ok: true, summary: "Added your image." });
}
