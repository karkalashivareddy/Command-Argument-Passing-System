import { useEffect, useMemo, useRef } from "react";
import type { ComponentRef, ReactNode } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Vector3Tuple } from "three";
import { MathUtils, Vector3 } from "three";

import type { ProcessSpace } from "../../lib/processSpace";
import { NODE_Z_OFFSET, RADIUS_MAX, TIME_AXIS_LENGTH, nodeEndZ, nodePosition } from "../../lib/processSpace";

export type CameraPreset = "orbit" | "tree" | "timeline" | "top" | "side" | "fit";
type Controls = ComponentRef<typeof OrbitControls>;

export interface CameraPresetSpec {
  /**
   * Direction from the framing target toward the camera. The DISTANCE is not
   * here: it is derived from the record's own extent, so the same preset frames
   * a 40 ms run and a 40 s run at a readable size instead of one of them
   * landing off-screen.
   */
  direction: Vector3Tuple;
  /** Multiplier on the record-derived fit distance. */
  zoom: number;
  label: string;
  meaning: string;
}

/**
 * Each preset has one predictable meaning. Execution time is on Z, so "tree"
 * looks down the time axis at lanes and depth, and "timeline" shows time
 * running into the screen.
 */
export const CAMERA_PRESETS: Record<CameraPreset, CameraPresetSpec> = {
  orbit: { direction: [13, 10, 21], zoom: 1, label: "Orbit", meaning: "lane, depth and time together" },
  tree: { direction: [0.02, 0.2, 30], zoom: 1, label: "Process tree", meaning: "looking down the time axis" },
  timeline: { direction: [9, 6, 26], zoom: 1, label: "Timeline", meaning: "time running into the screen" },
  top: { direction: [0.02, 26, 14], zoom: 1, label: "Top", meaning: "looking down on lanes and time" },
  side: { direction: [28, 3, 0.02], zoom: 1, label: "Side", meaning: "looking along the lanes" },
  fit: { direction: [13, 10, 21], zoom: 1.22, label: "Fit", meaning: "the whole observed record in one frame" },
};

export const CAMERA_PRESET_ORDER: CameraPreset[] = ["orbit", "tree", "timeline", "top", "side", "fit"];

/**
 * A camera request.
 *
 * `revision` is what makes repeated requests work. The rig re-frames on a change
 * of `revision`, not on a change of `kind` or `preset`, which is the whole point:
 * pressing R twice, or pressing F on an already-selected node, must re-run the
 * framing even though nothing it depends on has changed. The previous code had
 * one counter driving two different effects, so the focus effect -- whose
 * dependencies were the selection and the scene -- simply never re-ran and
 * "focus" silently reset the camera instead.
 */
export interface CameraRequest {
  kind: "frame" | "focus";
  revision: number;
}

export interface SceneBounds {
  center: Vector3;
  radius: number;
  min: Vector3;
  max: Vector3;
}

/**
 * The bounding sphere of everything the record actually draws.
 *
 * Derived from observed nodes only: their lane/depth/time position, the largest
 * radius a node can reach under any lens, each node's recorded lifetime along Z,
 * and the grid's own extent. A record with no observed process yields an empty
 * sphere around the origin rather than a guessed scene.
 */
export function sceneBounds(space: ProcessSpace, scale: number): SceneBounds {
  const axis = sceneDepth(space, scale);
  if (space.nodes.length === 0) {
    const min = new Vector3(-3, -1, 0);
    const max = new Vector3(3, 2, axis);
    return { center: new Vector3(0, 0.5, axis * 0.5), radius: axis * 0.6 + 4, min, max };
  }

  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const node of space.nodes) {
    const p = nodePosition(node, scale);
    min.x = Math.min(min.x, p.x - RADIUS_MAX);
    max.x = Math.max(max.x, p.x + RADIUS_MAX);
    min.y = Math.min(min.y, p.y - RADIUS_MAX);
    max.y = Math.max(max.y, p.y + 1.9);
    min.z = Math.min(min.z, p.z + NODE_Z_OFFSET);
    max.z = Math.max(max.z, nodeEndZ(node, scale, space.spanMs));
  }
  // Event markers sit one lane to the right of their node and above it, and the
  // selection ring lies flat on the ground plane.
  min.x -= 1.6;
  max.x += 1.6;
  min.y -= 0.9;
  max.z = Math.max(max.z, axis);
  const center = new Vector3().addVectors(min, max).multiplyScalar(0.5);
  return { center, radius: Math.max(4, min.distanceTo(max) * 0.5), min, max };
}

/**
 * How far back a sphere of this radius has to sit to fit the viewport.
 *
 * Uses the camera's real vertical FOV and aspect, so a narrow window does not
 * clip the record. Clamped to the same range OrbitControls allows, so the rig
 * never sets a goal the controls would fight.
 */
