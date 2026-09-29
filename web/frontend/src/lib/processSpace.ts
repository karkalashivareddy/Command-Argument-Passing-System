import type { CanonicalEvent, ProcessVisualState, TelemetryMetric } from "../types/observability";
import { buildVisualState, collectSamples, visualStatePeaks, type TelemetrySample } from "./telemetry";
import { nodeKeyFor, nodeKeyForRole, type ProcessIdentity } from "./evidenceCorrelation";

/**
 * Process Space — the pure, deterministic 3D view-model.
 *
 * This module contains no WebGL, no React, and no randomness. It turns the
 * canonical events the observatory already holds into a spatial description of
 * one execution, so both the 2D and the 3D views read the same evidence and
 * the 3D scene never becomes a second source of telemetry.
 *
 * COORDINATE SEMANTICS (one fixed mapping, used by every camera preset)
 *   X = lane        deterministic sibling slot, depth-first, spread evenly
 *   Y = depth       process-tree depth; 0 = gateway-spawned CAPS engine
 *   Z = time        milliseconds of execution time, origin = first event
 *
 * Time lives on Z so the XY plane is a readable process tree and the scene
 * still has a temporal axis. Lifetimes are drawn as bars along Z, and the
 * shared cursor is a plane perpendicular to Z.
 *
 * NOTHING HERE IS INVENTED. A node exists only for a PID the backend actually
 * observed. An edge exists only when an observed PPID equals an observed
 * parent PID. Resource values come from recorded snapshots only.
 */

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type SpaceRole = "caps-engine" | "child";

/** The semantic visual states a node can hold. Mapped from canonical events. */
export type SpaceLifecycleState =
  | "PENDING"
  | "STARTING"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "SIGNALED"
  | "TIMED_OUT"
  | "CANCELLED";

export interface SpaceNode {
  /** Stable identity for React keys, selection, and edge lookup. */
  key: string;
  /**
   * The process this node stands for, as strong as the record allows: session
   * id, PID, and the derived kernel start time. A node key is a view key; all
   * correlation runs through the identity and its start-time guard.
   */
  identity: ProcessIdentity | null;
  role: SpaceRole;
  pid: number | null;
  /** Human label for the node. Never a fabricated command line. */
  label: string;
  /** The program image observed after execvp(), when one was recorded. */
  command: string | null;
  /** The program image before exec: the CAPS child that fork() produced. */
  imageBefore: string | null;
  imageAfter: string | null;
  /** Execution time of the execvp() image change, when the record supports it. */
  execAtMs: number | null;
  /** Canonical sequence of that image change, for event correlation. */
  execSequence: number | null;
  /** True only when an observed PPID matched this node's parent PID. */
  parentVerified: boolean;
  parentKey: string | null;
  parentPid: number | null;
  depth: number;
  /** Deterministic lane on X. */
  slot: number;
  createdAtMs: number | null;
  endedAtMs: number | null;
  /** Sequence of the event that created the node, for stable ordering. */
  createdSequence: number;
  /** Why procfs telemetry is absent for this node, when it is. */
  telemetryNote: string | null;
}

export interface SpaceEdge {
  key: string;
  fromKey: string;
  toKey: string;
  fromPid: number | null;
  toPid: number | null;
  /** Always "OBSERVED": the edge is drawn only for a verified relationship. */
  provenance: "OBSERVED · PPID match";
  createdAtMs: number | null;
}

export type SpaceMarkerKind = "lifecycle" | "signal" | "exec" | "execution";

export interface SpaceMarker {
  key: string;
  kind: SpaceMarkerKind;
  type: CanonicalEvent["type"];
  label: string;
  tone: "cyan" | "violet" | "green" | "amber" | "red";
  atMs: number;
  sequence: number;
  /** Which node the marker belongs to, when the record identifies one. */
  nodeKey: string | null;
  pid: number | null;
  /** The signal number, for a signal.received marker only. */
  signal: number | null;
  detail: string | null;
}

export interface SpaceRuler {
  /** Ruler ticks in execution milliseconds. */
  ticksMs: number[];
  spanMs: number;
  stepMs: number;
}

