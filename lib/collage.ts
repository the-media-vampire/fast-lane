import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { db, MEDIA_DIR } from "./db";
import { FFMPEG, probeSize } from "./ffmpeg";
import { absPath, getMedia, registerMedia } from "./media";
import { addAssetVersion, getAsset, getAssetVersion, keepAssetVersion } from "./repo";

/**
 * Some early reference images came back as contact sheets: a grid of tiles separated by light
 * gutters. This finds the tiles so each can stand on its own as a separate image. It is local
 * and free, and it never invents pixels: every tile is a crop of the original.
 */

const run = promisify(execFile);

export type Tile = { x: number; y: number; w: number; h: number };

async function grey(absPath: string, w: number, h: number): Promise<Uint8Array> {
  const { stdout } = await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", absPath, "-vf", `scale=${w}:${h}:flags=area`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  return new Uint8Array(stdout as unknown as Buffer);
}

/** Runs of indexes where `isGutter` holds, merged across one-pixel breaks. */
function runs(n: number, isGutter: (i: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const g = i < n && isGutter(i);
    if (g && start < 0) start = i;
    if (!g && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

/** Split [0, n) at gutter runs into the spans between them. */
function spans(n: number, gutters: [number, number][], min: number): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, b] of gutters) {
    if (a - at >= min) out.push([at, a - 1]);
    at = b + 1;
  }
  if (n - at >= min) out.push([at, n - 1]);
  return out;
}

/**
 * The tiles of a contact sheet, in full-resolution pixels, largest first. Returns [] for an
 * ordinary single photograph. Gutters are thin light or near-black lines that cross the whole
 * sheet (or the whole band they divide); a plain background never counts because gutters must be thin.
 */
export async function findTiles(absPath: string): Promise<{ width: number; height: number; tiles: Tile[] }> {
  const size = await probeSize(absPath);
  if (!size) return { width: 0, height: 0, tiles: [] };
  const sw = Math.min(3000, size.width);
  const sh = Math.max(1, Math.round((size.height / size.width) * sw));
  const px = await grey(absPath, sw, sh);
  // A gutter is a thin line that is almost entirely very light, or almost entirely near-black.
  // (Mid-grey lines are not trusted: plain walls in grey renders and storyboards look the same.)
  const light = (x: number, y: number) => px[y * sw + x] >= 196;
  const dark = (x: number, y: number) => px[y * sw + x] <= 14;
  const rowLight = (y: number, x0 = 0, x1 = sw - 1) => {
    let l = 0;
    let d = 0;
    for (let x = x0; x <= x1; x++) {
      if (light(x, y)) l++;
      else if (dark(x, y)) d++;
    }
    const n = x1 - x0 + 1;
    return l / n > 0.96 || d / n > 0.985;
  };
  const colLight = (x: number, y0: number, y1: number) => {
    let l = 0;
    let d = 0;
    for (let y = y0; y <= y1; y++) {
      if (light(x, y)) l++;
      else if (dark(x, y)) d++;
    }
    const n = y1 - y0 + 1;
    return l / n > 0.96 || d / n > 0.985;
  };
  const thin = (n: number) => (r: [number, number]) => r[1] - r[0] + 1 <= Math.max(4, Math.round(n * 0.02)) || r[0] === 0 || r[1] === n - 1;
  const minSide = Math.round(Math.min(sw, sh) * 0.12);
  const bands = spans(sh, runs(sh, (y) => rowLight(y)).filter(thin(sh)), minSide);
  const tiles: Tile[] = [];
  for (const [y0, y1] of bands) {
    const cols = spans(sw, runs(sw, (x) => colLight(x, y0, y1)).filter(thin(sw)), minSide);
    for (const [x0, x1] of cols) {
      // A band can hold a column of stacked tiles: split each cell by its own rows.
      const h = y1 - y0 + 1;
      const sub = spans(h, runs(h, (dy) => rowLight(y0 + dy, x0, x1)).filter(thin(h)), minSide).map(([a, b]) => [y0 + a, y0 + b] as [number, number]);
      for (const [ya, yb] of sub.length ? sub : [[y0, y1] as [number, number]]) tiles.push({ x: x0, y: ya, w: x1 - x0 + 1, h: yb - ya + 1 });
    }
  }
  if (tiles.length < 2) return { width: size.width, height: size.height, tiles: [] };
  const k = size.width / sw;
  const full = tiles
    .map((t) => ({ x: Math.round(t.x * k) + 1, y: Math.round(t.y * k) + 1, w: Math.round(t.w * k) - 2, h: Math.round(t.h * k) - 2 }))
    .map((t) => ({ ...t, w: Math.min(t.w, size.width - t.x), h: Math.min(t.h, size.height - t.y) }))
    .filter((t) => t.w > 64 && t.h > 64)
    .sort((a, b) => b.w * b.h - a.w * a.h);
  return { width: size.width, height: size.height, tiles: full };
}