export function fitDistanceFor(radius: number, fovDegrees: number, aspect: number): number {
  const vertical = MathUtils.degToRad(MathUtils.clamp(fovDegrees, 20, 80));
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(aspect, 0.4));
  const narrowest = Math.min(vertical, horizontal);
  return MathUtils.clamp(radius / Math.sin(narrowest / 2), 8, 130);
}

/** Fit the scene in the camera's actual screen plane, including depth clearance. */
export function fitBoundsDistance(bounds: SceneBounds, direction: Vector3, fovDegrees: number, aspect: number): number {
  const vertical = MathUtils.degToRad(MathUtils.clamp(fovDegrees, 20, 80));
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(aspect, 0.4));
  const forward = direction.clone().normalize();
  const worldUp = new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(forward, worldUp);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  else right.normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();
  const half = new Vector3().subVectors(bounds.max, bounds.min).multiplyScalar(0.5);
  const projectedRight = Math.abs(right.x) * half.x + Math.abs(right.y) * half.y + Math.abs(right.z) * half.z;
  const projectedUp = Math.abs(up.x) * half.x + Math.abs(up.y) * half.y + Math.abs(up.z) * half.z;
  const projectedDepth = Math.abs(forward.x) * half.x + Math.abs(forward.y) * half.y + Math.abs(forward.z) * half.z;
  const screenDistance = Math.max(projectedRight / Math.tan(horizontal / 2), projectedUp / Math.tan(vertical / 2));
  return MathUtils.clamp(projectedDepth + screenDistance * 1.12 + 3, 8, 130);
}

interface CameraRigProps {
  space: ProcessSpace;
  preset: CameraPreset;
  /** What to frame next. Bumped on every explicit request. */
  request: CameraRequest;
  /** The camera follows the replay cursor only when the user asks for it. */
  followCursor: boolean;
  cursorMs: number | null;
  selectedKey: string | null;
  reducedMotion: boolean;
  controlsRef?: (controls: Controls | null) => void;
}

/**
 * The camera is stable by default. It moves only when the user picks a preset,
 * resets, focuses a process, or enables cursor following, so a live execution
 * never re-centers the view behind the user's back.
 *
 * Every move is expressed as a goal and consumed by the same exponential lerp:
 * there is no code path that assigns the camera position outright.
 */
export function CameraRig({ space, preset, request, followCursor, cursorMs, selectedKey, reducedMotion, controlsRef }: CameraRigProps) {
  const controls = useRef<Controls | null>(null);
  const { camera } = useThree();
  const scale = useMemo(() => timeScaleFor(space.spanMs), [space.spanMs]);
  // The scene grows only when a process is observed or the recorded span grows;
  // a new snapshot for an existing process does not move anything, so it must
  // not re-frame the camera out from under a reader who is orbiting it.
  const layout = useMemo(() => ({ nodes: space.nodes.length, spanMs: space.spanMs }), [space.nodes.length, space.spanMs]);
  const bounds = useMemo(() => sceneBounds(space, scale), [layout, scale]);
  const goal = useRef<{ target: Vector3; position: Vector3 } | null>(null);
  // Read the live scene through a ref so a fresh event batch cannot retrigger
  // the effect: the effect is about the reader's request, not about the record
  // changing underneath them.
  const scene = useRef(space);
  scene.current = space;

  useEffect(() => {
    controlsRef?.(controls.current);
  }, [controlsRef]);

  // Fit the recorded record whenever a framing is requested.
  useEffect(() => {
    if (request.kind === "focus") {
      if (!selectedKey) return;
      const node = scene.current.byKey.get(selectedKey);
      if (!node) return;
      const base = nodePosition(node, scale);
      // A fixed, bounded world-space offset, so repeated focusing always lands
      // on the same framing rather than drifting with the node's own depth.
      goal.current = {
        target: new Vector3(base.x, base.y, base.z + 2),
        position: new Vector3(base.x + 8, base.y + 6, base.z + 11),
      };
      return;
    }
    const spec = CAMERA_PRESETS[preset];
    const direction = new Vector3(spec.direction[0], spec.direction[1], spec.direction[2]);
    if (direction.lengthSq() === 0) direction.set(0.02, 0.2, 1);
    direction.normalize();
    const perspective = camera as PerspectiveCamera;
    const aspect = typeof perspective.aspect === "number" && perspective.aspect > 0 ? perspective.aspect : 1.6;
    const distance = fitBoundsDistance(bounds, direction, perspective.fov ?? 45, aspect) * spec.zoom;
    goal.current = {
      target: bounds.center.clone(),
      position: bounds.center.clone().addScaledVector(direction, distance),
    };
  }, [request, preset, bounds, scale, camera]);

  useFrame((_, delta) => {
    const next = goal.current;
    if (!next) return;
    const instance = controls.current;
    const alpha = reducedMotion ? 1 : 1 - Math.exp(-7 * Math.min(delta, 0.1));
    camera.position.lerp(next.position, alpha);
    if (instance) {
      instance.target.lerp(next.target, alpha);
      instance.update();
    } else {
      camera.lookAt(next.target);
    }
    // Settled: the goal is reached, so the render loop has no camera work to do
    // until the reader asks for something else.
    if (camera.position.distanceTo(next.position) < 0.06) goal.current = null;
  });

  // Cursor following is opt-in, and is the only automatic camera motion.
  useFrame(() => {
    if (!followCursor || cursorMs === null) return;
    const instance = controls.current;
    if (!instance) return;
    const z = cursorMs * scale;
    instance.target.z = MathUtils.lerp(instance.target.z, z, 0.1);
    camera.position.z = MathUtils.lerp(camera.position.z, z, 0.1);
    instance.update();
  });

  return <OrbitControls ref={controls} makeDefault enableDamping={!reducedMotion} dampingFactor={0.12} enablePan enableZoom minDistance={4} maxDistance={140} />;
}