export interface ProcessSpace {
  sessionId: string | null;
  nodes: SpaceNode[];
  /** Key-indexed view of `nodes`, so the scene never scans the array per frame. */
  byKey: Map<string, SpaceNode>;
  edges: SpaceEdge[];
  /** Key-indexed view of `edges`. */
  edgesByKey: Map<string, SpaceEdge>;
  markers: SpaceMarker[];
  /** Sequence-indexed view of `markers`, for event selection. */
  markersBySequence: Map<number, SpaceMarker>;
  /**
   * The exit/exec_error marker per node, indexed once. Cursor state is derived
   * for every node on every cursor move, so this lookup must not scan markers.
   */
  terminalMarkerByKey: Map<string, SpaceMarker>;
  /**
   * The signal number that terminated each node, keyed by node key.
   *
   * Per node, and only for the node the signal event actually names. The
   * previous field was a single record-wide `hasSignalMarker` boolean, so a
   * record containing one signalled process marked *every* node without a
   * terminal marker as SIGNALED -- a fabricated claim about processes that
   * exited normally.
   */
  signalByKey: Map<string, { signal: number; sequence: number }>;
  ruler: SpaceRuler;
  /** Execution-time origin: the timestamp of the first event. */
  originTimestamp: string | null;
  spanMs: number;
  /** Terminal execution state, when the record contains one. */
  terminal: { type: CanonicalEvent["type"]; state: SpaceLifecycleState; atMs: number } | null;
  /** Sessions whose telemetry exists, keyed by PID for visual-state lookup. */
  visualStates: Map<number, ProcessVisualState[]>;
  /**
   * Every recorded sample time, ascending and de-duplicated. Replay steps to
   * recorded moments only, so the list is built once instead of being re-scanned
   * on every keyboard press.
   */
  sampleTimesMs: number[];
  /** Explicit notes about what the record does not contain. */
  limitations: string[];
  /** Human summary used by the HUD and the accessible table. */
  counts: { nodes: number; verifiedEdges: number; markers: number; samples: number };
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function metricNumber(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const metric = value as Partial<TelemetryMetric<number>>;
  if (metric.provenance === "UNAVAILABLE") return null;
  return typeof metric.value === "number" && Number.isFinite(metric.value) ? metric.value : null;
}

function metricText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const metric = value as Partial<TelemetryMetric<string>>;
  if (metric.provenance === "UNAVAILABLE") return null;
  return typeof metric.value === "string" && metric.value.length > 0 ? metric.value : null;
}

/**
 * The only canonical events that end an execution. `CANCELLED` is a session
 * status in this system, not an event type, so no event can produce it and the
 * scene never invents one.
 */
const EXECUTION_TERMINALS = new Set<CanonicalEvent["type"]>(["execution.completed", "execution.failed", "execution.timeout"]);

function timeOrigin(events: CanonicalEvent[]): { base: number; origin: string | null } {
  if (events.length === 0) return { base: 0, origin: null };
  const base = new Date(events[0]!.timestamp).getTime();
  return { base, origin: events[0]!.timestamp };
}

function atMsOf(event: CanonicalEvent, base: number): number {
  return Math.max(0, new Date(event.timestamp).getTime() - base);
}

