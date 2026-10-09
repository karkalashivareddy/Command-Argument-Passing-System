import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group, Mesh, MeshStandardMaterial } from "three";
import { MathUtils, QuadraticBezierCurve3, Vector3 } from "three";

import type { MetricMode, ProcessSpace, SpaceEdge, SpaceMarker, SpaceNodeState } from "../../lib/processSpace";
import {
  MARKER_COLORS,
  NODE_Z_OFFSET,
  lensIntensity,
  nodeEndZ,
  nodePosition,
  radiusForMode,
  statePalette,
} from "../../lib/processSpace";

/**
 * Bound on the idle turn, in radians, and on the emissive pulse, in intensity.
 *
 * Both are fixed ceilings, not free parameters: the motion can never grow past
 * them, so no amount of observed activity can turn a decoration into a channel
 * that competes with size or colour for meaning.
 */
const IDLE_SPIN_AMPLITUDE = 0.35;
const IDLE_PULSE_AMPLITUDE = 0.12;

/** Pointer position, in client coordinates, for the HTML evidence tooltip. */
export interface HoverPoint {
  x: number;
  y: number;
}

interface ProcessNodeProps {
  state: SpaceNodeState;
  scale: number;
  mode: MetricMode;
  selected: boolean;
  /** A verified parent or child of the selection: emphasised, not dimmed away. */
  related: boolean;
  reducedMotion: boolean;
  /** Canonical sequence of the selected event, for the exec marker highlight. */
  selectedSequence: number | null;
  onSelect: (key: string) => void;
  onHover: (key: string | null, point: HoverPoint | null) => void;
  onSelectEvent: (sequence: number, atMs: number, nodeKey: string | null) => void;
}

/**
 * One node per observed process.
 *
 * position = lane (X), depth (Y), execution time (Z) -- a pure function of the
 *            record, with nothing time-based added to it
 * size     = bounded mapping of the active resource lens (observed RSS by default)
 * colour   = lifecycle state, taken from the canonical record only
 * ring     = the same lens value, animated only while the process runs
 *
 * Selection is a matte violet wireframe and a base outline, never a glow: the
 * data colour still means the lifecycle state, and it must keep meaning that
 * while a process is selected.
 *
 * Labels are never rendered into the canvas: they live in HTML so the text
 * stays selectable, accessible, and cheap.
 */
