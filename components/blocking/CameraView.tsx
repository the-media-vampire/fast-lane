"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Feature, Scene, SetLayout } from "@/lib/blocking/types";
import type { ActorSample, CameraSample, PropSample } from "@/lib/blocking/sample";
import { MANNEQUIN_BASE_HEIGHT, PROP_DIMS, sampleSceneAt } from "@/lib/blocking/sample";
import { aspectNumber } from "@/lib/blocking/lens";
import { featureNormal, seatAt, surfaceInFront } from "@/lib/blocking/sets";
import "./blocking.css";

/**
 * The grey camera view: the shot exactly as the scene's camera sees it at time `t`.
 * Controlled — the parent owns the clock — and drawn on demand, so a paused frame costs
 * nothing. Not an editor: no orbit controls, no gizmos. With `capture` the drawing buffer
 * is preserved and the film-safe corner marks are left out, for storyboard captures.
 */

type Props = {
  scene: Scene;
  t: number;
  className?: string;
  onReady?: () => void;
  capture?: boolean;
  /** Accessible description of the frame; DirectStage supplies one from the scene. */
  label?: string;
};

const C = {
  bg: "#2a2d2e",
  bgExterior: "#3d4245",
  floor: "#4b504e",
  wall: "#6a706d",
  backWall: "#737976",
  furniture: "#858b87",
  top: "#a4a9a4",
  dark: "#5c625f",
  windowGlow: "#c9cec6",
  frame: "#575d5a",
  figure: "#b9bdb7",
  prop: "#e6e3da",
  plant: "#87908a",
} as const;

const rad = (d: number) => (d * Math.PI) / 180;

function useFittedBox(ref: React.RefObject<HTMLDivElement | null>, aspect: number) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W) return;
      // An unsized container gets the shot's own aspect from its width.
      if (H < 8) return setBox({ w: W, h: Math.round(W / aspect) });
      const w = Math.min(W, H * aspect);
      setBox({ w: Math.floor(w), h: Math.floor(w / aspect) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, aspect]);
  return box;
}

export function CameraView({ scene, t, className, onReady, capture, label }: Props) {
  const outer = useRef<HTMLDivElement>(null);
  const aspect = aspectNumber(scene.aspect);
  const box = useFittedBox(outer, aspect);
  const sample = useMemo(() => sampleSceneAt(scene, t), [scene, t]);
  const token = `${t.toFixed(3)}:${scene.camera.keys.length}:${scene.duration}`;

  return (
    <div ref={outer} className={`bl-camera ${className ?? ""}`} role="img" aria-label={label ?? "Grey blocking view from the shot camera"}>
      {box && (
        <div className="bl-camera-box" style={{ width: box.w, height: box.h }}>
          <Canvas
            shadows="percentage"
            frameloop="demand"
            dpr={capture ? 1 : [1, 2]}
            gl={{ preserveDrawingBuffer: !!capture, antialias: true }}
            camera={{ fov: 40, near: 0.05, far: 250, position: [0, 1.6, 6] }}
            style={{ width: box.w, height: box.h, display: "block" }}
            aria-hidden
          >
            <color attach="background" args={[scene.set.exterior ? C.bgExterior : C.bg]} />
            <fog attach="fog" args={[scene.set.exterior ? "#454a4d" : "#2f3233", 14, scene.set.exterior ? 70 : 34]} />
            <Lights set={scene.set} />
            <SetGeometry set={scene.set} />
            {sample.actors.map((a) => (
              <Mannequin key={a.id} actor={a} set={scene.set} t={t} />
            ))}
            {sample.props.map((p) => (
              <PropBlock key={p.id} prop={p} />
            ))}
            <ShotCamera cam={sample.camera} />
            <ReadySignal token={token} onReady={onReady} />
          </Canvas>
          {!capture && <CornerMarks />}
        </div>
      )}
    </div>
  );
}

function CornerMarks() {
  return (
    <div className="bl-corners" aria-hidden>
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function ShotCamera({ cam }: { cam: CameraSample }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    camera.fov = cam.fovV;
    camera.aspect = size.width / Math.max(1, size.height);
    camera.near = 0.05;
    camera.far = 250;
    camera.up.set(0, 1, 0);
    camera.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
    camera.lookAt(cam.target.x, cam.target.y, cam.target.z);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, cam, size, invalidate]);
  return null;
}