/** A ruler step that yields roughly 4-8 labels across the real span. */
export function rulerStep(spanMs: number): number {
  const candidates = [250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
  for (const step of candidates) if (spanMs / step <= 8) return step;
  return candidates[candidates.length - 1]!;
}

export function buildRuler(spanMs: number): SpaceRuler {
  const span = Math.max(1000, spanMs);
  const step = rulerStep(span);
  const ticks: number[] = [];
  for (let t = 0; t <= span + step / 2; t += step) ticks.push(Math.round(t));
  return { ticksMs: ticks, spanMs, stepMs: step };
}

// ---------------------------------------------------------------------------
// Node construction — only observed identities
// ---------------------------------------------------------------------------

interface RawNode {
  key: string;
  role: SpaceRole;
  pid: number | null;
  label: string;
  parentPid: number | null;
  /** The PPID the collector actually observed for this PID, if any. */
  observedPpid: number | null;
  createdAtMs: number | null;
  createdSequence: number;
  command: string | null;
  imageBefore: string | null;
  imageAfter: string | null;
  execAtMs: number | null;
  execSequence: number | null;
  endedAtMs: number | null;
  endSequence: number | null;
  /** DERIVED kernel start time, when a procfs snapshot carried one. */
  processStartTime: string | null;
  telemetryNote: string | null;
}

function engineKey(pid: number | null): string {
  return nodeKeyForRole("caps-engine", pid);
}

function childKey(pid: number | null): string {
  return nodeKeyForRole("child", pid);
}

/**
 * Re-key every node to the same semantic key the correlation layer uses.
 *
 * The raw node set is collected per `role:pid` because that is all a
 * `process.started` event carries. Once the procfs samples have supplied a
 * kernel start time, the node can be keyed the way the 2D timeline keys it:
 * `role:pid@start`. The two surfaces must agree on this key, or a reader who
 * selects a process in one view and looks for it in the other finds nothing --
 * which is the "3D and 2D reach different conclusions" failure the equivalence
 * test guards.
 */
function rekeyNodes(nodes: RawNode[]): RawNode[] {
  return nodes.map((node) => {
    if (node.pid === null) return node;
    const key = nodeKeyFor({ pid: node.pid, role: node.role, processStartTime: node.processStartTime });
    return key === null || key === node.key ? node : { ...node, key };
  });
}

/**
 * Builds the raw node set from the canonical record. Only PIDs the backend
 * actually reported become nodes:
 *   - the gateway-spawned CAPS engine (child_process.spawn, and the PPID the
 *     collector observed for the target), and
 *   - every process reported by process.started, with procfs snapshots matched
 *     to it by PID.
 */
function collectRawNodes(events: CanonicalEvent[], base: number): RawNode[] {
  const nodes = new Map<string, RawNode>();

  // ---- one node per observed process.started -------------------------------
  const starts = events.filter((ev) => ev.type === "process.started" && typeof ev.pid === "number");
  for (const startEvent of starts) {
    const pid = startEvent.pid as number;
    const label = typeof startEvent.payload.label === "string" ? startEvent.payload.label : "CAPS child";
    nodes.set(childKey(pid), {
      key: childKey(pid),
      role: "child",
      pid,
      label,
      parentPid: null,
      observedPpid: null,
      createdAtMs: Math.max(0, atMsOf(startEvent, base)),
      createdSequence: startEvent.sequence,
      command: null,
      imageBefore: "CAPS child",
      imageAfter: null,
      execAtMs: null,
      execSequence: null,
      endedAtMs: null,
      endSequence: null,
      processStartTime: null,
      telemetryNote: null,
    });
  }

  // ---- per-PID observation: engine PID, PPID, command, exec time, end ------
  const byPid = new Map<number, CanonicalEvent[]>();
  let enginePid: number | null = null;
  for (const event of events) {
    if (event.type === "process.snapshot") {
      const payload = event.payload as Record<string, unknown>;
      const pid = metricNumber(payload.pid);
      if (pid !== null) {
        const list = byPid.get(pid) ?? [];
        list.push(event);
        byPid.set(pid, list);
      }
      enginePid = metricNumber(payload.capsEnginePid) ?? enginePid;
    }
  }

  for (const [pid, snapshots] of byPid) {
    const node = nodes.get(childKey(pid));
    if (!node) continue; // a sampled PID with no process.started record
    for (const snapshot of snapshots) {
      const payload = snapshot.payload as Record<string, unknown>;
      node.observedPpid = metricNumber(payload.ppid) ?? node.observedPpid;
      node.processStartTime = metricText(payload.startTime) ?? node.processStartTime;
      const command = metricText(payload.command);
      if (command !== null && node.imageAfter === null) {
        node.imageAfter = command;
        node.command = command;
        node.execAtMs = atMsOf(snapshot, base);
        node.execSequence = snapshot.sequence;
      }
    }
  }

  // ---- the CAPS engine node ----------------------------------------------
  if (enginePid !== null) {
    const executionStart = events.find((event) => event.type === "execution.started" || event.type === "execution.created");
    nodes.set(engineKey(enginePid), {
      key: engineKey(enginePid),
      role: "caps-engine",
      pid: enginePid,
      label: "CAPS engine",
      parentPid: null,
      observedPpid: null,
      createdAtMs: executionStart ? atMsOf(executionStart, base) : 0,
      createdSequence: executionStart?.sequence ?? 0,
      command: null,
      imageBefore: null,
      imageAfter: null,
      execAtMs: null,
      execSequence: null,
      endedAtMs: null,
      endSequence: null,
      processStartTime: null,
      telemetryNote: "No procfs sample is collected for the gateway-spawned CAPS engine; only the target is sampled.",
    });
  }

  // ---- terminal times and verified parents --------------------------------
  // Per process, not per record. The previous code took the *first*
  // process.exited in the whole stream and applied it to whichever node
  // matched its pid, so in a record with two children the second one was never
  // given an end time and stayed rendered as RUNNING for the rest of the
  // session -- a false statement about a process that had already been reaped.
  const endEventByPid = new Map<number, CanonicalEvent>();
  for (const event of events) {
    if (event.type !== "process.exited" && event.type !== "process.exec_error" && event.type !== "process.wait_failed") continue;
    if (typeof event.pid !== "number") continue;
    // The first terminal event for a pid is that process's end; a later one
    // for the same pid is not a new process end.
    if (!endEventByPid.has(event.pid)) endEventByPid.set(event.pid, event);
  }
  for (const node of nodes.values()) {
    if (node.role !== "child") continue;
    const end = typeof node.pid === "number" ? endEventByPid.get(node.pid) ?? null : null;
    if (end) {
      node.endedAtMs = atMsOf(end, base);
      node.endSequence = end.sequence;
    }
    // An edge requires an observed PPID that equals an observed engine PID.
    if (enginePid !== null && node.observedPpid !== null) node.parentPid = node.observedPpid === enginePid ? enginePid : null;
  }

  return [...nodes.values()];
}

function orderNodes(raw: RawNode[], sessionId: string): SpaceNode[] {
  const engine = raw.filter((node) => node.role === "caps-engine");
  const children = raw.filter((node) => node.role === "child");

  // Deterministic sibling order: creation sequence, then PID ascending.
  const byCreation = (a: RawNode, b: RawNode): number =>
    a.createdAtMs !== b.createdAtMs
      ? (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)
      : a.createdSequence - b.createdSequence || (a.pid ?? 0) - (b.pid ?? 0);

  engine.sort(byCreation);
  children.sort(byCreation);

  const nodes: SpaceNode[] = [];
  engine.forEach((node, slot) => {
    nodes.push({
      key: node.key,
      identity: {
        sessionId: sessionId,
        pid: node.pid as number,
        processStartTime: node.processStartTime,
        role: "caps-engine",
      },
      role: node.role,
      pid: node.pid,
      label: node.label,
      command: node.command,
      imageBefore: node.imageBefore,
      imageAfter: node.imageAfter,
      execAtMs: node.execAtMs,
      execSequence: node.execSequence,
      parentVerified: false,
      parentKey: null,
      parentPid: null,
      depth: 0,
      slot,
      createdAtMs: node.createdAtMs,
      endedAtMs: node.endedAtMs,
      createdSequence: node.createdSequence,
      telemetryNote: node.telemetryNote,
    });
  });
  children.forEach((node, slot) => {
    const parent = engine.find((candidate) => candidate.pid === node.parentPid) ?? null;
    nodes.push({
      key: node.key,
      identity: {
        sessionId: sessionId,
        pid: node.pid as number,
        processStartTime: node.processStartTime,
        role: "child",
      },
      role: node.role,
      pid: node.pid,
      label: node.label,
      command: node.command,
      imageBefore: node.imageBefore,
      imageAfter: node.imageAfter,
      execAtMs: node.execAtMs,
      execSequence: node.execSequence,
      parentVerified: parent !== null,
      parentKey: parent?.key ?? null,
      parentPid: parent?.pid ?? null,
      depth: parent !== null ? 1 : 0,
      slot,
      createdAtMs: node.createdAtMs,
      endedAtMs: node.endedAtMs,
      createdSequence: node.createdSequence,
      telemetryNote: node.telemetryNote,
    });
  });
  return nodes;
}

// ---------------------------------------------------------------------------
// Markers — discrete lifecycle events only, never one per snapshot
// ---------------------------------------------------------------------------

const MARKER_TONES: Record<string, SpaceMarker["tone"]> = {
  "execution.created": "cyan",
  "execution.started": "cyan",
  "process.started": "cyan",
  "redirection.opened": "cyan",
  "redirection.failed": "amber",
  "signal.received": "amber",
  "process.exited": "green",
  "process.exec_error": "red",
  "execution.completed": "green",
  "execution.failed": "red",
  "execution.timeout": "amber",
};

function markerKind(type: CanonicalEvent["type"]): SpaceMarkerKind {
  if (type === "signal.received") return "signal";
  if (type === "process.started") return "exec";
  if (type.startsWith("execution.")) return "execution";
  return "lifecycle";
}

function markerLabel(type: CanonicalEvent["type"]): string {
  switch (type) {
    case "process.started":
      return "fork()";
    case "process.exited":
      return "waitpid() reaped";
    case "process.exec_error":
      return "execvp() failed";
    case "signal.received":
      return "signal";
    case "execution.started":
      return "execution started";
    case "execution.completed":
      return "execution completed";
    case "execution.failed":
      return "execution failed";
    case "execution.timeout":
      return "execution timed out";
    case "redirection.opened":
      return "redirection opened";
    case "redirection.failed":
      return "redirection failed";
    default:
      return type;
  }
}

function markerDetail(event: CanonicalEvent): string | null {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "process.exited") {
    const code = typeof payload.exitCode === "number" ? payload.exitCode : null;
    return code === null ? "process exited" : `exit code ${code}`;
  }
  if (event.type === "signal.received") {
    const signal = typeof payload.signal === "number" ? payload.signal : null;
    return signal === null ? "signal received" : `signal ${signal}`;
  }
  if (event.type === "process.exec_error") {
    const message = typeof payload.message === "string" ? payload.message : null;
    return message ?? "execvp() reported an error";
  }
  if (event.type === "process.started") {
    return typeof payload.label === "string" ? payload.label : "child process created by fork()";
  }
  return null;
}

