import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { MEDIA_DIR } from "@/lib/db";
import { absPath, getMedia, mediaMeta } from "@/lib/media";

/** Serves stored media with byte ranges (video scrubbing) and optional previews/downloads. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const m = getMedia(id);
  if (!m) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  let file = absPath(m);
  let mime = m.mime;
  if (url.searchParams.get("v") === "preview") {
    const preview = mediaMeta<{ previewPath?: string }>(m).previewPath;
    if (preview && fs.existsSync(path.join(MEDIA_DIR, preview))) {
      file = path.join(MEDIA_DIR, preview);
      mime = "image/jpeg";
    } else if (m.kind !== "image") return new Response("No preview", { status: 404 });
  }
  if (!fs.existsSync(file)) return new Response("Missing file", { status: 410 });
  const size = fs.statSync(file).size;
  const headers: Record<string, string> = { "content-type": mime, "accept-ranges": "bytes", "cache-control": "private, max-age=31536000, immutable" };
  const download = url.searchParams.get("download");
  if (download) headers["content-disposition"] = `attachment; filename="${download.replace(/[^a-z0-9._-]+/gi, "-")}"`;
  const range = req.headers.get("range");
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || end < start) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "content-length": String(size) } });
}