export function ProcessNodeMesh({ state, scale, mode, selected, related, reducedMotion, selectedSequence, onSelect, onHover, onSelectEvent }: ProcessNodeProps) {
  const group = useRef<Group | null>(null);
  const body = useRef<Mesh | null>(null);
  const material = useRef<MeshStandardMaterial | null>(null);
  const ringMaterial = useRef<MeshStandardMaterial | null>(null);

  const { node } = state;
  const base = useMemo(() => nodePosition(node, scale), [node, scale]);
  const radius = radiusForMode(state, mode);
  const palette = statePalette(state.state);
  const activity = lensIntensity(state, mode);
  const isEngine = node.role === "caps-engine";
  // The CAPS engine node is coloured by its own lifecycle state like every other
  // node. It used to be painted a fixed grey, which meant the colour channel
  // said "unsampled" instead of "this process is running / has been reaped" --
  // and the engine is exactly the process a reader is told about. Its missing
  // procfs sample is carried by its minimum size, its absent activity ring, and
  // the note in the tooltip and the table, which are the channels that can state
  // an absence without lying about a lifecycle.
  const color = palette.color;
  const execOffset = node.execAtMs !== null && node.createdAtMs !== null ? (node.execAtMs - node.createdAtMs) * scale : null;

  useFrame((frameState, delta) => {
    const t = frameState.clock.elapsedTime;
    /*
     * Idle motion.
     *
     * It used to displace `instance.position` by a wall-clock sine, which made
     * node POSITION a function of when the reader happened to be looking: two
     * readers of the same record saw different geometry, so the position channel
     * was not what the page claimed it was. Position is now written once, from
     * `base`, and never touched again.
     *
     * The motion moved to two channels that encode no quantity: the body's turn
     * and its emissive pulse. Size is untouched, because size is RSS. Both stay
     * off when the process is terminal, when the reader asked for reduced
     * motion, and when the lens recorded nothing.
     */
    const moving = !reducedMotion && !state.terminal && activity > 0;
    const instance = group.current;
    if (instance) {
      instance.position.set(base.x, base.y + 0.7, base.z + NODE_Z_OFFSET);
      instance.visible = state.present;
    }
    const mesh = body.current;
    if (mesh) {
      mesh.rotation.y = moving ? Math.sin(t * 0.9) * IDLE_SPIN_AMPLITUDE * (0.35 + activity * 0.65) : 0;
    }
    const mat = material.current;
    if (mat) {
      const target = state.present ? (selected ? 1 : isEngine ? 0.6 : related ? 0.85 : 0.8) : 0;
      mat.opacity = MathUtils.lerp(mat.opacity, target, Math.min(1, delta * 8));
      const pulse = moving ? activity * IDLE_PULSE_AMPLITUDE * (0.5 + 0.5 * Math.sin(t * 3)) : 0;
      mat.emissiveIntensity = MathUtils.lerp(mat.emissiveIntensity, 0.15 + activity * 0.5 + pulse, Math.min(1, delta * 4));
    }
    const ring = ringMaterial.current;
    if (ring) {
      const target = state.present && !isEngine ? 0.15 + activity * 0.85 : 0;
      ring.opacity = MathUtils.lerp(ring.opacity, target * (state.terminal ? 0.35 : 1), Math.min(1, delta * 5));
    }
  });

  return (
    <group
      ref={group}
      position={[base.x, base.y + 0.7, base.z + NODE_Z_OFFSET]}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.key);
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        const native = event.nativeEvent as PointerEvent;
        onHover(node.key, { x: native.clientX, y: native.clientY });
      }}
      onPointerMove={(event) => {
        const native = event.nativeEvent as PointerEvent;
        onHover(node.key, { x: native.clientX, y: native.clientY });
      }}
      onPointerOut={() => onHover(null, null)}
    >
      <mesh ref={body}>
        <boxGeometry args={[radius * 1.6, radius * 1.6, radius * 1.6]} />
        <meshStandardMaterial
          ref={material}
          color={color}
          emissive={color}
          emissiveIntensity={0.15}
          transparent
          opacity={0}
          roughness={0.55}
          metalness={0.25}
        />
      </mesh>

      {/* Activity ring: intensity only, no bloom. */}
      {!isEngine ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -radius * 0.82, 0]}>
          <ringGeometry args={[radius * 0.9, radius * 1.18, 40]} />
          <meshStandardMaterial ref={ringMaterial} color={color} emissive={color} emissiveIntensity={0.4} transparent opacity={0} side={2} />
        </mesh>
      ) : null}

      {/* Selection is a matte violet wireframe plus a base outline, never a
          change of the data colour and never a glow. */}
      {selected ? (
        <>
          <mesh>
            <boxGeometry args={[radius * 1.95, radius * 1.95, radius * 1.95]} />
            <meshBasicMaterial color="#a38bff" wireframe transparent opacity={0.75} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.72, 0]}>
            <ringGeometry args={[radius * 1.02, radius * 1.16, 40]} />
            <meshBasicMaterial color="#a38bff" transparent opacity={0.9} side={2} />
          </mesh>
        </>
      ) : related ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.72, 0]}>
          <ringGeometry args={[radius * 1.0, radius * 1.1, 32]} />
          <meshBasicMaterial color="#a38bff" transparent opacity={0.45} side={2} />
        </mesh>
      ) : null}

      {execOffset !== null && node.execSequence !== null ? (
        <ExecTransition
          atZ={execOffset}
          radius={radius}
          selected={selected}
          selectedEvent={selectedSequence === node.execSequence}
          onSelectEvent={() => onSelectEvent(node.execSequence!, node.execAtMs!, node.key)}
        />
      ) : null}

      {/* A ground disc keeps the node findable in its lane. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.7, 0]}>
        <circleGeometry args={[radius * 0.75, 28]} />
        <meshBasicMaterial color={color} transparent opacity={state.present ? 0.16 : 0} />
      </mesh>
    </group>
  );
}

/**
 * The execvp() image change, marked on one node's lifetime.
 * fork() produced "CAPS child"; execvp() replaced the image in the same PID.
 * The PID never changes, so this is a transition marker and never a new node.
 *
 * It is selectable as evidence, and selecting it selects the recorded event
 * that observed the change: the sequence, the exact recorded time, and the
 * process whose identity was verified. It reports the process too, so the
 * reader is left with both halves of the fact rather than only a highlight.
 */
function ExecTransition({
  atZ,
  radius,
  selected,
  selectedEvent,
  onSelectEvent,
}: {
  atZ: number;
  radius: number;
  selected: boolean;
  selectedEvent: boolean;
  onSelectEvent: () => void;
}) {
  return (
    <group position={[0, 0, Math.max(0, atZ)]}>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onSelectEvent();
        }}
      >
        <torusGeometry args={[1.05, 0.03, 8, 36]} />
        <meshBasicMaterial color="#a38bff" transparent opacity={selectedEvent ? 1 : selected ? 0.95 : 0.55} />
      </mesh>
      {selected || selectedEvent ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.12, 1.24, 32]} />
          <meshBasicMaterial color="#a38bff" transparent opacity={0.8} side={2} />
        </mesh>
      ) : null}
      <mesh visible={false}>
        <sphereGeometry args={[Math.max(0.9, radius * 1.4), 8, 8]} />
        <meshBasicMaterial />
      </mesh>
    </group>
  );
}