function buildMarkers(events: CanonicalEvent[], base: number, nodes: SpaceNode[]): SpaceMarker[] {
  const byPid = new Map<number, SpaceNode>();
  for (const node of nodes) if (node.pid !== null) byPid.set(node.pid, node);
  const markers: SpaceMarker[] = [];
  for (const event of events) {
    const tone = MARKER_TONES[event.type];
    if (tone === undefined) continue;
    const node = typeof event.pid === "number" ? byPid.get(event.pid) : undefined;
    markers.push({
      key: `marker-${event.id}`,
      kind: markerKind(event.type),
      type: event.type,
      label: markerLabel(event.type),
      tone,
      atMs: atMsOf(event, base),
      sequence: event.sequence,
      nodeKey: node?.key ?? null,
      pid: typeof event.pid === "number" ? event.pid : null,
      // Resolved from this event's own payload, so a signal is attached to the
      // process it actually named and to no other.
      signal: event.type === "signal.received" && typeof event.payload.signal === "number" ? event.payload.signal : null,
      detail: markerDetail(event),
    });
  }
  return markers;
}

// ---------------------------------------------------------------------------
// Visual state lookup, keyed by PID
// ---------------------------------------------------------------------------

function buildVisualStateIndex(samples: TelemetrySample[]): Map<number, ProcessVisualState[]> {
  const index = new Map<number, ProcessVisualState[]>();
  if (samples.length === 0) return index;
  const peaks = visualStatePeaks(samples);
  for (const sample of samples) {
    const state = buildVisualState(sample, peaks);
    if (state.pid === null) continue;
    const list = index.get(state.pid) ?? [];
    list.push(state);
    index.set(state.pid, list);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildProcessSpace(events: CanonicalEvent[]): ProcessSpace {
  const { base, origin } = timeOrigin(events);
  const samples = collectSamples(events);
  const raw = rekeyNodes(collectRawNodes(events, base));
  const nodes = orderNodes(raw, events[0]?.sessionId ?? "unknown-session");

  const lastAtMs = events.length > 0 ? atMsOf(events[events.length - 1]!, base) : 0;
  const spanMs = Math.max(lastAtMs, samples.at(-1)?.atMs ?? 0);

  const terminalEvent = [...events].reverse().find((event) => EXECUTION_TERMINALS.has(event.type)) ?? null;
  const terminal = terminalEvent
    ? {
        type: terminalEvent.type,
        state: (terminalEvent.type === "execution.completed" ? "COMPLETED" : terminalEvent.type === "execution.failed" ? "FAILED" : "TIMED_OUT") as SpaceLifecycleState,
        atMs: atMsOf(terminalEvent, base),
      }
    : null;

  // The gateway finalizes the session when the engine has been reaped, so the
  // execution terminal is the engine's end. Without this the engine node would
  // stay RUNNING forever, which would be a false statement about a finished
  // execution.
  if (terminal !== null) {
    for (const node of nodes) {
      if (node.role === "caps-engine" && node.endedAtMs === null) node.endedAtMs = terminal.atMs;
    }
  }

  const edges: SpaceEdge[] = nodes
    .filter((node) => node.parentVerified && node.parentKey !== null)
    .map((node) => ({
      key: `edge-${node.parentKey}->${node.key}`,
      fromKey: node.parentKey!,
      toKey: node.key,
      fromPid: node.parentPid,
      toPid: node.pid,
      provenance: "OBSERVED · PPID match",
      createdAtMs: node.createdAtMs,
    }));

  const markers = buildMarkers(events, base, nodes);

  const terminalMarkerByKey = new Map<string, SpaceMarker>();
  for (const marker of markers) {
    if (marker.nodeKey !== null && (marker.type === "process.exited" || marker.type === "process.exec_error")) {
      terminalMarkerByKey.set(marker.nodeKey, marker);
    }
  }
  // Attribute each signal to the node whose event names it. No fallback, no
  // record-wide flag: if the event has no resolvable node, it is not shown on
  // any node rather than being shown on all of them.
  const signalByKey = new Map<string, { signal: number; sequence: number }>();
  for (const marker of markers) {
    if (marker.type !== "signal.received" || marker.nodeKey === null) continue;
    if (signalByKey.has(marker.nodeKey)) continue;
    const signal = marker.signal ?? null;
    if (signal === null) continue;
    signalByKey.set(marker.nodeKey, { signal, sequence: marker.sequence });
  }

  const limitations = [
    "Only the CAPS-owned direct child is sampled. Descendants created by that child (for example caps_fork_tree) are not observed, so no node or edge is drawn for them.",
    "No procfs sample is collected for the gateway-spawned CAPS engine, so its node shows no resource values.",
    "The 3D scene is a visualization mapping of recorded state. Position, size, colour, and activity are not physical properties of the process.",
  ];

  return {
    sessionId: events[0]?.sessionId ?? null,
    nodes,
    byKey: new Map(nodes.map((node) => [node.key, node])),
    edges,
    edgesByKey: new Map(edges.map((edge) => [edge.key, edge])),
    markers,
    markersBySequence: new Map(markers.map((marker) => [marker.sequence, marker])),
    terminalMarkerByKey,
    signalByKey,
    ruler: buildRuler(spanMs),
    originTimestamp: origin,
    spanMs,
    terminal,
    visualStates: buildVisualStateIndex(samples),
    sampleTimesMs: [...new Set(samples.map((sample) => sample.atMs))].sort((a, b) => a - b),
    limitations,
    counts: { nodes: nodes.length, verifiedEdges: edges.length, markers: markers.length, samples: samples.length },
  };
}

// ---------------------------------------------------------------------------
// Causal cursor state
// ---------------------------------------------------------------------------

export interface SpaceNodeState {
  key: string;
  node: SpaceNode;
  /** False before the node's process.started: the process does not exist yet. */
  present: boolean;
  state: SpaceLifecycleState;
  /** The recorded visual state at or before the cursor. Never interpolated. */
  visual: ProcessVisualState | null;
  /** Age of the state used, in ms. */
  stateAgeMs: number | null;
  /** Terminal states are drawn settled, not running. */
  terminal: boolean;
}

/**
 * State at a cursor, using only evidence recorded at or before it: a process
 * that has not started yet is absent, a started process is present, and a
 * reaped process keeps its terminal state. Resource values come from the
 * latest recorded sample at or before the cursor, never a future one and
 * never an interpolation.
 */
export function nodeStateAt(space: ProcessSpace, cursorMs: number | null, node: SpaceNode): SpaceNodeState {
  const base = { key: node.key, node, visual: null, stateAgeMs: null };
  // A null cursor means "follow the newest recorded evidence", which is the end
  // of the record. Treating it as the span end matters: otherwise a finished
  // execution would still report its processes as RUNNING in the live view.
  const at = cursorMs === null ? space.spanMs : cursorMs;
  if (node.createdAtMs !== null && at < node.createdAtMs) {
    return { ...base, present: false, state: "PENDING", terminal: false };
  }

  const states = node.pid === null ? [] : (space.visualStates.get(node.pid) ?? []);
  let visual: ProcessVisualState | null = null;
  for (const state of states) {
    if (state.atMs <= at) visual = state;
    else break;
  }

  const exited = node.endedAtMs !== null && at >= node.endedAtMs;
  let state: SpaceLifecycleState;
  if (exited && node.endedAtMs !== null) {
    const terminal = space.terminal;
    const childTerminal = space.terminalMarkerByKey.get(node.key);
    if (childTerminal?.type === "process.exec_error" || childTerminal?.type === "process.wait_failed") state = "FAILED";
    // This node's OWN signal outranks the session-level verdict. A record-wide
    // signal flag marked every ended process SIGNALED, which is a fabricated
    // claim about processes that exited normally.
    else if (space.signalByKey.has(node.key)) state = "SIGNALED";
    else if (terminal !== null && terminal.state === "TIMED_OUT") state = "TIMED_OUT";
    else if (terminal !== null && terminal.state === "FAILED") state = "FAILED";
    else state = "COMPLETED";
  } else if (node.role === "child" && visual === null) {
    state = "STARTING";
  } else if (!exited) {
    state = "RUNNING";
  } else {
    state = "WAITING";
  }

  return {
    key: node.key,
    node,
    present: true,
    state,
    visual,
    stateAgeMs: visual === null ? null : Math.max(0, at - visual.atMs),
    terminal: exited,
  };
}

export function spaceAt(space: ProcessSpace, cursorMs: number | null): SpaceNodeState[] {
  return space.nodes.map((node) => nodeStateAt(space, cursorMs, node));
}

/**
 * The first recorded sample at or after the cursor: the "next" replay step.
 * Replay moves between recorded moments only; it never invents a time.
 */
export function nextSampleMs(space: ProcessSpace, cursorMs: number | null): number | null {
  for (const atMs of space.sampleTimesMs) if (cursorMs === null || atMs > cursorMs) return atMs;
  return null;
}

/** The latest recorded sample at or before the cursor: the "previous" step. */
export function previousSampleMs(space: ProcessSpace, cursorMs: number | null): number | null {
  for (let i = space.sampleTimesMs.length - 1; i >= 0; i -= 1) {
    const atMs = space.sampleTimesMs[i]!;
    if (cursorMs === null || atMs <= cursorMs) return atMs;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Visual mapping — bounded, documented, deterministic
// ---------------------------------------------------------------------------

export const RADIUS_MIN = 0.5;
export const RADIUS_MAX = 1.9;
const RADIUS_SPAN = RADIUS_MAX - RADIUS_MIN;
/** 4 GiB of RSS maps to the maximum radius; the curve is logarithmic below it. */
const RSS_REFERENCE_BYTES = 4 * 1024 * 1024 * 1024;
const LOG_REFERENCE = Math.log1p(RSS_REFERENCE_BYTES / (1024 * 1024));

/**
 * radius = clamp(min + span * log1p(rss / 1MiB) / log1p(4096), min, max)
 *
 * A bounded, monotonic visualization mapping of observed RSS. A 4 GiB process
 * cannot create a giant object, and a 64 KiB process is still clickable. This
 * is a display mapping, not a physical model of memory.
 */
export function nodeRadius(rssBytes: number | null | undefined): number {
  if (rssBytes === null || rssBytes === undefined || !Number.isFinite(rssBytes) || rssBytes <= 0) return RADIUS_MIN;
  const mib = rssBytes / (1024 * 1024);
  const ratio = Math.log1p(mib) / LOG_REFERENCE;
  return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, RADIUS_MIN + RADIUS_SPAN * Math.min(1, Math.max(0, ratio))));
}

/**
 * The resource lens chooses which single observed quantity drives node size and
 * activity.
 *
 * The lens is a *view* mode. It never alters telemetry, never merges metrics,
 * and never produces a composite score. Each lens reads exactly one canonical
 * metric family through the normalized value `buildVisualState` already
 * computed against this record's own observed peak, so a lens is bounded by
 * what was actually measured.
 */
export type MetricMode = "normal" | "cpu" | "memory" | "io" | "faults";

export interface LensSpec {
  id: MetricMode;
  label: string;
  /** The single canonical metric family this lens reads. */
  metric: "rss" | "cpu" | "io" | "faults";
  /** What one unit of the underlying value is, stated for the reader. */
  unit: string;
  /** The bounded mapping, written out so the encoding is never a mystery. */
  mapping: string;
  /** What the lens cannot show, so no coverage is implied. */
  caveat: string;
}

/** Documented lens table. The UI renders this; nothing is hard-coded twice. */
export const LENS_SPECS: Record<MetricMode, LensSpec> = {
  normal: {
    id: "normal",
    label: "Normal · RSS",
    metric: "rss",
    unit: "bytes resident",
    mapping: "radius = clamp(RMIN + span * log1p(rss / 1 MiB) / log1p(4096), RMIN, RMAX); 4 GiB maps to RMAX",
    caveat: "A process the collector never sampled has no RSS and no size; it is drawn at the minimum radius, not at zero RSS.",
  },
  cpu: {
    id: "cpu",
    label: "CPU",
    metric: "cpu",
    unit: "% of one core",
    mapping: "radius = clamp(RMIN + span * min(1, cpuPercent / 100), RMIN, RMAX); the ring shows the same value",
    caveat: "CPU utilization is a DERIVED rate, so it is UNAVAILABLE on the first sample of a session by design.",
  },
  memory: {
    id: "memory",
    label: "Memory · RSS",
    metric: "rss",
    unit: "bytes resident",
    mapping: "radius = clamp(RMIN + span * log1p(rss / 1 MiB) / log1p(4096), RMIN, RMAX)",
    caveat: "Resident memory only. Virtual size is reported in the inspector and is not drawn.",
  },
  io: {
    id: "io",
    label: "I/O",
    metric: "io",
    unit: "bytes per second",
    mapping:
      "radius = clamp(RMIN + span * max(rchar, wchar, blockRead, blockWrite) / peakOfThoseSameCounters, RMIN, RMAX); the ring shows the same value",
    caveat:
      "I/O rates are DERIVED. The lens shows the largest of the four recorded rate counters, not a single 'I/O' figure: character counters include page-cache hits and are not disk throughput.",
  },
  faults: {
    id: "faults",
    label: "Faults",
    metric: "faults",
    unit: "faults per second",
    mapping: "radius = clamp(RMIN + span * max(minorRate, majorRate) / peakOfThoseSameRates, RMIN, RMAX); the ring shows the same value",
    caveat:
      "Per-second fault rates are DERIVED and therefore UNAVAILABLE on the first sample. The lens separates neither minor nor major faults beyond the two recorded rates.",
  },
};

export const LENS_ORDER: MetricMode[] = ["normal", "cpu", "memory", "io", "faults"];

/**
 * The bounded 0..1 value of a lens at a cursor, or null when the metric was
 * never observed. null is rendered as the explicit unavailable state; it is
 * never turned into 0, because "0 CPU" and "no CPU reading" are different
 * claims.
 */
export function lensValue(state: SpaceNodeState, mode: MetricMode): number | null {
  const spec = LENS_SPECS[mode];
  const visual = state.visual;
  if (visual === null) return null;
  switch (spec.metric) {
    case "rss":
      return visual.memory;
    case "cpu":
      return visual.cpu;
    case "io":
      return visual.io;
    case "faults":
      return visual.faults;
  }
}

/** The raw observed value behind a lens, for tooltips and the evidence panel. */
export function lensRawValue(state: SpaceNodeState, mode: MetricMode): number | null {
  const visual = state.visual;
  if (visual === null) return null;
  switch (LENS_SPECS[mode].metric) {
    case "rss":
      return visual.raw.rssBytes;
    case "cpu":
      return visual.raw.cpuPercent;
    case "io": {
      const values = [visual.raw.rcharBytesPerSec, visual.raw.wcharBytesPerSec, visual.raw.readBytesPerSec, visual.raw.writeBytesPerSec];
      const observed = values.filter((value): value is number => value !== null);
      return observed.length === 0 ? null : Math.max(...observed);
    }
    case "faults": {
      // The lens is documented as a per-second rate, so it reads the derived
      // rates and not the cumulative counters. Reading the counters here would
      // report a growing total as if it were an activity level.
      const minor = visual.raw.minorFaultsPerSec;
      const major = visual.raw.majorFaultsPerSec;
      return minor === null && major === null ? null : Math.max(minor ?? 0, major ?? 0);
    }
  }
}

/**
 * Node radius under a lens. An unavailable metric produces the minimum radius,
 * which is also what an unobserved small process looks like; the explicit
 * unavailable state is carried separately by `lensValue` and shown in the HUD
 * and the table, so the two are never confused.
 */
export function radiusForMode(state: SpaceNodeState, mode: MetricMode): number {
  if (state.node.role === "caps-engine") return RADIUS_MIN;
  if (mode === "cpu") {
    const cpu = state.visual?.raw.cpuPercent ?? null;
    if (cpu === null) return RADIUS_MIN;
    return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, RADIUS_MIN + Math.min(1, cpu / 100) * (RADIUS_MAX - RADIUS_MIN)));
  }
  if (mode === "memory" || mode === "normal") return nodeRadius(state.visual?.raw.rssBytes ?? null);
  const value = lensValue(state, mode);
  if (value === null) return RADIUS_MIN;
  return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, RADIUS_MIN + value * (RADIUS_MAX - RADIUS_MIN)));
}

