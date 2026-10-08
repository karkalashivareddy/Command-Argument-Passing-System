import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { ACESFilmicToneMapping, SRGBColorSpace } from "three";

import type { MetricMode, ProcessSpace, SpaceNodeState } from "../../lib/processSpace";
import { CameraRig, CursorPlane, ExecutionGrid, SelectionRing, sceneDepth, sceneWidth, spaceTimeScale, type CameraPreset, type CameraRequest } from "./SceneChrome";
import { EventMarkers, LifetimeBars, ProcessEdges, ProcessNodeMesh, type EdgeEmphasis, type HoverPoint } from "./ProcessSpaceScene";

export interface ObservatoryCanvasProps {
  space: ProcessSpace;
  states: SpaceNodeState[];
  cursorMs: number | null;
  cursorActive: boolean;
  mode: MetricMode;
  preset: CameraPreset;
  /** What the camera should frame next: reset, a preset change, or the selection. */
  request: CameraRequest;
  followCursor: boolean;
  showMarkers: boolean;
  reducedMotion: boolean;
  selectedKey: string | null;
  /** Verified hierarchy around the selection, for edge emphasis. */
  emphasis: EdgeEmphasis;
  /** Canonical sequence of the selected event, highlighted among the markers. */
  selectedSequence: number | null;
  onSelect: (key: string | null) => void;
  onHover: (key: string | null, point: HoverPoint | null) => void;
  onSelectEvent: (sequence: number, atMs: number, nodeKey: string | null) => void;
  onReady?: () => void;
  onLost?: (reason: string) => void;
}

/**
 * The WebGL surface. Data arrives as props from the shared view-model; this
 * component only renders it. No polling, no requestAnimationFrame-driven data
 * updates, and no per-frame React state: the render loop animates existing
 * three.js objects through refs.
 */
export default function ObservatoryCanvas({
  space,
  states,
  cursorMs,
  cursorActive,
  mode,
  preset,
  request,
  followCursor,
  showMarkers,
  reducedMotion,
  selectedKey,
  emphasis,
  selectedSequence,
  onSelect,
  onHover,
  onSelectEvent,
  onReady,
  onLost,
}: ObservatoryCanvasProps) {
  const scale = useMemo(() => spaceTimeScale(space), [space]);
  const width = useMemo(() => sceneWidth(space), [space]);
  const depth = useMemo(() => sceneDepth(space, scale), [space, scale]);
  const canvasHost = useRef<HTMLDivElement | null>(null);

  // WebGL context loss: report it, so the page can offer a 2D fallback instead
  // of leaving a dead rectangle on screen. The listener is attached natively
  // (not through React's synthetic events, which do not cover this event) after
  // the canvas exists, and is removed with the component.
  useEffect(() => {
    const canvas = canvasHost.current?.querySelector("canvas");
    if (!canvas) return;
    const handleLost = (event: Event) => {
      event.preventDefault();
      onLost?.("The WebGL context was lost. The 3D scene stopped rendering.");
    };
    canvas.addEventListener("webglcontextlost", handleLost);
    return () => canvas.removeEventListener("webglcontextlost", handleLost);
  }, [onLost]);

  return (
    <div ref={canvasHost} className="h-full w-full" data-testid="observatory-canvas-host">
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance", failIfMajorPerformanceCaveat: false }}
        camera={{ position: [13, 10, 21], fov: 45, near: 0.1, far: 400 }}
        onCreated={({ gl }) => {
          gl.toneMapping = ACESFilmicToneMapping;
          gl.outputColorSpace = SRGBColorSpace;
          onReady?.();
        }}
        onPointerMissed={() => onSelect(null)}
        frameloop={reducedMotion ? "demand" : "always"}
      >
        <color attach="background" args={["#07090d"]} />
        <fog attach="fog" args={["#07090d", 45, 150]} />

        {/* Subtle lighting: ambient for legibility, one directional key. */}
        <ambientLight intensity={0.55} />
        <directionalLight position={[12, 18, 10]} intensity={0.7} />

        <Suspense fallback={null}>
          <ExecutionGrid space={space} scale={scale} />
          <LifetimeBars space={space} scale={scale} states={states} />
          <ProcessEdges space={space} scale={scale} states={states} emphasis={emphasis} />
          {states.map((state) => (
            <ProcessNodeMesh
              key={state.key}
              state={state}
              scale={scale}
              mode={mode}
              selected={state.key === selectedKey}
              related={emphasis.relatedNodeKeys.includes(state.key)}
              reducedMotion={reducedMotion}
              selectedSequence={selectedSequence}
              onSelect={onSelect}
              onHover={onHover}
              onSelectEvent={onSelectEvent}
            />
          ))}
          <EventMarkers
            space={space}
            markers={space.markers}
            scale={scale}
            showMarkers={showMarkers}
            selectedKey={selectedKey}
            selectedSequence={selectedSequence}
            cursorMs={cursorActive ? cursorMs : null}
            onSelect={onSelect}
            onSelectEvent={onSelectEvent}
          />
          <CursorPlane cursorMs={cursorMs} scale={scale} active={cursorActive} width={width} depth={depth} />
          {selectedKey ? <SelectionRing space={space} nodeKey={selectedKey} scale={scale} reducedMotion={reducedMotion} /> : null}
          <CameraRig
            space={space}
            preset={preset}
            request={request}
            followCursor={followCursor}
            cursorMs={cursorMs}
            selectedKey={selectedKey}
            reducedMotion={reducedMotion}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}