function timeScaleFor(spanMs: number): number {
  return spanMs > 0 ? TIME_AXIS_LENGTH / spanMs : 0.16;
}

export function spaceTimeScale(space: ProcessSpace): number {
  return timeScaleFor(space.spanMs);
}

export function sceneWidth(space: ProcessSpace): number {
  return 6 + Math.max(1, space.nodes.length) * 2.4;
}

export function sceneDepth(space: ProcessSpace, scale: number): number {
  return Math.max(TIME_AXIS_LENGTH * 0.5, space.spanMs * scale);
}

/** A quiet execution plane: a reference grid and a discrete time axis. */
export function ExecutionGrid({ space, scale }: { space: ProcessSpace; scale: number }) {
  const axis = sceneDepth(space, scale);
  const width = sceneWidth(space);
  const size = Math.max(width, axis);
  const divisions = Math.max(2, Math.round(size / 2));
  const ticks = space.ruler.ticksMs.filter((tick) => tick * scale <= axis + scale * space.ruler.stepMs);

  return (
    <group>
      <mesh position={[width * 0.15, -0.12, axis * 0.5]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial color="#0b1425" transparent opacity={0.46} depthWrite={false} />
      </mesh>
      <gridHelper args={[size, divisions, "#42618b", "#203451"]} position={[width * 0.15, -0.03, axis * 0.5]} />
      <mesh position={[width * 0.15, 0.002, axis * 0.5]}>
        <boxGeometry args={[0.035, 0.025, axis]} />
        <meshBasicMaterial color="#294867" transparent opacity={0.6} />
      </mesh>
      {ticks.map((tick) => (
        <mesh key={`tick-${tick}`} position={[width * 0.15, 0.004, tick * scale]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[tick === 0 ? 0.5 : 0.3, 0.024]} />
          <meshBasicMaterial color={tick === 0 ? "#7bdaf3" : "#344c6c"} />
        </mesh>
      ))}
    </group>
  );
}

interface CursorPlaneProps {
  cursorMs: number | null;
  scale: number;
  active: boolean;
  width: number;
  depth: number;
}

/** The shared execution-time cursor, as a plane perpendicular to Z. */
export function CursorPlane({ cursorMs, scale, active, width, depth }: CursorPlaneProps) {
  const material = useRef<MeshBasicMaterial | null>(null);
  const z = cursorMs === null ? null : cursorMs * scale;

  useFrame((_, delta) => {
    const mat = material.current;
    if (!mat) return;
    const target = active ? 0.15 : 0.08;
    mat.opacity = MathUtils.lerp(mat.opacity, target, Math.min(1, delta * 6));
  });

  if (z === null) return null;
  return (
    <group position={[0, 0, z]}>
      <mesh position={[width * 0.15, 0.01, depth * 0.4]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width, depth]} />
        <meshBasicMaterial ref={material} color="#a38bff" transparent opacity={0.1} depthWrite={false} />
      </mesh>
      <mesh position={[width * 0.15 - width / 2 - 0.15, 0, 0]}>
        <boxGeometry args={[0.04, 0.04, depth * 0.8]} />
        <meshBasicMaterial color="#a38bff" transparent opacity={0.8} />
      </mesh>
    </group>
  );
}

export function SelectionRing({ space, nodeKey, scale, reducedMotion }: { space: ProcessSpace; nodeKey: string; scale: number; reducedMotion: boolean }) {
  const node = space.byKey.get(nodeKey);
  const ring = useRef<Mesh | null>(null);
  const position = node ? nodePosition(node, scale) : null;

  useFrame((state) => {
    if (!ring.current || reducedMotion) return;
    ring.current.scale.setScalar(1 + Math.sin(state.clock.elapsedTime * 2) * 0.04);
  });

  if (!node || !position) return null;
  return (
    <mesh ref={ring} position={[position.x, -0.02, position.z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[1.45, 1.7, 48]} />
      <meshBasicMaterial color="#a38bff" transparent opacity={0.8} side={2} />
    </mesh>
  );
}

export function SceneGroup({ children }: { children: ReactNode }) {
  const group = useRef<Group | null>(null);
  return <group ref={group}>{children}</group>;
}
