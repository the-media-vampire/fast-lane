"use client";

import type { ShotView } from "@/lib/view-types";
import { sceneTime } from "@/lib/animatic";
import { describeForPrompt } from "@/lib/blocking/describe";
import { CameraView } from "./CameraView";
import { OverheadView } from "./OverheadView";
import "./blocking.css";

export const DIRECT_VIEWS = ["storyboard", "camera", "overhead"] as const;
export type DirectViewKind = (typeof DIRECT_VIEWS)[number];

/** Three optional views of the same shot. The parent owns the film's single clock. */
export function DirectStage({ shot, time, views, aspect }: { shot: ShotView; time: number; views: DirectViewKind[]; aspect: string }) {
  const scene = shot.scene?.data;
  const t = scene ? sceneTime(time, shot.duration, scene.duration) : 0;
  const prompt = scene ? describeForPrompt(scene) : null;
  const frame = shot.storyboard?.media ?? shot.capture?.media;

  return (
    <div className="bl-views" data-aspect={aspect} data-views={views.join(" ")} data-count={views.length} data-shot={shot.number} data-shot-time={time.toFixed(2)} data-scene-time={t.toFixed(2)} role="group" aria-label={`Shot ${shot.number} synchronized views`}>
      {views.includes("storyboard") ? (
        <figure className="bl-frame bl-frame--storyboard" aria-label="Storyboard view">
          <figcaption className="bl-label"><span>Storyboard</span><span>{shot.storyboard && !shot.storyboard.current ? "Outdated" : !shot.storyboard?.media && frame ? "Blocking still" : `Shot ${shot.number}`}</span></figcaption>
          <div className="bl-storyboard-slot">
            {frame ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={frame.id} src={frame.url} alt={`Shot ${shot.number}: ${shot.summaryText}`} />
            ) : <span className="bl-placeholder">No storyboard yet</span>}
          </div>
        </figure>
      ) : null}
      {views.includes("camera") ? (
        <figure className="bl-frame bl-frame--camera" aria-label="Camera blocking view">
          <figcaption className="bl-label"><span>Camera</span><span>{shot.movement}</span></figcaption>
          <div className="bl-camera-slot">
            {scene ? <CameraView scene={scene} t={t} label={`${prompt?.camera}. ${prompt?.staging}`} /> : <span className="bl-placeholder">No blocking yet</span>}
          </div>
        </figure>
      ) : null}
      {views.includes("overhead") ? (
        <figure className="bl-frame bl-frame--overhead" aria-label="Overhead view">
          <figcaption className="bl-label"><span>Overhead</span><span>{scene?.set.label}</span></figcaption>
          <div className="bl-overhead-slot">
            {scene ? <OverheadView scene={scene} t={t} /> : <span className="bl-placeholder">No blocking yet</span>}
          </div>
        </figure>
      ) : null}
    </div>
  );
}