/** A bar along Z showing when the process existed, drawn once per node. */
export function LifetimeBars({ space, scale, states }: { space: ProcessSpace; scale: number; states: SpaceNodeState[] }) {
  const byKey = useMemo(() => new Map(states.map((state) => [state.key, state])), [states]);
  return (
    <group>
      {space.nodes.map((node) => {
        const state = byKey.get(node.key);
        if (!state?.present) return null;
        const start = (node.createdAtMs ?? 0) * scale;
        const end = Math.max(start + 0.35, nodeEndZ(node, scale, space.spanMs));
        const length = end - start;
        const base = nodePosition(node, scale);
        // The lifetime bar wears the node's lifecycle colour too, so the whole
        // node -- body, ring and bar -- agrees about what state it is in.
        const color = statePalette(state.state).color;
        return (
          <mesh key={`lifetime-${node.key}`} position={[base.x, base.y + 0.15, start + length / 2]}>
            <boxGeometry args={[0.08, 0.08, length]} />
            <meshBasicMaterial color={color} transparent opacity={state.terminal ? 0.22 : 0.38} />
          </mesh>
        );
      })}
    </group>
  );
}

export interface EdgeEmphasis {
  /** Node keys of verified parents and children of the selection. */
  relatedNodeKeys: string[];
  /** The verified edge keys touching the selection. */
  relatedEdgeKeys: string[];
}

export function ProcessEdges({ space, scale, states, emphasis }: { space: ProcessSpace; scale: number; states: SpaceNodeState[]; emphasis: EdgeEmphasis }) {
  const present = useMemo(() => new Set(states.filter((state) => state.present).map((state) => state.key)), [states]);
  const related = useMemo(() => new Set(emphasis.relatedEdgeKeys), [emphasis.relatedEdgeKeys]);
  const hasSelection = emphasis.relatedNodeKeys.length > 0;
  return (
    <group>
      {space.edges.map((edge) => {
        const isRelated = related.has(edge.key);
        // Only verified edges exist at all. A selection may emphasise the
        // verified parent and child links; unrelated topology stays visible but
        // recedes, so the full scene context is never lost.
        const emphasisFactor = hasSelection ? (isRelated ? 1 : 0.16) : 1;
        return (
          <VerifiedEdge
            key={edge.key}
            edge={edge}
            space={space}
            scale={scale}
            visible={present.has(edge.fromKey) && present.has(edge.toKey)}
            emphasis={emphasisFactor}
          />
        );
      })}
    </group>
  );
}

/**
 * An edge exists only between two observed processes whose relationship the
 * backend verified: the child's observed PPID equals an observed parent PID.
 * There are no decorative, inferred, or "data flow" connections.
 */
