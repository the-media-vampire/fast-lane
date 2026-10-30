import { sampleCamera } from "@/lib/blocking/sample";
import { getProject, latestScene } from "@/lib/repo";
import { shotsDoc } from "@/lib/state";

/**
 * One shot's current blocking as a portable document, for a downstream 3D package such as
 * Blender: the scene (set, cast, props, camera keys), the shot's timing, and the camera
 * sampled at 24 fps. Units are metres and seconds, right-handed and Y up; lens is focal
 * length in mm on a 36 × 24 mm full-frame gate (see lib/blocking/types.ts).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; shotId: string }> }) {
  const { id, shotId } = await ctx.params;
  const p = getProject(id);
  const shot = shotsDoc(id)?.data.shots.find((s) => s.id === shotId);
  const scene = latestScene(id, shotId);
  if (!p || !shot || !scene) return Response.json({ error: "Not found" }, { status: 404 });
  const fps = 24;
  const frames = Math.round(scene.data.duration * fps);
  const camera = Array.from({ length: frames + 1 }, (_, i) => {
    const c = sampleCamera(scene.data, i / fps);
    return { t: i / fps, position: c.pos, target: c.target, lensMm: c.lens };
  });
  const body = {
    source: "Fast Lane",
    units: { length: "m", time: "s", up: "+y", handedness: "right", sensor: "36x24mm" },
    project: { id: p.id, title: p.title, aspect: p.aspect },
    shot: { id: shot.id, title: shot.title, durationS: shot.duration, framing: shot.framing, move: shot.move, lensMm: shot.lens, blockingRev: scene.rev },
    scene: scene.data,
    camera: { fps, samples: camera },
  };
  const name = `${p.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${shot.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-blocking-v${scene.rev}.json`;
  return new Response(JSON.stringify(body, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${name}"` } });
}
