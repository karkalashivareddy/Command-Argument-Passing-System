import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Focus, Grid3x3, MousePointerClick, Orbit, RotateCcw, TreePine, TriangleAlert } from "lucide-react";

import { Button, Card, EmptyState } from "../ui";
import { ProcessGraph } from "../execution/ProcessGraph";
import { ProcessTelemetry } from "../execution/ProcessTelemetry";
import { formatMiB, formatPercent } from "../../lib/format";
import {
  LENS_ORDER,
  LENS_SPECS,
  buildProcessSpace,
  lensRawValue,
  lensValue,
  nodeStateAt,
  type MetricMode,
  type SpaceNodeState,
} from "../../lib/processSpace";
import { buildEvidenceIndex, cursorMsForIdentity, resolveSelection, type EvidenceSelection, type ProcessIdentity } from "../../lib/evidenceCorrelation";
import { SpaceErrorBoundary } from "./SpaceErrorBoundary";
import { detectWebGL, usePrefersReducedMotion } from "./webgl";
import { CAMERA_PRESETS, CAMERA_PRESET_ORDER, type CameraPreset, type CameraRequest } from "./SceneChrome";
import { EvidencePanel, ProcessList } from "./ProcessList";
import { NodeTooltip } from "./NodeTooltip";
import { SpaceLegend } from "./SpaceLegend";
import type { HoverPoint } from "./ProcessSpaceScene";
import type { CanonicalEvent, SessionRecord } from "../../types/observability";

/**
 * The 3D canvas is code-split: the rest of the observatory never downloads
 * three.js, and this chunk is only fetched when a reader opens Process Space.
 */
const ObservatoryCanvas = lazy(() => import("./ObservatoryCanvas"));

export type SpaceMode = "topology" | "timeline";

interface ProcessSpaceProps {
  events: CanonicalEvent[];
  session: SessionRecord;
  /** The one shared execution-time cursor, owned by the page. */
  cursorMs: number | null;
  /** True when the cursor is being driven by a reader rather than by live data. */
  cursorActive: boolean;
  live: boolean;
  mode: SpaceMode;
  onModeChange: (mode: SpaceMode) => void;
  /** The shared investigation selection: time, process identity, event sequence. */
  selection: EvidenceSelection;
  lens: MetricMode;
  onLensChange: (lens: MetricMode) => void;
  /** Select a process by its verified identity. Clears any event selection. */
  onSelectProcess: (identity: ProcessIdentity | null) => void;
  /**
   * Select a recorded event together with the process identity it verifiably
   * belongs to, and place the cursor at that event's own timestamp. One call, so
   * a marker or an exec transition can never select a process and an event that
   * disagree with each other.
   */
  onSelectEvidence: (sequence: number | null, identity: ProcessIdentity | null, atMs: number | null) => void;
  onClearSelection: () => void;
}