/**
 * 0..1 activity for the ring, driven by the same lens as the size. A terminal
 * process is settled: its ring fades rather than pretending to still work.
 */
export function lensIntensity(state: SpaceNodeState, mode: MetricMode): number {
  if (state.terminal) return 0;
  return lensValue(state, mode) ?? 0;
}

/** CPU intensity, kept for the default encoding where the ring always means CPU. */
export function cpuIntensity(state: SpaceNodeState): number {
  const cpu = state.visual?.raw.cpuPercent ?? null;
  if (cpu === null || state.terminal) return 0;
  return Math.min(1, Math.max(0, cpu / 100));
}

/** True when the current lens has no observation for this node. */
export function lensUnavailable(state: SpaceNodeState, mode: MetricMode): boolean {
  return lensValue(state, mode) === null;
}

/**
 * The node a process identity refers to, through the start-time guard rather
 * than through a bare PID comparison.
 */
export function nodeForIdentity(space: ProcessSpace, identity: ProcessIdentity | null): SpaceNode | null {
  if (identity === null) return null;
  const key = nodeKeyFor(identity);
  if (key === null) return null;
  const node = space.byKey.get(key);
  if (node === undefined || node.identity === null) return null;
  const a = node.identity;
  const sameSession = a.sessionId === identity.sessionId;
  const samePid = a.pid === identity.pid;
  const startOk = a.processStartTime === null || identity.processStartTime === null || a.processStartTime === identity.processStartTime;
  return sameSession && samePid && startOk ? node : null;
}

