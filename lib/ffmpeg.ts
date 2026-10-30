import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/** Small local media chores (previews, sizes). Heavy work goes through the media adapter (lib/adapters/media.ts). */

const run = promisify(execFile);

function first(paths: (string | undefined)[]): string {
  for (const p of paths) if (p && fs.existsSync(p)) return p;
  return "ffmpeg";
}

export const FFMPEG = first([process.env.FFMPEG_BIN, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]);
export const FFPROBE = first([process.env.FFPROBE_BIN, "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"]);

/** A ≤`width` px JPEG for the studio UI. Returns false if ffmpeg could not read the input. */
export async function makePreview(absIn: string, absOut: string, width = 960): Promise<boolean> {
  try {
    await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", absIn, "-vf", `scale='min(${width},iw)':-2`, "-frames:v", "1", "-q:v", "4", absOut], { timeout: 60_000 });
    return fs.existsSync(absOut);
  } catch {
    return false;
  }
}

export async function probeSize(absPath: string): Promise<{ width: number; height: number; duration: number | null } | null> {
  try {
    const { stdout } = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", absPath], { timeout: 30_000 });
    const j = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
    const s = j.streams?.[0];
    if (!s?.width || !s?.height) return null;
    const d = Number(j.format?.duration);
    return { width: s.width, height: s.height, duration: Number.isFinite(d) ? d : null };
  } catch {
    return null;
  }
}

/** A plain black still at the frame size, used for an empty slot in a cut. */
export async function blackStill(absOut: string, width: number, height: number): Promise<string> {
  if (fs.existsSync(absOut)) return absOut;
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x0d0e0f:s=${width}x${height}`, "-frames:v", "1", absOut], { timeout: 30_000 });
  return absOut;
}

/** JPEG bytes of an image scaled to `width`, for sending to the vision reviewer. */
export async function jpegFor(absIn: string, width = 768): Promise<Buffer | null> {
  const tmp = path.join(path.dirname(absIn), `.review-${path.basename(absIn)}-${width}.jpg`);
  const ok = await makePreview(absIn, tmp, width);
  if (!ok) return null;
  const bytes = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return bytes;
}