export function ProcessSpace({
  events,
  session,
  cursorMs,
  cursorActive,
  live,
  mode,
  onModeChange,
  selection,
  lens,
  onLensChange,
  onSelectProcess,
  onSelectEvidence,
  onClearSelection,
}: ProcessSpaceProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [webgl] = useState(detectWebGL);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [preset, setPreset] = useState<CameraPreset>(mode === "topology" ? "orbit" : "timeline");
  /*
   * ONE camera request, not two counters.
   *
   * Reset and focus used to share a single counter, and only the reset effect
   * depended on it, so pressing Focus (or `F`) on an already-selected node
   * re-ran nothing and fell back to the global preset -- the exact opposite of
   * what the button title and the shortcut help promised. `revision` is what
   * the rig watches, so asking twice does the same thing as asking once, and
   * asking for a different thing cannot be mistaken for the other one.
   */
  const [request, setRequest] = useState<CameraRequest>({ kind: "frame", revision: 0 });
  const revision = useRef(0);
  const requestCamera = useCallback((kind: CameraRequest["kind"]) => {
    revision.current += 1;
    setRequest({ kind, revision: revision.current });
  }, []);
  const [followCursor, setFollowCursor] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [hovered, setHovered] = useState<{ key: string; point: HoverPoint } | null>(null);
  const [listHoverKey, setListHoverKey] = useState<string | null>(null);
  const [view, setView] = useState<"scene" | "table">("scene");

  const space = useMemo(() => buildProcessSpace(events), [events]);
  // The correlation index is derived from the same events as the space, so the
  // two can never describe different records.
  const index = useMemo(() => buildEvidenceIndex(events), [events]);
  const resolution = useMemo(() => resolveSelection(selection, index), [selection, index]);
  const states = useMemo(() => space.nodes.map((node) => nodeStateAt(space, cursorMs, node)), [space, cursorMs]);

  // The selection owns which node is selected, so the inspector, the list, the
  // camera, and the table can never disagree about it.
  const selectedKey = resolution.nodeKey;
  // A canvas hover has a pointer position, so it can raise the evidence tooltip.
  // A list or table hover has none, so it only updates the HUD.
  const focusKey = hovered?.key ?? listHoverKey ?? selectedKey;
  const focused = focusKey === null ? null : (states.find((state) => state.key === focusKey) ?? null);
  const hoveredState = hovered === null ? null : (states.find((state) => state.key === hovered.key) ?? null);

  const emphasis = useMemo(
    () => ({ relatedNodeKeys: resolution.relatedNodeKeys, relatedEdgeKeys: resolution.relatedEdgeKeys }),
    [resolution.relatedNodeKeys, resolution.relatedEdgeKeys],
  );

  // The topology/timeline switch is a camera and emphasis change, not a
  // different dataset: both modes read the same evidence.
  useEffect(() => {
    setPreset(mode === "topology" ? "orbit" : "timeline");
    requestCamera("frame");
  }, [mode, requestCamera]);

  const clearSelection = useCallback(() => {
    onSelectProcess(null);
    onSelectEvidence(null, null, null);
    onClearSelection();
  }, [onSelectProcess, onSelectEvidence, onClearSelection]);

  /*
   * Selecting a process is one store write: identity, no event, and the cursor
   * that selection implies.
   *
   * The cursor goes to that process's FIRST RECORDED evidence -- its first procfs
   * sample, or the event that established it when it is never sampled -- so the
   * scene, the list and the inspector all read the same moment. In live the
   * cursor is deliberately left following the newest evidence: pinning it to a
   * single process's first sample would stop a running execution from advancing.
   * Nothing here is local state; `selection` comes from the shared store.
   */
  const selectNodeKey = useCallback(
    (key: string) => {
      const identity = space.byKey.get(key)?.identity ?? null;
      const atMs = identity === null || live ? null : cursorMsForIdentity(identity, index);
      onSelectEvidence(null, identity, atMs);
      // Requested here as well as in the effect below, so clicking the node
      // that is ALREADY selected re-frames it. The effect can only see a
      // selection that changed; the click is the reader asking again.
      requestCamera("focus");
    },
    [space.byKey, index, live, onSelectEvidence, requestCamera],
  );

  const selectMarker = useCallback(
    (sequence: number, atMs: number, nodeKey: string | null) => {
      onSelectEvidence(sequence, nodeKey === null ? null : (space.byKey.get(nodeKey)?.identity ?? null), atMs);
    },
    [space.byKey, onSelectEvidence],
  );

  const choosePreset = useCallback(
    (next: CameraPreset) => {
      setPreset(next);
      requestCamera("frame");
    },
    [requestCamera],
  );

  /** Focus is a no-op with nothing selected: there is nothing to frame. */
  const focusSelected = useCallback(() => {
    if (selectedKey === null) return;
    requestCamera("focus");
  }, [selectedKey, requestCamera]);

  // Choosing a process frames it, from any surface: the canvas, the list or the
  // table. One effect, so all three behave identically.
  useEffect(() => {
    if (selectedKey === null) return;
    requestCamera("focus");
  }, [selectedKey, requestCamera]);

  // Keyboard shortcuts. R and F are scoped to this view; Space, arrows and
  // Escape act on the shared cursor through the page's own handlers.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "r") {
        event.preventDefault();
        requestCamera("frame");
      } else if (key === "f") {
        event.preventDefault();
        focusSelected();
      } else if (event.key === "Escape") {
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection, focusSelected, requestCamera]);

  const unavailable = webgl.supported ? null : webgl.reason;
  const lensSpec = LENS_SPECS[lens];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Mode"
          value={mode}
          options={[
            { value: "topology", label: "Topology" },
            { value: "timeline", label: "Timeline" },
          ]}
          onChange={(value) => onModeChange(value as SpaceMode)}
        />
        <Segmented
          label="Resource lens"
          value={lens}
          options={LENS_ORDER.map((id) => ({ value: id, label: LENS_SPECS[id].label }))}
          onChange={(value) => onLensChange(value as MetricMode)}
        />
        <Segmented
          label="View"
          value={view}
          options={[
            { value: "scene", label: "3D scene" },
            { value: "table", label: "Table" },
          ]}
          onChange={(value) => setView(value as "scene" | "table")}
        />
      </div>

      <p className="rounded border border-[var(--line-0)] bg-[var(--bg-1)] px-3 py-1.5 font-mono text-[9.5px] leading-relaxed text-[var(--fg-3)]">
        <span className="text-[var(--fg-2)]">{lensSpec.label}</span> · {lensSpec.mapping}. {lensSpec.caveat}
      </p>

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="flex items-center gap-1 text-[var(--fg-3)]"><Orbit className="h-3 w-3" /> Camera</span>
        {CAMERA_PRESET_ORDER.map((key) => (
          <Button
            key={key}
            size="sm"
            variant={preset === key ? "primary" : "ghost"}
            onClick={() => choosePreset(key)}
            title={CAMERA_PRESETS[key].meaning}
          >
            {CAMERA_PRESETS[key].label}
          </Button>
        ))}
        <span className="mx-1 h-3 w-px bg-[var(--line-1)]" />
        <Toggle active={followCursor} onClick={() => setFollowCursor((value) => !value)} label="Follow cursor" />
        <Toggle active={showMarkers} onClick={() => setShowMarkers((value) => !value)} label="Event markers" />
        <Toggle active={showLabels} onClick={() => setShowLabels((value) => !value)} label="HUD labels" />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Button size="sm" variant="ghost" onClick={() => requestCamera("frame")} title="Reframe the whole record from the current preset (R)">
          <RotateCcw className="h-3 w-3" /> Reset view
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={focusSelected}
          disabled={selectedKey === null}
          title={selectedKey === null ? "Select a process first (F)" : "Frame the selected process (F)"}
        >
          <Focus className="h-3 w-3" /> Focus selected
        </Button>
        <Button size="sm" variant="ghost" onClick={() => choosePreset("tree")} title="Fit the whole observed process tree, looking down the time axis">
          <TreePine className="h-3 w-3" /> Fit process tree
        </Button>
        <span className="ml-auto flex items-center gap-1 font-mono text-[9.5px] text-[var(--fg-4)]">
          <MousePointerClick className="h-3 w-3" />
          R reframes · F frames the selection · camera moves are eased, never cut
        </span>
      </div>

      {view === "scene" ? (
        <div className="relative overflow-hidden rounded-[var(--r-md)] border border-[var(--line-1)] bg-[var(--bg-0)]">
          <div className="h-[clamp(22rem,58vh,40rem)] w-full">
            {unavailable !== null || failure !== null ? (
              <Fallback reason={unavailable ?? failure!} sessionId={session.id} onRetry={failure === null ? undefined : () => { setFailure(null); setRetry((token) => token + 1); }} events={events} />
            ) : (
              <SpaceErrorBoundary onError={setFailure} resetKey={retry}>
                <Suspense fallback={<div className="flex h-full items-center justify-center text-[12px] text-[var(--fg-3)]">Loading the 3D renderer…</div>}>
                  <ObservatoryCanvas
                    space={space}
                    states={states}
                    cursorMs={cursorMs}
                    cursorActive={cursorActive}
                    mode={lens}
                    preset={preset}
                    request={request}
                    followCursor={followCursor}
                    showMarkers={showMarkers}
                    reducedMotion={reducedMotion}
                    selectedKey={selectedKey}
                    emphasis={emphasis}
                    selectedSequence={resolution.markerSequence}
                    onSelect={(key) => (key === null ? clearSelection() : selectNodeKey(key))}
                    onHover={(key, point) => setHovered(key === null || point === null ? null : { key, point })}
                    onSelectEvent={selectMarker}
                    onLost={setFailure}
                  />
                </Suspense>
              </SpaceErrorBoundary>
            )}
          </div>

          {showLabels ? (
            <>
              <Hud corner="topLeft" label="Process space" value={`Execution ${session.id.slice(-6)}`} sub={session.command} />
              <Hud corner="topRight" label={live ? "Live" : "Replay"} value={live ? "LIVE" : "REPLAY"} sub={live ? "streaming real events" : "persisted execution evidence"} tone={live ? "cyan" : "violet"} />
              {focused ? (
                <NodeHud state={focused} cursorMs={cursorMs} lens={lens} selected={focused.key === selectedKey} />
              ) : (
                <Hud corner="bottom" label="No process selected" value="click a node, list row, or event marker" sub="hover for its recorded values" />
              )}
            </>
          ) : null}
        </div>
      ) : (
        <NodeTable
          states={states}
          lens={lens}
          selectedKey={selectedKey}
          relatedKeys={resolution.relatedNodeKeys}
          onSelect={selectNodeKey}
        />
      )}

      {/* The hover evidence tooltip follows the pointer by direct style writes,
          so pointer movement never re-renders React. */}
      <NodeTooltip state={hoveredState} point={hovered?.point ?? null} lens={lens} selected={hovered !== null && hovered.key === selectedKey} />

      <ProcessList
        states={states}
        index={index}
        resolution={resolution}
        lens={lens}
        selectedNodeKey={selectedKey}
        onSelect={selectNodeKey}
        onHover={setListHoverKey}
        onClear={clearSelection}
      />

      <EvidencePanel
        resolution={resolution}
        selection={selection}
        index={index}
        selectedNodeKey={selectedKey}
        sessionId={session.id}
        onClear={clearSelection}
      />

      <SpaceLegend lens={lens} />

      {/* The honest limits of this record, stated where they are seen. A
          fork-tree workload shows two nodes, and the reader is told why. */}
      {space.limitations.length > 0 ? (
        <ul className="space-y-1 rounded border border-[var(--line-0)] bg-[var(--bg-1)] px-3 py-2 font-mono text-[9.5px] leading-relaxed text-[var(--fg-3)]">
          {space.limitations.map((note) => (
            <li key={note} className="flex gap-2">
              <span aria-hidden="true" className="text-[var(--amber)]">▲</span>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {resolution.unresolved.length > 0 ? (
        <ul className="space-y-1 rounded border border-[var(--line-0)] bg-[var(--bg-1)] px-3 py-2 text-[10.5px] text-[var(--fg-2)]">
          {resolution.unresolved.map((note) => (
            <li key={note} className="flex gap-2">
              <TriangleAlert className="mt-px h-3 w-3 shrink-0 text-[var(--amber)]" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {focused && focused.key === selectedKey ? (
        <Card
          title={`${focused.node.pid === null ? "PID UNAVAILABLE" : `PID ${focused.node.pid}`} · ${focused.node.label}`}
          subtitle={
            focused.node.role === "child"
              ? `fork() created this process; execvp() replaced its image${focused.node.imageAfter ? ` with ${focused.node.imageAfter}` : ""}. The PID never changes.`
              : "The gateway-spawned CAPS engine. No procfs sample is collected for it, so it has no resource values."
          }
        >
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[11.5px] sm:grid-cols-4">
            <Field label="State" value={focused.state} />
            <Field label="Depth" value={String(focused.node.depth)} />
            <Field label="Parent PID" value={focused.node.parentVerified ? String(focused.node.parentPid) : "UNAVAILABLE"} />
            <Field label="Sample age" value={focused.stateAgeMs === null ? "UNAVAILABLE" : `${(focused.stateAgeMs / 1000).toFixed(2)} s`} />
            <Field label="Process start" value={focused.node.identity?.processStartTime ?? "UNAVAILABLE"} />
            <Field label="execvp() at" value={focused.node.execAtMs === null ? "UNAVAILABLE" : `${(focused.node.execAtMs / 1000).toFixed(2)} s`} />
          </dl>
        </Card>
      ) : null}

      {/* The same cursor-driven inspector the 2D observatory uses, narrowed to
          the selected process. No second inspector model exists for the 3D view. */}
      <ProcessTelemetry events={events} replay={!live} cursorMs={cursorMs} identity={resolution.identity} />
    </div>
  );
}

function Fallback({ reason, sessionId, onRetry, events }: { reason: string; sessionId: string; onRetry?: () => void; events: CanonicalEvent[] }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <EmptyState
        icon={<TriangleAlert className="h-5 w-5" />}
        title="3D visualization unavailable"
        body={`Reason: ${reason} The 2D Process Observatory remains available and shows the same recorded evidence.`}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onRetry ? (
              <Button size="sm" variant="outline" onClick={onRetry}>
                Retry 3D
              </Button>
            ) : null}
            <Link to={`/execution/${sessionId}`}>
              <Button size="sm" variant="primary">
                <Grid3x3 className="h-3 w-3" /> Open 2D process graph
              </Button>
            </Link>
          </div>
        }
      />
      <div className="w-full max-w-2xl rounded border border-[var(--line-0)] bg-[var(--bg-1)] p-3 text-left">
        <ProcessGraph events={events} />
      </div>
    </div>
  );
}

function Hud({ label, value, sub, tone, corner }: { label: string; value: string; sub?: string; tone?: "cyan" | "violet"; corner?: "topLeft" | "topRight" | "bottom" }) {
  const position =
    corner === "topRight" ? "right-3 top-3 text-right" : corner === "bottom" ? "bottom-3 left-3" : "left-3 top-3";
  return (
    <div className={`pointer-events-none absolute ${position} rounded border border-[var(--line-1)] bg-[var(--bg-1)]/90 px-2.5 py-1.5 font-mono`}>
      <div className="text-[8.5px] uppercase tracking-[0.14em] text-[var(--fg-3)]">{label}</div>
      <div className={`text-[12px] font-semibold ${tone === "cyan" ? "text-[var(--accent)]" : tone === "violet" ? "text-[var(--violet)]" : "text-[var(--fg-0)]"}`}>{value}</div>
      {sub ? <div className="text-[9px] text-[var(--fg-3)]">{sub}</div> : null}
    </div>
  );
}

/** Bottom HUD: the recorded values of the hovered or selected process. */
function NodeHud({ state, cursorMs, lens, selected }: { state: SpaceNodeState; cursorMs: number | null; lens: MetricMode; selected: boolean }) {
  const spec = LENS_SPECS[lens];
  const raw = lensRawValue(state, lens);
  const bounded = lensValue(state, lens);
  const unavailable = raw === null;
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-[var(--line-1)] bg-[var(--bg-1)]/90 px-2.5 py-1.5 font-mono text-[10.5px] text-[var(--fg-1)]">
      <span className="text-[var(--fg-3)]">PID</span>
      <span className="text-[var(--fg-0)]">{state.node.pid ?? "UNAVAILABLE"}</span>
      <span className="text-[var(--fg-3)]">{spec.metric.toUpperCase()}</span>
      <span className={unavailable ? "text-[var(--amber)]" : "text-[var(--accent)]"}>
        {unavailable ? "UNAVAILABLE" : formatLensValue(spec.metric, raw)}
      </span>
      <span className="text-[var(--fg-4)]">{spec.unit}</span>
      <span className="text-[var(--fg-3)]">MAPPED</span>
      <span className="text-[var(--fg-3)]">{bounded === null ? "n/a" : `${(bounded * 100).toFixed(0)}%`}</span>
      <span className="text-[var(--fg-3)]">TIME</span>
      <span className="text-[var(--fg-2)]">{cursorMs === null ? "live" : `${(cursorMs / 1000).toFixed(2)} s`}</span>
      <span className="text-[var(--fg-3)]">STATE</span>
      <span className="text-[var(--fg-0)]">{state.state}</span>
      {selected ? <span className="text-[var(--violet)]">◆ selected</span> : null}
    </div>
  );
}

function formatLensValue(metric: "rss" | "cpu" | "io" | "faults", value: number): string {
  if (metric === "rss") return formatMiB(value);
  if (metric === "cpu") return formatPercent(value);
  return value.toFixed(0);
}

/** §75: the same information must exist as ordinary DOM content. */
function NodeTable({
  states,
  lens,
  selectedKey,
  relatedKeys,
  onSelect,
}: {
  states: SpaceNodeState[];
  lens: MetricMode;
  selectedKey: string | null;
  relatedKeys: string[];
  onSelect: (key: string) => void;
}) {
  const spec = LENS_SPECS[lens];
  return (
    <div className="overflow-x-auto rounded-[var(--r-md)] border border-[var(--line-1)]">
      <table className="w-full min-w-[46rem] border-collapse text-left font-mono text-[11.5px]">
        <caption className="sr-only">Observed processes for this execution at the shared cursor</caption>
        <thead>
          <tr className="border-b border-[var(--line-1)] text-[9.5px] uppercase tracking-wide text-[var(--fg-3)]">
            <Th>Process</Th>
            <Th>Role</Th>
            <Th>Command</Th>
            <Th>State</Th>
            <Th>Parent</Th>
            <Th>{spec.metric.toUpperCase()}</Th>
            <Th>Mapped</Th>
            <Th>Lifetime</Th>
            <Th>execvp()</Th>
          </tr>
        </thead>
        <tbody>
          {states.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-3 py-4 text-[var(--fg-3)]">
                No process was observed in this record.
              </td>
            </tr>
          ) : null}
          {states.map((state) => {
            const raw = lensRawValue(state, lens);
            const bounded = lensValue(state, lens);
            const selected = state.key === selectedKey;
            const related = relatedKeys.includes(state.key) && !selected;
            return (
              <tr
                key={state.key}
                className={`border-b border-[var(--line-0)] ${selected ? "bg-[var(--violet-soft)]" : related ? "bg-[var(--bg-2)]" : "text-[var(--fg-1)]"}`}
              >
                <Td>
                  <button
                    type="button"
                    onClick={() => onSelect(state.key)}
                    aria-pressed={selected}
                    className="text-left text-[var(--fg-0)] underline decoration-dotted underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  >
                    {state.node.pid ?? "PID UNAVAILABLE"}
                  </button>
                </Td>
                <Td>{state.node.role}</Td>
                <Td>{state.node.imageAfter ?? state.node.label}</Td>
                <Td>{state.present ? state.state : "not started"}</Td>
                <Td>{state.node.parentVerified ? state.node.parentPid : "UNAVAILABLE"}</Td>
                <Td>{raw === null ? <span className="italic text-[var(--fg-4)]">UNAVAILABLE</span> : formatLensValue(spec.metric, raw)}</Td>
                <Td>{bounded === null ? "n/a" : `${(bounded * 100).toFixed(0)}%`}</Td>
                <Td>
                  {state.node.createdAtMs === null
                    ? "UNAVAILABLE"
                    : `${(state.node.createdAtMs / 1000).toFixed(2)}s → ${state.node.endedAtMs === null ? "running" : `${(state.node.endedAtMs / 1000).toFixed(2)}s`}`}
                </Td>
                <Td>{state.node.execAtMs === null ? "n/a" : `${(state.node.execAtMs / 1000).toFixed(2)}s`}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-3 py-2 font-semibold">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-1.5">{children}</td>;
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-wide text-[var(--fg-3)]">{label}</dt>
      <dd className="text-[var(--fg-0)]">{value}</dd>
    </div>
  );
}

/** §33: the legend that keeps the encoding unambiguous. */
function Segmented({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  // aria-labelledby takes a space-separated id *list*, so the generated id has
  // to be a single token. A multi-word label would otherwise resolve to nothing
  // and the group would be announced without a name.
  const labelId = `seg-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--fg-3)]" id={labelId}>
        {label}
      </span>
      {/* Grouped and labelled so assistive technology can announce which set of
          controls it is in: the mode switch is not a camera preset. */}
      <div role="group" aria-labelledby={labelId} className="flex overflow-hidden rounded border border-[var(--line-1)]">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={`px-2.5 py-1 font-mono text-[10.5px] transition-colors ${value === option.value ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--bg-2)] text-[var(--fg-3)] hover:text-[var(--fg-1)]"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded border px-2 py-1 font-mono text-[10.5px] transition-colors ${active ? "border-[var(--line-2)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--line-0)] text-[var(--fg-3)] hover:text-[var(--fg-1)]"}`}
    >
      {label}
    </button>
  );
}