export interface StatePalette {
  color: string;
  label: string;
}

const STATE_PALETTE: Record<SpaceLifecycleState, StatePalette> = {
  PENDING: { color: "#5b6673", label: "PENDING" },
  STARTING: { color: "#4c8bf5", label: "STARTING" },
  RUNNING: { color: "#22c3ee", label: "RUNNING" },
  WAITING: { color: "#8b96a3", label: "WAITING" },
  COMPLETED: { color: "#3ecf8e", label: "COMPLETED" },
  FAILED: { color: "#f0554d", label: "FAILED" },
  SIGNALED: { color: "#f5a623", label: "SIGNALED" },
  TIMED_OUT: { color: "#f5a623", label: "TIMED_OUT" },
  CANCELLED: { color: "#8b7cf6", label: "CANCELLED" },
};

export function statePalette(state: SpaceLifecycleState): StatePalette {
  return STATE_PALETTE[state];
}

export const MARKER_COLORS: Record<SpaceMarker["tone"], string> = {
  cyan: "#22c3ee",
  violet: "#8b7cf6",
  green: "#3ecf8e",
  amber: "#f5a623",
  red: "#f0554d",
};

export const SELECTED_COLOR = "#8b7cf6";

// ---------------------------------------------------------------------------
// Geometry helpers (pure maths, no three.js)
// ---------------------------------------------------------------------------