export async function cropTile(absIn: string, tile: Tile, absOut: string) {
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", absIn, "-vf", `crop=${tile.w}:${tile.h}:${tile.x}:${tile.y}`, "-frames:v", "1", absOut], { timeout: 60_000 });
}

/* ---------------- separating an asset's contact sheet ---------------- */


/**
 * Turn one contact-sheet version into separate images: the first tile (where sheets put the
 * hero view) becomes the proposed main image, the rest go to the gallery. The sheet itself is
 * kept, out of sight. Free and local. Approval stays with the person.
 */
export async function separateSheet(projectId: string, assetId: string, versionId: string): Promise<{ tiles: number; primaryId: string | null }> {
  const a = getAsset(assetId);
  const v = getAssetVersion(versionId);
  const m = getMedia(v?.media_id);
  if (!a || !v || !m || a.project_id !== projectId) return { tiles: 0, primaryId: null };
  const { tiles } = await findTiles(absPath(m));
  if (tiles.length < 2) return { tiles: 0, primaryId: null };
  // Sheets lead with the hero portrait (top-left) for people; for places and objects the
  // largest view is the main one. The rest follow in reading order.
  const reading = [...tiles].sort((p, q) => (Math.abs(p.y - q.y) < 40 ? p.x - q.x : p.y - q.y));
  const hero = a.kind === "character" ? reading[0] : [...tiles].sort((p, q) => q.w * q.h - p.w * p.h || reading.indexOf(p) - reading.indexOf(q))[0];
  const ordered = [hero, ...reading.filter((t) => t !== hero)];
  const labels = a.kind === "character" ? ["Main view", "View 2", "View 3", "View 4", "View 5", "View 6", "View 7", "View 8", "View 9"] : ["Main view", "Detail 2", "Detail 3", "Detail 4", "Detail 5", "Detail 6", "Detail 7", "Detail 8", "Detail 9"];
  const { attachPreview } = await import("./worker");
  let primaryId: string | null = null;
  for (let i = 0; i < ordered.length && i < 9; i++) {
    const rel = path.join(projectId, `tile-${versionId}-${i + 1}.png`);
    await cropTile(absPath(m), ordered[i], path.join(MEDIA_DIR, rel));
    const row = registerMedia({ projectId, relPath: rel, mime: "image/png", provenance: m.provenance, width: ordered[i].w, height: ordered[i].h, meta: { fromSheet: m.id, tile: ordered[i] } });
    await attachPreview(row);
    const id = addAssetVersion({ assetId, projectId, mediaId: row.id, source: "derived", status: "ready", role: i === 0 ? "primary" : "reference", label: labels[i], note: i === 0 ? "Separated from a contact sheet" : null });
    if (i === 0) primaryId = id;
  }
  db().prepare("update asset_versions set role = 'sheet' where id = ?").run(versionId);
  // An approved identity is never moved silently: its first view waits as a proposal. An
  // unapproved sheet is replaced by its own first view (the same person, place or object).
  if (a.approved_version_id === versionId) db().prepare("update assets set kept_version_id = ? where id = ?").run(versionId, assetId);
  else if (primaryId && (a.kept_version_id === versionId || !a.kept_version_id)) keepAssetVersion(assetId, primaryId);
  return { tiles: ordered.length, primaryId };
}