/** Signals once a few frames have drawn with the current state (captures wait for it). */
function ReadySignal({ token, onReady }: { token: string; onReady?: () => void }) {
  const invalidate = useThree((s) => s.invalidate);
  const frames = useRef(0);
  const fired = useRef<string | null>(null);
  useEffect(() => {
    frames.current = 0;
    invalidate();
  }, [token, invalidate]);
  useFrame(() => {
    if (fired.current === token) return;
    frames.current += 1;
    if (frames.current >= 3) {
      fired.current = token;
      onReady?.();
    } else invalidate();
  });
  return null;
}

function Lights({ set }: { set: SetLayout }) {
  // Key light from the first window (or softbox): daylight falling into the room.
  const key = useMemo(() => {
    const w = set.features.find((f) => f.kind === "window");
    if (!w) return { pos: new THREE.Vector3(-4, 6, 5), target: new THREE.Vector3(0, 0, 0) };
    const n = featureNormal(set, w);
    return {
      pos: new THREE.Vector3(w.x - n.x * 3, (w.elev ?? 0) + w.h + 2.5, w.z - n.z * 3),
      target: new THREE.Vector3(w.x + n.x * 3, 0, w.z + n.z * 3),
    };
  }, [set]);
  const light = useRef<THREE.DirectionalLight>(null);
  useLayoutEffect(() => {
    if (!light.current) return;
    light.current.target.position.copy(key.target);
    light.current.target.updateMatrixWorld();
  }, [key]);
  const reach = Math.max(set.width, set.depth) * 0.8 + 2;
  return (
    <>
      <hemisphereLight args={["#e9ece6", "#3a3d3b", 0.9]} />
      <ambientLight intensity={0.2} />
      <directionalLight
        ref={light}
        position={key.pos}
        intensity={1.7}
        color="#fff6ea"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0004}
        shadow-camera-left={-reach}
        shadow-camera-right={reach}
        shadow-camera-top={reach}
        shadow-camera-bottom={-reach}
        shadow-camera-near={0.5}
        shadow-camera-far={60}
      />
      <directionalLight position={[0, 3, 12]} intensity={0.25} />
    </>
  );
}

function Mat({ color, rough = 0.92 }: { color: string; rough?: number }) {
  return <meshStandardMaterial color={color} roughness={rough} metalness={0} />;
}

function Box({ size, position, color, cast = true }: { size: [number, number, number]; position: [number, number, number]; color: string; cast?: boolean }) {
  return (
    <mesh position={position} castShadow={cast} receiveShadow>
      <boxGeometry args={size} />
      <Mat color={color} />
    </mesh>
  );
}

function SetGeometry({ set }: { set: SetLayout }) {
  const w = set.width;
  const d = set.depth;
  const h = set.height;
  return (
    <group>
      {set.exterior ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[w + 60, d + 60]} />
          <Mat color={C.floor} />
        </mesh>
      ) : (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[w, d]} />
            <Mat color={C.floor} />
          </mesh>
          {/* The open side keeps a short apron of floor so a camera standing there has ground. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.002, d / 2 + 2]} receiveShadow>
            <planeGeometry args={[w, 4]} />
            <Mat color="#3f4342" />
          </mesh>
          {/* Walls receive light but never block it: the key comes in through the windows. */}
          <Box size={[w + 0.2, h, 0.1]} position={[0, h / 2, -d / 2 - 0.05]} color={C.backWall} cast={false} />
          <Box size={[0.1, h, d]} position={[-w / 2 - 0.05, h / 2, 0]} color={C.wall} cast={false} />
          <Box size={[0.1, h, d]} position={[w / 2 + 0.05, h / 2, 0]} color={C.wall} cast={false} />
        </>
      )}
      {set.features.map((f) => (
        <FeatureMesh key={f.id} feature={f} set={set} />
      ))}
    </group>
  );
}

