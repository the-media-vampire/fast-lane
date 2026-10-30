"use client";

import { useEffect, useMemo } from "react";
import type { Feature, Scene } from "@/lib/blocking/types";
import { PROP_DIMS, sampleSceneAt, scenePaths } from "@/lib/blocking/sample";
import { featureNormal, footprint, isWallFeature, setBounds } from "@/lib/blocking/sets";
import { facingDir } from "@/lib/blocking/vec";
import "./blocking.css";

/**
 * The top-down plan of the same scene at the same instant. Every position here comes from
 * sampleSceneAt / scenePaths — the sampler the camera view uses — so the plan cannot drift
 * from the camera. SVG in world metres: x right, +z down (the back wall at the top).
 */

type Props = { scene: Scene; t: number; className?: string; onReady?: () => void };

const COL = {
  bg: "#1c1f21",
  floor: "#262a2b",
  grid: "#353a3b",
  wall: "#8f9793",
  open: "#4a5051",
  feature: "#3d4344",
  featureStroke: "#6b7370",
  counter: "#4b5253",
  window: "#c4cec4",
  door: "#7a827e",
  label: "#a9b2ad",
  actor: "#c0c7bf",
  name: "#e5e6e0",
  prop: "#e0d6bc",
  accent: "#d7c29d", // the champagne accent token (--accent)
} as const;

const LABELLED = new Set(["window", "door", "counter", "table", "desk", "sofa", "bed", "shelf"]);

