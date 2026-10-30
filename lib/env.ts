import fs from "node:fs";

/**
 * Credentials come from the environment or from this project's own .env.local (copy
 * .env.example). Next.js loads .env.local for the server; scripts run outside Next read the
 * same file here. Values are never logged, and no key is ever committed.
 */

const ROOT = process.env.FASTLANE_ROOT || process.cwd();

function parseEnvFile(file: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

let cache: Record<string, string> | null = null;

function sources() {
  cache ??= parseEnvFile(`${ROOT}/.env.local`);
  return cache;
}

export function secret(name: "ANTHROPIC_API_KEY" | "KIE_API_KEY" | "BLOB_READ_WRITE_TOKEN" | "ELEVENLABS_API_KEY"): string {
  return process.env[name] || sources()[name] || "";
}

export function hasSecret(name: Parameters<typeof secret>[0]): boolean {
  return secret(name).length > 0;
}

/** Live generation can be switched off entirely (demo rehearsals, CI). */
export function liveEnabled(): boolean {
  return process.env.FASTLANE_LIVE !== "off";
}

export const VIDEO_RESOLUTION = (process.env.FASTLANE_VIDEO_RESOLUTION as "480p" | "720p" | "1080p" | undefined) ?? "480p";