function WallOpening({ feature, set, kind }: { feature: Feature; set: SetLayout; kind: "window" | "door" }) {
  const n = featureNormal(set, feature);
  const yaw = Math.atan2(n.x, n.z);
  const elev = feature.elev ?? 0;
  const fw = feature.w;
  const fh = feature.h;
  const frame = 0.05;
  return (
    <group position={[feature.x + n.x * 0.04, elev + fh / 2, feature.z + n.z * 0.04]} rotation={[0, yaw, 0]}>
      {kind === "window" ? (
        <>
          <mesh>
            <planeGeometry args={[fw, fh]} />
            <meshBasicMaterial color={C.windowGlow} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
          <Box size={[fw + frame * 2, frame, 0.06]} position={[0, fh / 2, 0.01]} color={C.frame} cast={false} />
          <Box size={[fw + frame * 2, frame, 0.06]} position={[0, -fh / 2, 0.01]} color={C.frame} cast={false} />
          <Box size={[frame, fh, 0.06]} position={[-fw / 2, 0, 0.01]} color={C.frame} cast={false} />
          <Box size={[frame, fh, 0.06]} position={[fw / 2, 0, 0.01]} color={C.frame} cast={false} />
          <Box size={[0.035, fh, 0.05]} position={[0, 0, 0.012]} color={C.frame} cast={false} />
          <Box size={[fw, 0.035, 0.05]} position={[0, fh * 0.12, 0.012]} color={C.frame} cast={false} />
        </>
      ) : (
        <>
          <Box size={[fw, fh, 0.06]} position={[0, 0, 0]} color={C.dark} cast={false} />
          <Box size={[0.04, 0.16, 0.05]} position={[fw * 0.35, 0, 0.05]} color={C.top} cast={false} />
        </>
      )}
    </group>
  );
}

function FeatureMesh({ feature: f, set }: { feature: Feature; set: SetLayout }) {
  if (f.kind === "window" || f.kind === "door") return <WallOpening feature={f} set={set} kind={f.kind} />;
  const elev = f.elev ?? 0;
  const body = (() => {
    switch (f.kind) {
      case "counter":
        return (
          <>
            <Box size={[f.w, f.h - 0.04, f.d]} position={[0, (f.h - 0.04) / 2, 0]} color={C.furniture} />
            <Box size={[f.w + 0.04, 0.04, f.d + 0.04]} position={[0, f.h - 0.02, 0]} color={C.top} />
          </>
        );
      case "table":
      case "desk": {
        const top = f.surface ?? f.h;
        const legInset = 0.06;
        const legs = f.w > 0.5 && f.d > 0.5;
        return (
          <>
            <Box size={[f.w, 0.05, f.d]} position={[0, top - 0.025, 0]} color={C.top} />
            {legs ? (
              [
                [-1, -1],
                [1, -1],
                [1, 1],
                [-1, 1],
              ].map(([sx, sz], i) => (
                <mesh key={i} position={[sx * (f.w / 2 - legInset), (top - 0.05) / 2, sz * (f.d / 2 - legInset)]} castShadow>
                  <cylinderGeometry args={[0.025, 0.025, top - 0.05, 8]} />
                  <Mat color={C.dark} />
                </mesh>
              ))
            ) : (
              <mesh position={[0, (top - 0.05) / 2, 0]} castShadow>
                <cylinderGeometry args={[0.05, 0.08, top - 0.05, 10]} />
                <Mat color={C.dark} />
              </mesh>
            )}
            {f.kind === "desk" && <Box size={[f.w * 0.32, top - 0.06, f.d * 0.92]} position={[f.w * 0.32, (top - 0.06) / 2, 0]} color={C.furniture} />}
          </>
        );
      }
      case "chair": {
        const seat = f.surface ?? 0.46;
        const stool = /stool/i.test(f.label) || seat > 0.6;
        return (
          <>
            <Box size={[f.w, 0.06, f.d]} position={[0, seat - 0.03, 0]} color={C.furniture} />
            {!stool && <Box size={[f.w, 0.46, 0.05]} position={[0, seat + 0.23, -f.d / 2 + 0.025]} color={C.furniture} />}
            <mesh position={[0, (seat - 0.06) / 2, 0]} castShadow>
              <cylinderGeometry args={[0.03, 0.05, seat - 0.06, 8]} />
              <Mat color={C.dark} />
            </mesh>
          </>
        );
      }
      case "sofa":
        return (
          <>
            <Box size={[f.w, 0.42, f.d]} position={[0, 0.21, 0]} color={C.furniture} />
            <Box size={[f.w, 0.5, 0.2]} position={[0, 0.65, -f.d / 2 + 0.1]} color={C.furniture} />
            <Box size={[0.18, 0.24, f.d]} position={[-f.w / 2 + 0.09, 0.54, 0]} color={C.furniture} />
            <Box size={[0.18, 0.24, f.d]} position={[f.w / 2 - 0.09, 0.54, 0]} color={C.furniture} />
          </>
        );
      case "bed":
        return (
          <>
            <Box size={[f.w, 0.38, f.d]} position={[0, 0.19, 0]} color={C.furniture} />
            <Box size={[f.w - 0.04, 0.16, f.d - 0.04]} position={[0, 0.46, 0]} color={C.top} />
            <Box size={[f.w * 0.8, 0.1, 0.35]} position={[0, 0.59, -f.d / 2 + 0.3]} color="#c3c7c1" />
            <Box size={[f.w, 0.95, 0.06]} position={[0, 0.475, -f.d / 2 - 0.03]} color={C.dark} />
          </>
        );
      case "shelf":
        return (
          <>
            <Box size={[f.w, f.h, f.d]} position={[0, f.h / 2, 0]} color="#6e7471" />
            {[0.25, 0.5, 0.75].map((k) => (
              <Box key={k} size={[f.w + 0.01, 0.025, f.d + 0.01]} position={[0, f.h * k, 0]} color={C.top} cast={false} />
            ))}
          </>
        );
      case "plant": {
        const tree = f.h > 2.5;
        const r = Math.min(f.w, f.d) / 2;
        if (tree) {
          // Canopy held above head height so a tree never walls off a shot.
          const canopy = Math.min(r * 0.9, f.h * 0.3);
          return (
            <>
              <mesh position={[0, f.h * 0.4, 0]} castShadow>
                <cylinderGeometry args={[0.1, 0.15, f.h * 0.8, 10]} />
                <Mat color={C.dark} />
              </mesh>
              <mesh position={[0, f.h - canopy, 0]} scale={[1, 1.3, 1]} castShadow>
                <sphereGeometry args={[canopy, 18, 12]} />
                <Mat color={C.plant} />
              </mesh>
            </>
          );
        }
        // A slim column of foliage on a pot, not a ball.
        const foliage = Math.max(0.3, f.h - 0.42);
        const radius = Math.min(r * 0.6, 0.2);
        return (
          <>
            <mesh position={[0, 0.17, 0]} castShadow>
              <cylinderGeometry args={[radius * 0.95, radius * 0.75, 0.34, 14]} />
              <Mat color={C.dark} />
            </mesh>
            <mesh position={[0, 0.34 + foliage / 2, 0]} castShadow>
              <capsuleGeometry args={[radius, Math.max(0.05, foliage - radius * 2), 6, 12]} />
              <Mat color={C.plant} />
            </mesh>
          </>
        );
      }
      default:
        return <Box size={[f.w, f.h, f.d]} position={[0, f.h / 2, 0]} color={f.h > 3 ? "#6f7572" : "#7a807c"} />;
    }
  })();
  return (
    <group position={[f.x, elev, f.z]} rotation={[0, rad(f.rot ?? 0), 0]}>
      {body}
    </group>
  );
}

