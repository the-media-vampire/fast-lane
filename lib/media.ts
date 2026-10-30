import fs from "node:fs";
import path from "node:path";
import { db, id, now, json, MEDIA_DIR } from "./db";

export type Provenance = "sample" | "live" | "upload" | "blocking" | "assembled";
export type MediaKind = "image" | "video" | "audio";

export type MediaRow = {
  id: string;
  project_id: string;
  kind: MediaKind;
  path: string;
  mime: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  provenance: Provenance;
  public_url: string | null;
  public_expires_at: string | null;
  meta: string;
  created_at: string;
};

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
};

export function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4" }[ext] ??
    "application/octet-stream"
  );
}

export function kindFromMime(mime: string): MediaKind {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "image";
}

export function absPath(row: Pick<MediaRow, "path">): string {
  return path.join(MEDIA_DIR, row.path);
}

/** Store bytes under data/media/<project>/ and register them. */
export function saveMedia(input: {
  projectId: string;
  bytes: Buffer | Uint8Array;
  mime: string;
  provenance: Provenance;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  meta?: Record<string, unknown>;
  name?: string;
}): MediaRow {
  const mediaId = id("med");
  const ext = EXT[input.mime] ?? "bin";
  // Runtime data paths, not source: keep them out of the build's file tracing.
  const rel = path.join(/*turbopackIgnore: true*/ input.projectId, `${input.name ? `${input.name}-` : ""}${mediaId}.${ext}`);
  fs.mkdirSync(path.join(/*turbopackIgnore: true*/ MEDIA_DIR, input.projectId), { recursive: true });
  fs.writeFileSync(path.join(/*turbopackIgnore: true*/ MEDIA_DIR, rel), input.bytes);
  const row: MediaRow = {
    id: mediaId,
    project_id: input.projectId,
    kind: kindFromMime(input.mime),
    path: rel,
    mime: input.mime,
    width: input.width ?? null,
    height: input.height ?? null,
    duration: input.duration ?? null,
    provenance: input.provenance,
    public_url: null,
    public_expires_at: null,
    meta: JSON.stringify(input.meta ?? {}),
    created_at: now(),
  };
  db()
    .prepare(
      `insert into media (id, project_id, kind, path, mime, width, height, duration, provenance, public_url, public_expires_at, meta, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.project_id, row.kind, row.path, row.mime, row.width, row.height, row.duration, row.provenance, null, null, row.meta, row.created_at);
  return row;
}

/** Register a file that already exists inside MEDIA_DIR (e.g. ffmpeg output written in place). */
export function registerMedia(input: Omit<Parameters<typeof saveMedia>[0], "bytes"> & { relPath: string }): MediaRow {
  const mediaId = id("med");
  const row: MediaRow = {
    id: mediaId,
    project_id: input.projectId,
    kind: kindFromMime(input.mime),
    path: input.relPath,
    mime: input.mime,
    width: input.width ?? null,
    height: input.height ?? null,
    duration: input.duration ?? null,
    provenance: input.provenance,
    public_url: null,
    public_expires_at: null,
    meta: JSON.stringify(input.meta ?? {}),
    created_at: now(),
  };
  db()
    .prepare(
      `insert into media (id, project_id, kind, path, mime, width, height, duration, provenance, public_url, public_expires_at, meta, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.project_id, row.kind, row.path, row.mime, row.width, row.height, row.duration, row.provenance, null, null, row.meta, row.created_at);
  return row;
}

export function getMedia(mediaId: string | null | undefined): MediaRow | null {
  if (!mediaId) return null;
  return (db().prepare("select * from media where id = ?").get(mediaId) as MediaRow | undefined) ?? null;
}

export function mediaUrl(mediaId: string | null | undefined): string | null {
  return mediaId ? `/api/media/${mediaId}` : null;
}

export function mediaMeta<T extends Record<string, unknown>>(row: MediaRow): T {
  return json<T>(row.meta, {} as T);
}

export function setPublicUrl(mediaId: string, url: string, expiresAt: string | null) {
  db().prepare("update media set public_url = ?, public_expires_at = ? where id = ?").run(url, expiresAt, mediaId);
}

/** Download a provider result into the media store (provider URLs expire). */
export async function downloadToMedia(input: {
  projectId: string;
  url: string;
  provenance: Provenance;
  name?: string;
  fallbackMime?: string;
  meta?: Record<string, unknown>;
}): Promise<MediaRow> {
  const res = await fetch(input.url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`download failed ${res.status} for ${input.url.slice(0, 80)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  let mime = res.headers.get("content-type")?.split(";")[0]?.trim() || input.fallbackMime || mimeFromName(input.url);
  if (mime === "application/octet-stream" || mime === "binary/octet-stream") mime = input.fallbackMime ?? mimeFromName(input.url);
  return saveMedia({ projectId: input.projectId, bytes, mime, provenance: input.provenance, name: input.name, meta: { ...input.meta, sourceUrl: input.url } });
}
