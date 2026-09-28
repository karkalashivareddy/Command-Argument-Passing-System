import { useEffect, useMemo, useRef } from "react";
import type { ComponentRef, ReactNode } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { Group, Mesh, MeshBasicMaterial, Vector3Tuple } from "three";
import { MathUtils, Vector3 } from "three";

import type { ProcessSpace } from "../../lib/processSpace";
import { TIME_AXIS_LENGTH, nodePosition } from "../../lib/processSpace";

export type CameraPreset = "overview" | "tree" | "timeline" | "top" | "side";
type Controls = ComponentRef<typeof OrbitControls>;

export interface CameraPresetSpec {
  /** Direction from the target to the camera, in world units. */
  offset: Vector3Tuple;
  label: string;
  meaning: string;
}

/**
 * Each preset has one predictable meaning. Execution time is on Z, so "tree"
 * looks down the time axis at lanes and depth, and "timeline" shows time
 * running into the screen.
 */
export const CAMERA_PRESETS: Record<CameraPreset, CameraPresetSpec> = {
  overview: { offset: [13, 10, 21], label: "Overview", meaning: "lane, depth and time together" },
  tree: { offset: [0.01, 0, 30], label: "Process tree", meaning: "looking down the time axis" },
  timeline: { offset: [9, 6, 26], label: "Timeline", meaning: "time running into the screen" },
  top: { offset: [0.01, 26, 14], label: "Top", meaning: "looking down on lanes and time" },
  side: { offset: [28, 3, 0.01], label: "Side", meaning: "looking along the lanes" },
};

export const CAMERA_PRESET_ORDER: CameraPreset[] = ["overview", "tree", "timeline", "top", "side"];

interface CameraRigProps {
  space: ProcessSpace;
  preset: CameraPreset;
  /** The camera follows the replay cursor only when the user asks for it. */
  followCursor: boolean;
  cursorMs: number | null;
  selectedKey: string | null;
  reducedMotion: boolean;
  /** Bumped to request a re-fit, e.g. from the "reset camera" shortcut. */
  resetToken: number;
  controlsRef?: (controls: Controls | null) => void;
}

/**
 * The camera is stable by default. It moves only when the user picks a preset,
 * resets, focuses a process, or enables cursor following, so a live execution
 * never re-centers the view behind the user's back.
 */
export function CameraRig({ space, preset, followCursor, cursorMs, selectedKey, reducedMotion, resetToken, controlsRef }: CameraRigProps) {
  const controls = useRef<Controls | null>(null);
  const { camera } = useThree();
  const scale = useMemo(() => timeScaleFor(space.spanMs), [space.spanMs]);
  const goal = useRef<{ target: Vector3; position: Vector3 } | null>(null);

  useEffect(() => {
    controlsRef?.(controls.current);
  }, [controlsRef]);

  // Fit the recorded record whenever the requested view changes.
  useEffect(() => {
    const spec = CAMERA_PRESETS[preset];
    const axis = Math.max(TIME_AXIS_LENGTH * 0.5, space.spanMs * scale);
    const lanes = Math.max(1, space.nodes.length);
    goal.current = {
      target: new Vector3(lanes * 1.2, -1.2, axis * 0.45),
      position: new Vector3(spec.offset[0], spec.offset[1], spec.offset[2]),
    };
  }, [preset, space.nodes.length, space.spanMs, scale, resetToken]);

  // Focus a selected process. Explicit action, not automatic tracking. The
  // offset is a fixed, bounded world-space vector, so repeated focusing always
  // lands on the same framing.
  useEffect(() => {
    if (!selectedKey) return;
    const node = space.byKey.get(selectedKey);
    if (!node) return;
    const base = nodePosition(node, scale);
    goal.current = {
      target: new Vector3(base.x, base.y, base.z + 2),
      position: new Vector3(base.x + 8, base.y + 6, base.z + 11),
    };
  }, [selectedKey, space.byKey, scale]);

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
      <gridHelper args={[size, divisions, "#1b232d", "#12181f"]} position={[width * 0.15, -0.03, axis * 0.5]} />
      {ticks.map((tick) => (
        <mesh key={`tick-${tick}`} position={[width * 0.15, 0.004, tick * scale]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[tick === 0 ? 0.5 : 0.3, 0.024]} />
          <meshBasicMaterial color={tick === 0 ? "#5b6673" : "#2b3542"} />
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
        <meshBasicMaterial ref={material} color="#8b7cf6" transparent opacity={0.1} depthWrite={false} />
      </mesh>
      <mesh position={[width * 0.15 - width / 2 - 0.15, 0, 0]}>
        <boxGeometry args={[0.04, 0.04, depth * 0.8]} />
        <meshBasicMaterial color="#8b7cf6" transparent opacity={0.8} />
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
      <meshBasicMaterial color="#8b7cf6" transparent opacity={0.8} side={2} />
    </mesh>
  );
}

export function SceneGroup({ children }: { children: ReactNode }) {
  const group = useRef<Group | null>(null);
  return <group ref={group}>{children}</group>;
}