/* ---------- figures (mannequin proportions, 1.82 m at scale 1) ---------- */

function tint(base: string, mark: string, k: number): string {
  return `#${new THREE.Color(base).lerp(new THREE.Color(mark), k).getHexString()}`;
}

function Limb({ r, len, position, rotation, color }: { r: number; len: number; position: [number, number, number]; rotation?: [number, number, number]; color: string }) {
  return (
    <mesh position={position} rotation={rotation ?? [0, 0, 0]} castShadow>
      <capsuleGeometry args={[r, len, 6, 12]} />
      <Mat color={color} rough={0.7} />
    </mesh>
  );
}

/** Facing cue: a short rounded wedge pointing forward from the face (+z). */
function Nose({ y, z, color }: { y: number; z: number; color: string }) {
  return (
    <mesh position={[0, y - 0.01, z + 0.02]} rotation={[Math.PI / 2, 0, 0]} castShadow>
      <coneGeometry args={[0.026, 0.06, 12]} />
      <Mat color={color} rough={0.75} />
    </mesh>
  );
}

function Mannequin({ actor, set, t }: { actor: ActorSample; set: SetLayout; t: number }) {
  const s = actor.height / MANNEQUIN_BASE_HEIGHT;
  const color = tint(C.figure, actor.color, 0.12);
  // A small nose in a slightly lighter grey shows which way they face without reading as a mask.
  const nose = tint(color, "#ffffff", 0.18);
  const seat = actor.pose === "sit" ? seatAt(set, actor.x, actor.z) : undefined;
  const atTable = actor.pose === "sit" && !!surfaceInFront(set, actor.x, actor.z, actor.facing);
  // The sitting silhouette has its hips at 0.45 m; raise it onto taller seats (stools, beds).
  const lift = seat ? Math.max(0, (seat.surface ?? 0.46) - 0.45 * s) : 0;
  const swing = actor.pose === "walk" ? Math.sin(t * Math.PI * 2 * 0.9) * 0.42 : 0;
  return (
    <group position={[actor.x, lift, actor.z]} rotation={[0, rad(actor.facing), 0]} scale={[s, s, s]}>
      {actor.pose === "sit" ? (
        <>
          <mesh position={[0, 1.4, 0]} castShadow>
            <sphereGeometry args={[0.12, 24, 16]} />
            <Mat color={color} rough={0.7} />
          </mesh>
          <Nose y={1.4} z={0.105} color={nose} />
          <Limb r={0.18} len={0.5} position={[0, 0.85, 0]} color={color} />
          {/* Arms hang from the shoulders; at a table they reach forward to rest on it. */}
          <group position={[-0.25, 1.1, 0.04]} rotation={[atTable ? -0.95 : -0.3, 0, 0.06]}>
            <Limb r={0.07} len={0.48} position={[0, -0.25, 0]} color={color} />
          </group>
          <group position={[0.25, 1.1, 0.04]} rotation={[atTable ? -0.95 : -0.3, 0, -0.06]}>
            <Limb r={0.07} len={0.48} position={[0, -0.25, 0]} color={color} />
          </group>
          <Limb r={0.09} len={0.4} position={[-0.11, 0.45, 0.25]} rotation={[Math.PI / 2, 0, 0]} color={color} />
          <Limb r={0.09} len={0.4} position={[0.11, 0.45, 0.25]} rotation={[Math.PI / 2, 0, 0]} color={color} />
          <Limb r={0.085} len={0.35} position={[-0.11, 0.22, 0.45]} color={color} />
          <Limb r={0.085} len={0.35} position={[0.11, 0.22, 0.45]} color={color} />
        </>
      ) : actor.pose === "reach" ? (
        <>
          <mesh position={[0, 1.7, 0.05]} castShadow>
            <sphereGeometry args={[0.12, 24, 16]} />
            <Mat color={color} rough={0.7} />
          </mesh>
          <Nose y={1.7} z={0.155} color={nose} />
          <Limb r={0.18} len={0.5} position={[0, 1.15, 0.05]} rotation={[-Math.PI / 24, 0, 0]} color={color} />
          <Limb r={0.07} len={0.55} position={[-0.2, 1.3, 0.4]} rotation={[Math.PI / 2, 0, 0]} color={color} />
          <Limb r={0.07} len={0.55} position={[0.2, 1.3, 0.4]} rotation={[Math.PI / 2, 0, 0]} color={color} />
          <Limb r={0.09} len={0.6} position={[-0.11, 0.4, 0]} color={color} />
          <Limb r={0.09} len={0.6} position={[0.11, 0.4, 0]} color={color} />
        </>
      ) : (
        <>
          <mesh position={[0, 1.7, 0]} castShadow>
            <sphereGeometry args={[0.12, 24, 16]} />
            <Mat color={color} rough={0.7} />
          </mesh>
          <Nose y={1.7} z={0.105} color={nose} />
          <Limb r={0.18} len={0.5} position={[0, 1.15, 0]} color={color} />
          {/* Limbs pivot at shoulder and hip so a walk swings them, not slides them. */}
          <group position={[-0.28, 1.42, 0]} rotation={[-swing * 0.7, 0, 0]}>
            <Limb r={0.07} len={0.55} position={[0, -0.27, 0]} color={color} />
          </group>
          <group position={[0.28, 1.42, 0]} rotation={[swing * 0.7, 0, 0]}>
            <Limb r={0.07} len={0.55} position={[0, -0.27, 0]} color={color} />
          </group>
          <group position={[-0.11, 0.72, 0]} rotation={[swing, 0, 0]}>
            <Limb r={0.09} len={0.6} position={[0, -0.32, 0]} color={color} />
          </group>
          <group position={[0.11, 0.72, 0]} rotation={[-swing, 0, 0]}>
            <Limb r={0.09} len={0.6} position={[0, -0.32, 0]} color={color} />
          </group>
        </>
      )}
    </group>
  );
}