export const LANE_SPACING = 3.2;
export const DEPTH_SPACING = 2.6;
export const TIME_SCALE = 0.16; // world units per millisecond, for a short run
/** The whole time axis is compressed to this many world units. */
export const TIME_AXIS_LENGTH = 26;

/**
 * World units per millisecond. The time axis is normalized to the recorded
 * span, so a 2-second run and a 10-minute run are both readable, and the
 * mapping is deterministic for a given record.
 */
export function timeScale(spanMs: number): number {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return TIME_SCALE;
  return TIME_AXIS_LENGTH / spanMs;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function nodePosition(node: SpaceNode, scale: number): Vec3 {
  return { x: node.slot * LANE_SPACING, y: -node.depth * DEPTH_SPACING, z: (node.createdAtMs ?? 0) * scale };
}

/** The node body sits just after its creation time; the bar carries the rest. */
export const NODE_Z_OFFSET = 0.9;

export function nodeEndZ(node: SpaceNode, scale: number, spanMs: number): number {
  if (node.endedAtMs !== null) return node.endedAtMs * scale;
  return Math.max(spanMs, node.createdAtMs ?? 0) * scale;
}

export function cursorPosition(cursorMs: number | null, scale: number): number {
  return cursorMs === null ? 0 : cursorMs * scale;
}
