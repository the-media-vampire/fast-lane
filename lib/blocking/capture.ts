import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";

/**
 * Server-side captures of blocking scenes: a headless Chromium (Playwright's cached build)
 * opens /capture and screenshots exactly what the Direct stage draws. This is the
 * renderer that stands in for a Blender worker on this machine: same scene document, same
 * sampler, same three.js scene, so the grey storyboard frames match the live preview.
 * Browser closure on the user's side does not matter — this runs in the server process.
 */

export type CaptureShot = { t: number; view: "camera" | "overhead" };
export type CaptureResult = { view: "camera" | "overhead"; t: number; png: Buffer };

type G = typeof globalThis & { __fastLaneCaptureBrowser?: Promise<Browser> };

function baseUrl(): string {
  return (process.env.FASTLANE_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
}

/**
 * The Chromium to drive. FASTLANE_CHROMIUM_PATH wins; otherwise the newest Playwright
 * build already in the local cache (headless shell first), so nothing is downloaded and
 * a cache filled by a newer Playwright still works. Undefined lets Playwright choose.
 */
function chromiumPath(): string | undefined {
  if (process.env.FASTLANE_CHROMIUM_PATH) return process.env.FASTLANE_CHROMIUM_PATH;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(/*turbopackIgnore: true*/ cache);
  } catch {
    return undefined;
  }
  const newest = (prefix: string) =>
    dirs
      .filter((d) => d.startsWith(prefix))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  const candidates = [
    ...newest("chromium_headless_shell-").flatMap((d) => [
      path.join(cache, d, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
      path.join(cache, d, "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
      path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    ]),
    ...newest("chromium-").flatMap((d) => [
      path.join(cache, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      path.join(cache, d, "chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      path.join(cache, d, "chrome-linux64", "chrome"),
    ]),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

async function browser(): Promise<Browser> {
  const g = globalThis as G;
  if (!g.__fastLaneCaptureBrowser) {
    g.__fastLaneCaptureBrowser = chromium
      .launch({
        headless: true,
        executablePath: chromiumPath(),
        // Software WebGL: the capture must not depend on a GPU being present.
        args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
      })
      .then((b) => {
        b.on("disconnected", () => {
          g.__fastLaneCaptureBrowser = undefined;
        });
        return b;
      })
      .catch((err) => {
        g.__fastLaneCaptureBrowser = undefined;
        throw err;
      });
  }
  return g.__fastLaneCaptureBrowser;
}

export async function captureScene(input: { sceneRowId: string; shots: CaptureShot[]; width: number; height: number; timeoutMs?: number }): Promise<CaptureResult[]> {
  const b = await browser();
  const context = await b.newContext({ viewport: { width: input.width, height: input.height }, deviceScaleFactor: 1 });
  const out: CaptureResult[] = [];
  try {
    const page = await context.newPage();
    for (const shot of input.shots) {
      const url = `${baseUrl()}/capture?scene=${encodeURIComponent(input.sceneRowId)}&t=${shot.t}&view=${shot.view}&w=${input.width}&h=${input.height}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs ?? 45_000 });
      await page.waitForFunction(() => window.__captureReady === true || typeof window.__captureError === "string", null, { timeout: input.timeoutMs ?? 45_000 });
      const error = await page.evaluate(() => window.__captureError ?? null);
      if (error) throw new Error(`capture of scene ${input.sceneRowId} failed: ${error}`);
      const root = await page.$("#capture-root");
      if (!root) throw new Error("capture page did not render its root");
      out.push({ view: shot.view, t: shot.t, png: await root.screenshot({ type: "png" }) });
    }
  } finally {
    await context.close();
  }
  return out;
}

/** Close the shared browser (tests and shutdown). */
export async function closeCaptureBrowser(): Promise<void> {
  const g = globalThis as G;
  const pending = g.__fastLaneCaptureBrowser;
  g.__fastLaneCaptureBrowser = undefined;
  if (pending) await (await pending).close().catch(() => undefined);
}

declare global {
  interface Window {
    __captureReady?: boolean;
    __captureError?: string;
  }
}