const WHEELED = /\b(bike|bicycle|cycle|e-?bike|scooter|motorbike|motorcycle|moped)\b/i;

function PropMat() {
  return <meshStandardMaterial color={C.prop} roughness={0.6} emissive="#33322e" />;
}

function Bar({ from, to, r = 0.02 }: { from: [number, number, number]; to: [number, number, number]; r?: number }) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return (
    <mesh position={mid} quaternion={q} castShadow>
      <cylinderGeometry args={[r, r, dir.length(), 8]} />
      <PropMat />
    </mesh>
  );
}

/** Long, low, open silhouette (~1.7 × 1.0 × 0.25 m); a bicycle by name. Length runs along local x. */
function LargeProp({ prop }: { prop: PropSample }) {
  const L = PROP_DIMS.large.length;
  const H = PROP_DIMS.large.height;
  const W = PROP_DIMS.large.width;
  if (WHEELED.test(prop.name)) {
    const R = 0.34;
    const wx = L / 2 - R;
    return (
      <group position={[prop.x, 0, prop.z]} rotation={[0, rad(prop.rot), 0]}>
        {[-wx, wx].map((x) => (
          <mesh key={x} position={[x, R, 0]} castShadow>
            <torusGeometry args={[R, 0.022, 8, 36]} />
            <PropMat />
          </mesh>
        ))}
        <Bar from={[-wx, R, 0]} to={[-0.1, R, 0]} />
        <Bar from={[-0.1, R, 0]} to={[-0.22, 0.82, 0]} />
        <Bar from={[-wx, R, 0]} to={[-0.22, 0.82, 0]} />
        <Bar from={[-0.22, 0.82, 0]} to={[0.42, 0.8, 0]} />
        <Bar from={[-0.1, R, 0]} to={[0.42, 0.8, 0]} />
        <Bar from={[0.42, 0.8, 0]} to={[wx, R, 0]} />
        <Bar from={[0.42, 0.8, 0]} to={[0.38, H - 0.02, 0]} />
        <Bar from={[0.38, H - 0.02, -0.24]} to={[0.38, H - 0.02, 0.24]} />
        <mesh position={[-0.24, 0.88, 0]} castShadow>
          <boxGeometry args={[0.24, 0.05, 0.1]} />
          <PropMat />
        </mesh>
      </group>
    );
  }
  // Generic large prop: two end frames and rails, open between them (a bench, a cart, a pram).
  return (
    <group position={[prop.x, 0, prop.z]} rotation={[0, rad(prop.rot), 0]}>
      {[-L / 2 + 0.04, L / 2 - 0.04].map((x) => (
        <mesh key={x} position={[x, H * 0.45, 0]} castShadow>
          <boxGeometry args={[0.08, H * 0.9, W]} />
          <PropMat />
        </mesh>
      ))}
      <mesh position={[0, H * 0.42, 0]} castShadow>
        <boxGeometry args={[L, 0.07, W]} />
        <PropMat />
      </mesh>
      <mesh position={[0, H - 0.05, 0]} castShadow>
        <boxGeometry args={[L * 0.86, 0.06, W * 0.6]} />
        <PropMat />
      </mesh>
    </group>
  );
}

function PropBlock({ prop }: { prop: PropSample }) {
  if (prop.size === "large") return <LargeProp prop={prop} />;
  if (prop.size === "small") {
    return (
      <group position={[prop.x, prop.y, prop.z]}>
        <mesh position={[0, 0.05, 0]} castShadow>
          <cylinderGeometry args={[0.045, 0.038, 0.1, 18]} />
          <meshStandardMaterial color={C.prop} roughness={0.55} emissive="#3b3a36" />
        </mesh>
        {!prop.heldBy && (
          <mesh position={[0, 0.006, 0]} castShadow>
            <cylinderGeometry args={[0.075, 0.07, 0.012, 20]} />
            <meshStandardMaterial color={C.prop} roughness={0.6} emissive="#2e2d2a" />
          </mesh>
        )}
      </group>
    );
  }
  const d = PROP_DIMS.medium;
  return (
    <mesh position={[prop.x, prop.y + d.height / 2, prop.z]} rotation={[0, rad(prop.rot), 0]} castShadow>
      <boxGeometry args={[d.length, d.height, d.width]} />
      <PropMat />
    </mesh>
  );
}
