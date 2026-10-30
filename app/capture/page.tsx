"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Scene } from "@/lib/blocking/types";
import { CameraView } from "@/components/blocking/CameraView";
import { OverheadView } from "@/components/blocking/OverheadView";

/**
 * Headless capture target (lib/blocking/capture.ts drives it). Renders one view of one
 * stored scene revision at one instant, at exact pixels, and raises window.__captureReady
 * once the frame has drawn. The same components the Direct stage shows, so a capture is
 * the preview, not a re-interpretation of it.
 */

declare global {
  interface Window {
    __captureReady?: boolean;
    __captureError?: string;
  }
}

function Capture() {
  const params = useSearchParams();
  const sceneId = params.get("scene") ?? "";
  const t = Number(params.get("t") ?? "0") || 0;
  const view = params.get("view") === "overhead" ? "overhead" : "camera";
  const w = Math.max(64, Math.min(4096, Number(params.get("w") ?? "1280") || 1280));
  const h = Math.max(64, Math.min(4096, Number(params.get("h") ?? "720") || 720));
  const [scene, setScene] = useState<Scene | null>(null);

  useEffect(() => {
    window.__captureReady = false;
    window.__captureError = undefined;
    if (!sceneId) {
      window.__captureError = "missing ?scene";
      return;
    }
    fetch(`/api/blocking/scenes/${encodeURIComponent(sceneId)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setScene(body.data as Scene);
      })
      .catch((err: unknown) => {
        window.__captureError = err instanceof Error ? err.message : String(err);
      });
  }, [sceneId]);

  const ready = useCallback(() => {
    const done = () => {
      window.__captureReady = true;
    };
    if (document.fonts?.ready) document.fonts.ready.then(done, done);
    else done();
  }, []);

  return (
    <div id="capture-root" className="bl-capture-root" style={{ width: w, height: h }}>
      {scene && (view === "camera" ? <CameraView scene={scene} t={t} capture onReady={ready} /> : <OverheadView scene={scene} t={t} onReady={ready} />)}
    </div>
  );
}

export default function CapturePage() {
  return (
    <Suspense fallback={null}>
      <Capture />
    </Suspense>
  );
}