function VerifiedEdge({ edge, space, scale, visible, emphasis }: { edge: SpaceEdge; space: ProcessSpace; scale: number; visible: boolean; emphasis: number }) {
  const from = space.byKey.get(edge.fromKey);
  const to = space.byKey.get(edge.toKey);
  const curve = useMemo(() => {
    if (!from || !to) return null;
    const a = nodePosition(from, scale);
    const b = nodePosition(to, scale);
    return new QuadraticBezierCurve3(
      new Vector3(a.x, a.y + 0.7, a.z + NODE_Z_OFFSET),
      new Vector3((a.x + b.x) / 2, (a.y + b.y) / 2 + 1.1, (a.z + b.z) / 2),
      new Vector3(b.x, b.y + 0.7, b.z + NODE_Z_OFFSET),
    );
  }, [from, to, scale]);

  const head = useMemo(() => (curve ? curve.getPoint(1) : null), [curve]);
  if (!curve || !head) return null;

  const emphasised = emphasis > 0.9;
  return (
    <group>
      <mesh>
        <tubeGeometry args={[curve, 20, emphasised ? 0.04 : 0.026, 6, false]} />
        <meshStandardMaterial
          color={emphasised ? "#a38bff" : "#548dff"}
          emissive={emphasised ? "#a38bff" : "#548dff"}
          emissiveIntensity={emphasised ? 0.25 : 0.2}
          transparent
          opacity={(visible ? 0.7 : 0.08) * emphasis}
          roughness={0.4}
        />
      </mesh>
      <mesh position={head}>
        <sphereGeometry args={[emphasised ? 0.075 : 0.055, 12, 12]} />
        <meshBasicMaterial color={emphasised ? "#a38bff" : "#548dff"} transparent opacity={(visible ? 0.9 : 0.12) * emphasis} />
      </mesh>
    </group>
  );
}

interface EventMarkersProps {
  space: ProcessSpace;
  markers: SpaceMarker[];
  scale: number;
  showMarkers: boolean;
  selectedKey: string | null;
  /** Canonical sequence of the selected event, highlighted among the markers. */
  selectedSequence: number | null;
  /** Markers within this distance of the cursor are marked as recent. */
  cursorMs: number | null;
  onSelect: (key: string | null) => void;
  onSelectEvent: (sequence: number, atMs: number, nodeKey: string | null) => void;
}

/**
 * Discrete lifecycle events only. Snapshots update resource state instead;
 * the scene never fills with one floating object per sample.
 *
 * Every marker carries its canonical event sequence, and selecting one moves
 * the shared cursor to that event's own timestamp. No timestamp is synthesised:
 * the marker knows the recorded time of the event it stands for.
 */
export function EventMarkers({ space, markers, scale, showMarkers, selectedKey, selectedSequence, cursorMs, onSelect, onSelectEvent }: EventMarkersProps) {
  if (!showMarkers) return null;
  return (
    <group>
      {markers.map((marker) => {
        const node = marker.nodeKey !== null ? space.byKey.get(marker.nodeKey) : null;
        const base = node ? nodePosition(node, scale) : { x: 0, y: 1.4, z: marker.atMs * scale };
        const color = MARKER_COLORS[marker.tone];
        const active = marker.nodeKey !== null && marker.nodeKey === selectedKey;
        const isSelectedEvent = marker.sequence === selectedSequence;
        const atCursor = cursorMs !== null && Math.abs(marker.atMs - cursorMs) < 1;
        const z = node ? Math.max(marker.atMs * scale, base.z + NODE_Z_OFFSET) : marker.atMs * scale;
        return (
          <mesh
            key={marker.key}
            position={[base.x + 1.1, base.y + 1.15, z]}
            onClick={(event) => {
              event.stopPropagation();
              // The event selection carries the sequence; the process selection
              // carries the verified node this marker belongs to.
              onSelectEvent(marker.sequence, marker.atMs, marker.nodeKey);
              if (marker.nodeKey === null) onSelect(null);
            }}
          >
            <octahedronGeometry args={[isSelectedEvent || active ? 0.15 : 0.095, 0]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={isSelectedEvent ? 0.6 : 0.45}
              transparent
              opacity={isSelectedEvent ? 1 : atCursor ? 0.95 : active ? 0.9 : 0.75}
            />
          </mesh>
        );
      })}
    </group>
  );
}