function points(pts: { x: number; z: number }[]): string {
  return pts.map((p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`).join(" ");
}

export function OverheadView({ scene, t, className, onReady }: Props) {
  const sample = useMemo(() => sampleSceneAt(scene, t), [scene, t]);
  const paths = useMemo(() => scenePaths(scene), [scene]);
  const b = setBounds(scene.set);

  // Extent: the set plus every camera and figure position over the shot, padded, then
  // grown to fit the wall labels that sit in the margin outside the room.
  const { extent, k } = useMemo(() => {
    const xs = [b.minX, b.maxX, ...paths.camera.map((p) => p.x)];
    const zs = [b.minZ, b.maxZ, ...paths.camera.map((p) => p.z)];
    for (const a of paths.actors) for (const p of a.points) {
      xs.push(p.x);
      zs.push(p.z);
    }
    const pad = 0.9;
    const e = { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
    const scale = Math.max(e.maxX - e.minX, e.maxZ - e.minZ) / 12;
    for (const f of scene.set.features) {
      if (!isWallFeature(f)) continue;
      const { x, z } = wallLabelPosition(scene, f, scale);
      const half = f.label.length * 0.22 * scale * 0.3 + 0.1 * scale;
      e.minX = Math.min(e.minX, x - half);
      e.maxX = Math.max(e.maxX, x + half);
      e.minZ = Math.min(e.minZ, z - 0.3 * scale);
    }
    return { extent: e, k: scale };
  }, [b.minX, b.maxX, b.minZ, b.maxZ, paths, scene]);
  const W = extent.maxX - extent.minX;
  const H = extent.maxZ - extent.minZ;

  useEffect(() => {
    if (!onReady) return;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => onReady());
    });
    return () => cancelAnimationFrame(raf);
  }, [onReady, scene, t]);

  const cam = sample.camera;
  const coneLen = Math.min(Math.max(2.5, Math.hypot(cam.target.x - cam.pos.x, cam.target.z - cam.pos.z) * 1.25), Math.max(W, H) * 0.7);
  const left = facingDir(cam.yaw + cam.fovH / 2);
  const right = facingDir(cam.yaw - cam.fovH / 2);
  const cone = [
    { x: cam.pos.x, z: cam.pos.z },
    { x: cam.pos.x + left.x * coneLen, z: cam.pos.z + left.z * coneLen },
    { x: cam.pos.x + right.x * coneLen, z: cam.pos.z + right.z * coneLen },
  ];

  const label = `Top-down plan of the ${scene.set.label.toLowerCase()} at ${sample.t.toFixed(1)} seconds: ${
    sample.actors.map((a) => `${a.name} at ${a.x.toFixed(1)}, ${a.z.toFixed(1)} ${a.pose === "sit" ? "seated" : a.moving ? "walking" : "standing"}`).join("; ") || "no cast"
  }; camera at ${cam.pos.x.toFixed(1)}, ${cam.pos.z.toFixed(1)} on a ${Math.round(cam.lens)} mm lens.`;

  const gridLines: React.ReactNode[] = [];
  for (let x = Math.ceil(b.minX); x <= Math.floor(b.maxX); x++) gridLines.push(<line key={`gx${x}`} x1={x} y1={b.minZ} x2={x} y2={b.maxZ} />);
  for (let z = Math.ceil(b.minZ); z <= Math.floor(b.maxZ); z++) gridLines.push(<line key={`gz${z}`} x1={b.minX} y1={z} x2={b.maxX} y2={z} />);

  return (
    <svg
      className={`bl-overhead ${className ?? ""}`}
      viewBox={`${extent.minX} ${extent.minZ} ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
    >
      <rect x={extent.minX} y={extent.minZ} width={W} height={H} fill={COL.bg} />
      <rect x={b.minX} y={b.minZ} width={b.maxX - b.minX} height={b.maxZ - b.minZ} fill={COL.floor} />
      <g stroke={COL.grid} strokeWidth={0.012 * k} opacity={0.7}>
        {gridLines}
      </g>
      {scene.set.exterior ? (
        <rect x={b.minX} y={b.minZ} width={b.maxX - b.minX} height={b.maxZ - b.minZ} fill="none" stroke={COL.open} strokeWidth={0.03 * k} strokeDasharray={`${0.2 * k} ${0.15 * k}`} />
      ) : (
        <>
          <polyline points={points([{ x: b.minX, z: b.maxZ }, { x: b.minX, z: b.minZ }, { x: b.maxX, z: b.minZ }, { x: b.maxX, z: b.maxZ }])} fill="none" stroke={COL.wall} strokeWidth={0.1 * k} strokeLinejoin="miter" />
          <line x1={b.minX} y1={b.maxZ} x2={b.maxX} y2={b.maxZ} stroke={COL.open} strokeWidth={0.03 * k} strokeDasharray={`${0.2 * k} ${0.15 * k}`} />
        </>
      )}

      {scene.set.features.map((f) => (
        <FeatureShape key={f.id} feature={f} scene={scene} k={k} />
      ))}

      {/* Paths over the whole shot, then the state at the playhead. */}
      {paths.actors.map((a) => {
        const moves = a.points.some((p) => Math.hypot(p.x - a.points[0].x, p.z - a.points[0].z) > 0.05);
        return moves ? <polyline key={`path-${a.id}`} points={points(a.points)} fill="none" stroke={a.color} strokeOpacity={0.6} strokeWidth={0.04 * k} strokeDasharray={`${0.14 * k} ${0.1 * k}`} /> : null;
      })}
      {paths.camera.length > 1 && (
        <polyline points={points(paths.camera.map((p) => ({ x: p.x, z: p.z })))} fill="none" stroke={COL.accent} strokeOpacity={0.85} strokeWidth={0.045 * k} strokeDasharray={`${0.12 * k} ${0.1 * k}`} />
      )}
      <polygon points={points(cone)} fill={COL.accent} fillOpacity={0.12} stroke={COL.accent} strokeOpacity={0.45} strokeWidth={0.025 * k} />

      {sample.props.map((p) => {
        const label = !p.heldBy || p.size === "large";
        if (p.size === "small") {
          const s = 0.1 * Math.max(1, k * 0.8);
          return (
            <g key={p.id}>
              <polygon points={points([{ x: p.x, z: p.z - s }, { x: p.x + s, z: p.z }, { x: p.x, z: p.z + s }, { x: p.x - s, z: p.z }])} fill={COL.prop} stroke="#1c1f21" strokeWidth={0.015 * k} />
              {label && (
                <text x={p.x + s * 1.4} y={p.z + 0.09 * k} fill={COL.prop} fontSize={0.22 * k} className="bl-svg-text">
                  {p.name}
                </text>
              )}
            </g>
          );
        }
        // Medium and large props at their real footprint, turned to their yaw.
        const d = PROP_DIMS[p.size];
        return (
          <g key={p.id}>
            <rect
              x={p.x - d.length / 2}
              y={p.z - d.width / 2}
              width={d.length}
              height={d.width}
              transform={`rotate(${-p.rot} ${p.x} ${p.z})`}
              fill={COL.prop}
              fillOpacity={0.85}
              stroke="#1c1f21"
              strokeWidth={0.015 * k}
            />
            {label && (
              <text x={p.x} y={p.z + d.width / 2 + 0.28 * k} fill={COL.prop} fontSize={0.22 * k} textAnchor="middle" className="bl-svg-text">
                {p.name}
              </text>
            )}
          </g>
        );
      })}

      {sample.actors.map((a, i) => {
        const r = 0.22 * Math.max(1, k * 0.85);
        // Names go above the disc unless an earlier figure stands close, then below.
        const crowded = sample.actors.slice(0, i).some((o) => Math.abs(o.x - a.x) < 1.4 * k && Math.abs(o.z - a.z) < 0.9 * k);
        const labelZ = crowded ? a.z + r + 0.36 * k : a.z - r - 0.14 * k;
        const f = facingDir(a.facing);
        const side = { x: f.z, z: -f.x };
        const tip = { x: a.x + f.x * r * 1.9, z: a.z + f.z * r * 1.9 };
        const wedge = [
          { x: a.x + f.x * r * 0.7 + side.x * r * 0.62, z: a.z + f.z * r * 0.7 + side.z * r * 0.62 },
          tip,
          { x: a.x + f.x * r * 0.7 - side.x * r * 0.62, z: a.z + f.z * r * 0.7 - side.z * r * 0.62 },
        ];
        const state = a.pose === "sit" ? " · seated" : a.moving ? " · walking" : "";
        return (
          <g key={a.id}>
            <polygon points={points(wedge)} fill={COL.actor} />
            <circle cx={a.x} cy={a.z} r={r} fill={COL.actor} stroke={a.color} strokeWidth={0.06 * k} />
            {a.pose === "sit" && <circle cx={a.x} cy={a.z} r={r * 0.42} fill="none" stroke="#1c1f21" strokeWidth={0.03 * k} />}
            <text x={a.x} y={labelZ} fill={COL.name} fontSize={0.3 * k} textAnchor="middle" className="bl-svg-text bl-svg-name">
              {a.name}
              <tspan fill={COL.label} fontSize={0.22 * k}>
                {state}
              </tspan>
            </text>
          </g>
        );
      })}

      <CameraGlyph x={cam.pos.x} z={cam.pos.z} yaw={cam.yaw} k={k} />
      <circle cx={cam.target.x} cy={cam.target.z} r={0.05 * k} fill={COL.accent} opacity={0.8} />

      {/* Scale bar */}
      <g transform={`translate(${extent.minX + 0.35 * k} ${extent.maxZ - 0.35 * k})`}>
        <line x1={0} y1={0} x2={1} y2={0} stroke={COL.label} strokeWidth={0.03 * k} />
        <line x1={0} y1={-0.08 * k} x2={0} y2={0.08 * k} stroke={COL.label} strokeWidth={0.03 * k} />
        <line x1={1} y1={-0.08 * k} x2={1} y2={0.08 * k} stroke={COL.label} strokeWidth={0.03 * k} />
        <text x={1.15} y={0.08 * k} fill={COL.label} fontSize={0.22 * k} className="bl-svg-text">
          1 m
        </text>
      </g>
    </svg>
  );
}

function CameraGlyph({ x, z, yaw, k }: { x: number; z: number; yaw: number; k: number }) {
  const s = 0.2 * Math.max(1, k * 0.85);
  // The glyph is drawn facing +z, then turned to the camera's heading (SVG rotation is −yaw).
  return (
    <g transform={`translate(${x} ${z}) rotate(${-yaw})`}>
      <rect x={-s * 0.75} y={-s * 1.1} width={s * 1.5} height={s * 1.3} rx={s * 0.12} fill={COL.accent} />
      <polygon points={`${-s * 0.5},${s * 0.2} ${s * 0.5},${s * 0.2} ${s * 0.75},${s * 0.75} ${-s * 0.75},${s * 0.75}`} fill={COL.accent} />
    </g>
  );
}

/** Wall labels sit in the margin outside the wall, so they never cover the floor plan's figures. */
function wallLabelPosition(scene: Scene, f: Feature, k: number): { x: number; z: number } {
  const n = featureNormal(scene.set, f);
  const out = scene.set.exterior ? -0.42 : -0.36;
  return {
    x: f.x + n.x * out * k + (n.x !== 0 ? -n.x * 0.25 * k * (f.label.length / 6) : 0),
    z: f.z + n.z * out * k,
  };
}

function FeatureShape({ feature: f, scene, k }: { feature: Feature; scene: Scene; k: number }) {
  const poly = footprint(f);
  if (isWallFeature(f)) {
    const isWindow = f.kind === "window";
    const { x: lx, z: lz } = wallLabelPosition(scene, f, k);
    return (
      <g>
        <polygon points={points(poly)} fill={isWindow ? COL.window : COL.door} stroke={isWindow ? COL.window : COL.door} strokeWidth={0.05 * k} />
        <text x={lx} y={lz + 0.08 * k} fill={COL.label} fontSize={0.22 * k} textAnchor="middle" className="bl-svg-text">
          {f.label}
        </text>
      </g>
    );
  }
  const fill = f.kind === "counter" || f.kind === "shelf" ? COL.counter : COL.feature;
  return (
    <g>
      <polygon points={points(poly)} fill={fill} stroke={COL.featureStroke} strokeWidth={0.02 * k} strokeLinejoin="round" opacity={f.kind === "plant" ? 0.75 : 1} />
      {LABELLED.has(f.kind) && Math.max(f.w, f.d) > 0.55 && (
        <text x={f.x} y={f.z + 0.08 * k} fill={COL.label} fontSize={0.22 * k} textAnchor="middle" className="bl-svg-text">
          {f.label}
        </text>
      )}
    </g>
  );
}
