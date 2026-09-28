import type { CanonicalEvent, ProcessSnapshot, TelemetryMetric } from "../types/observability";
import { collectSamples, metricValue, type TelemetrySample } from "./telemetry";

/**
 * Evidence correlation — the pure, deterministic layer that lets one piece of
 * observed evidence be followed across every surface of the observatory.
 *
 * This module has no React, no three.js, no I/O, and no randomness. It reads
 * only the canonical events a session already holds and answers one question
 * repeatedly: "which real process, which real event, and which real moment does
 * this selection refer to?"
 *
 * THE THREE SELECTION CONCEPTS ARE SEPARATE
 *   1. Time selection     a cursor in execution milliseconds (the shared cursor)
 *   2. Process selection  a verified process identity, never a bare PID
 *   3. Event selection    a canonical event sequence number
 * They interoperate through the functions below, but one identifier is never
 * overloaded to mean all three: a PID is not an event, and a cursor is not a
 * process.
 *
 * IDENTITY RULES (no PID-only correlation)
 *   A selection identifies a process by execution/session id + Linux PID, and
 *   is additionally guarded by the process start time the collector derived from
 *   /proc/<pid>/stat start ticks. When both sides carry a start time the two
 *   must be equal: a reused PID is therefore a *different* process, never a
 *   silent match. When a start time is unavailable on either side the match
 *   degrades to session+pid and says so through `identityConfidence`, so the UI
 *   can state how strong the correlation is instead of implying more than the
 *   record supports.
 *
 * NOTHING HERE INVENTS A TIMESTAMP. Every cursor value returned is the
 * timestamp of a real persisted event or sample, computed against the record's
 * own first-event origin. There is no interpolation and no nearest-guess
 * fallback that would place the cursor somewhere unobserved.
 */

/** The role the gateway/CAPS record assigns to an observed process. */
export type EvidenceRole = "caps-engine" | "child";

/**
 * A process identity as strong as the record allows.
 *
 * `processStartTime` is the ISO timestamp the gateway derived from kernel start
 * ticks; it is the same value the collector used to reject a PID-reuse
 * mismatch while sampling, and it is the frontend's half of that guard.
 */
export interface ProcessIdentity {
  sessionId: string;
  pid: number;
  /** DERIVED from /proc/<pid>/stat start ticks; null when the record lacks it. */
  processStartTime: string | null;
  role: EvidenceRole;
}

/** How much identity evidence backed a match. Surfaced, never hidden. */
export type IdentityConfidence = "session+pid+start" | "session+pid";

/**
 * The stable scene key for an identity.
 *
 * A PID is unique within one execution record, so the scene key stays readable
 * and stable across renders. It is a *view* key, not a correlation identity:
 * all correlation goes through `sameProcess`, which applies the start-time
 * guard.
 */
export function nodeKeyFor(identity: Pick<ProcessIdentity, "pid" | "role"> | null): string | null {
  if (identity === null) return null;
  return `${identity.role}:${identity.pid}`;
}

export function nodeKeyForRole(role: EvidenceRole, pid: number | null): string {
  return `${role}:${pid ?? "unknown"}`;
}

/** True only for a full match, start times included. */
export function sameProcess(a: ProcessIdentity | null, b: ProcessIdentity | null): boolean {
  return matchConfidence(a, b) !== null;
}

/**
 * The match rule, stated once.
 *
 * Returns the confidence of a match, or null when these are not the same
 * process. A session difference is decisive. A PID difference is decisive. A
 * start-time difference is decisive (PID reuse). Only a *missing* start time
 * degrades the strength of an otherwise matching pair.
 */
export function matchConfidence(a: ProcessIdentity | null, b: ProcessIdentity | null): IdentityConfidence | null {
  if (a === null || b === null) return null;
  if (a.sessionId !== b.sessionId) return null;
  if (a.pid !== b.pid) return null;
  if (a.processStartTime !== null && b.processStartTime !== null) {
    return a.processStartTime === b.processStartTime ? "session+pid+start" : null;
  }
  return "session+pid";
}

// ---------------------------------------------------------------------------
// The selection model
// ---------------------------------------------------------------------------

/**
 * One explicit investigation selection. The three concepts are separate fields
 * and each is optional, because a reader may have chosen only one of them.
 *
 * `cursorMs === null` means "follow the newest recorded evidence" (live). It
 * never means time zero.
 */
export interface EvidenceSelection {
  /** The session this selection belongs to; correlation never crosses sessions. */
  sessionId: string;
  /** Time selection: ms since the record origin, or null to follow the newest evidence. */
  cursorMs: number | null;
  /** Process selection. */
  identity: ProcessIdentity | null;
  /** Event selection: the canonical sequence number. */
  eventSeq: number | null;
}

export function emptySelection(sessionId: string): EvidenceSelection {
  return { sessionId, cursorMs: null, identity: null, eventSeq: null };
}

export function isSelectionEmpty(selection: EvidenceSelection): boolean {
  return selection.identity === null && selection.eventSeq === null;
}

// ---------------------------------------------------------------------------
// The record index
// ---------------------------------------------------------------------------

export interface ObservedProcess {
  identity: ProcessIdentity;
  /** Sequence of the event that first established the process in the record. */
  firstSequence: number;
  /** Execution-time ms of that first event, against the record origin. */
  firstAtMs: number;
  /** Canonical type of the first event, so the UI can say how it was observed. */
  firstEventType: CanonicalEvent["type"];
  /** Sequence and ms of the first procfs sample, when one was collected. */
  firstSampleSequence: number | null;
  firstSampleAtMs: number | null;
  sampleCount: number;
  /** Sequence and ms of the recorded process end, when one exists. */
  endSequence: number | null;
  endAtMs: number | null;
  /** PPID the collector observed for this process, if any. */
  observedPpid: number | null;
  /** Command image observed after execvp(), when the record contains one. */
  command: string | null;
  /**
   * Sequence and ms of the execvp() image change. Linux keeps the PID across
   * exec, so this is a transition on the same identity, never a new process.
   */
  execSequence: number | null;
  execAtMs: number | null;
  imageBefore: string | null;
}

export interface EvidenceIndex {
  sessionId: string | null;
  /** Milliseconds from the first event; the single time origin for everything. */
  originMs: number;
  events: CanonicalEvent[];
  bySequence: Map<number, CanonicalEvent>;
  /** Every observed process, in the order the record established it. */
  processes: ObservedProcess[];
  byNodeKey: Map<string, ObservedProcess>;
  samples: TelemetrySample[];
  /** First and last procfs sample per PID, for inspector placement. */
  sampleRangeByPid: Map<number, { first: TelemetrySample; last: TelemetrySample }>;
  /**
   * A PID observed twice with different kernel start times inside one session.
   * The record cannot disambiguate it, so the UI is told instead of the two
   * being merged into one node.
   */
  pidCollisions: Array<{ pid: number; startTimes: string[] }>;
  /** Real reasons correlation could not be established, with no guess attached. */
  limitations: string[];
}

function eventStartTime(payload: Record<string, unknown>): string | null {
  return metricValue<string>(payload.startTime as TelemetryMetric<string> | undefined);
}

/**
 * Builds the correlation index from the canonical record.
 *
 * Only processes the record actually reports become entries: the child from
 * `process.started`, the CAPS engine from the engine PID carried in a
 * snapshot's `capsEnginePid`. Nothing is discovered by walking the record
 * hoping to find a PID.
 */
export function buildEvidenceIndex(events: CanonicalEvent[]): EvidenceIndex {
  const originMs = events.length > 0 ? new Date(events[0]!.timestamp).getTime() : 0;
  const atMsOf = (event: CanonicalEvent): number => Math.max(0, new Date(event.timestamp).getTime() - originMs);

  const bySequence = new Map<number, CanonicalEvent>();
  const order: ObservedProcess[] = [];
  const byNodeKey = new Map<string, ObservedProcess>();
  const startTimesByPid = new Map<number, Set<string>>();
  const samples = collectSamples(events);
  const sampleRangeByPid = new Map<number, { first: TelemetrySample; last: TelemetrySample }>();

  for (const event of events) bySequence.set(event.sequence, event);

  const touch = (identity: ProcessIdentity, event: CanonicalEvent): ObservedProcess => {
    const key = nodeKeyFor(identity)!;
    const existing = byNodeKey.get(key);
    if (existing !== undefined) return existing;
    const created: ObservedProcess = {
      identity,
      firstSequence: event.sequence,
      firstAtMs: atMsOf(event),
      firstEventType: event.type,
      firstSampleSequence: null,
      firstSampleAtMs: null,
      sampleCount: 0,
      endSequence: null,
      endAtMs: null,
      observedPpid: null,
      command: null,
      execSequence: null,
      execAtMs: null,
      imageBefore: null,
    };
    byNodeKey.set(key, created);
    order.push(created);
    return created;
  };

  // ---- the observed child, from the CAPS process-start event -----------------
  for (const event of events) {
    if (event.type !== "process.started" || typeof event.pid !== "number") continue;
    touch({ sessionId: event.sessionId, pid: event.pid, processStartTime: null, role: "child" }, event);
  }

  // ---- the gateway-spawned CAPS engine, from the engine PID in a snapshot ---
  for (const event of events) {
    if (event.type !== "process.snapshot") continue;
    const payload = event.payload;
    const enginePid = metricValue<number>(payload.capsEnginePid as TelemetryMetric<number> | undefined);
    if (enginePid !== null) touch({ sessionId: event.sessionId, pid: enginePid, processStartTime: null, role: "caps-engine" }, event);
  }

  // ---- enrich each process with its own recorded observations --------------
  for (const event of events) {
    const pid = typeof event.pid === "number" ? event.pid : null;
    const payload = event.payload;

    if (event.type === "process.started" && pid !== null) {
      const record = byNodeKey.get(nodeKeyForRole("child", pid));
      if (record !== undefined && typeof payload.label === "string") record.imageBefore = payload.label;
    }

    if (event.type === "process.snapshot") {
      const enginePid = metricValue<number>(payload.capsEnginePid as TelemetryMetric<number> | undefined);
      const subjectPid = metricValue<number>(payload.pid as TelemetryMetric<number> | undefined) ?? pid;
      if (subjectPid === null) continue;
      const key = enginePid !== null && subjectPid === enginePid ? nodeKeyForRole("caps-engine", subjectPid) : nodeKeyForRole("child", subjectPid);
      const record = byNodeKey.get(key);
      if (record === undefined) continue;

      const startTime = eventStartTime(payload);
      if (startTime !== null) {
        record.identity.processStartTime = startTime;
        const seen = startTimesByPid.get(record.identity.pid) ?? new Set<string>();
        seen.add(startTime);
        startTimesByPid.set(record.identity.pid, seen);
      }
      const ppid = metricValue<number>(payload.ppid as TelemetryMetric<number> | undefined);
      if (ppid !== null) record.observedPpid = ppid;
      const command = metricValue<string>(payload.command as TelemetryMetric<string> | undefined);
      if (command !== null) {
        record.command = command;
        // The first snapshot that carries a command image is where the record
        // shows the execvp() result. Same PID: a transition, not a new process.
        if (record.execSequence === null) {
          record.execSequence = event.sequence;
          record.execAtMs = atMsOf(event);
        }
      }
      record.sampleCount++;
      if (record.firstSampleSequence === null) {
        record.firstSampleSequence = event.sequence;
        record.firstSampleAtMs = atMsOf(event);
      }
    }

    if (pid !== null && (event.type === "process.exited" || event.type === "process.exec_error")) {
      const record = byNodeKey.get(nodeKeyForRole("child", pid));
      if (record !== undefined) {
        record.endSequence = event.sequence;
        record.endAtMs = atMsOf(event);
      }
    }
  }

  for (const sample of samples) {
    const pid = metricValue<number>(sample.snapshot.pid as TelemetryMetric<number> | undefined);
    if (pid === null) continue;
    const range = sampleRangeByPid.get(pid);
    if (range === undefined) sampleRangeByPid.set(pid, { first: sample, last: sample });
    else range.last = sample;
  }

  const pidCollisions: Array<{ pid: number; startTimes: string[] }> = [];
  for (const [pid, times] of startTimesByPid) {
    if (times.size > 1) pidCollisions.push({ pid, startTimes: [...times].sort() });
  }

  const limitations: string[] = [];
  for (const collision of pidCollisions) {
    limitations.push(
      `PID ${collision.pid} was observed with ${collision.startTimes.length} different kernel start times in this execution, so it cannot be resolved to one process identity.`,
    );
  }
  if (order.some((record) => record.identity.processStartTime === null)) {
    limitations.push(
      "A selected process without a derived start time can only be matched on session id and PID; the start-time guard is unavailable for it.",
    );
  }

  return {
    sessionId: events[0]?.sessionId ?? null,
    originMs,
    events,
    bySequence,
    processes: order,
    byNodeKey,
    samples,
    sampleRangeByPid,
    pidCollisions,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Direction 1: event -> process identity
// ---------------------------------------------------------------------------

/**
 * The verified process identity an event refers to, or null.
 *
 * Rules, in order:
 *   1. The event must belong to a process the record actually observed.
 *   2. A `process.*` / `signal.*` event with an envelope PID maps to the child
 *      of that PID.
 *   3. A `process.snapshot` maps to the PID it sampled, or to the CAPS engine
 *      when that PID is the recorded engine PID.
 *   4. Anything else (execution.*, command.*, redirection.*, session.summary)
 *      has no process identity, and none is invented: those events are about
 *      the execution, not one process.
 */
export function eventIdentity(event: CanonicalEvent, index: EvidenceIndex): ProcessIdentity | null {
  if (index.sessionId !== null && event.sessionId !== index.sessionId) return null;

  if (event.type === "process.snapshot") {
    const enginePid = metricValue<number>(event.payload.capsEnginePid as TelemetryMetric<number> | undefined);
    const subject = metricValue<number>(event.payload.pid as TelemetryMetric<number> | undefined) ?? (typeof event.pid === "number" ? event.pid : null);
    if (subject === null) return null;
    const key = enginePid !== null && subject === enginePid ? nodeKeyForRole("caps-engine", subject) : nodeKeyForRole("child", subject);
    return index.byNodeKey.get(key)?.identity ?? null;
  }

  const pid = typeof event.pid === "number" ? event.pid : null;
  if (pid === null) return null;
  if (event.type === "process.started" || event.type === "process.exited" || event.type === "process.exec_error" || event.type === "signal.received") {
    return index.byNodeKey.get(nodeKeyForRole("child", pid))?.identity ?? null;
  }
  return null;
}

/** The event's own execution-time ms. Never synthesised. */
export function eventCursorMs(event: CanonicalEvent, index: EvidenceIndex): number {
  return Math.max(0, new Date(event.timestamp).getTime() - index.originMs);
}

// ---------------------------------------------------------------------------
// Direction 2: process -> event, and process -> cursor
// ---------------------------------------------------------------------------

/** The newest event for this identity at or before `atMs`; the earliest if none. */
export function nearestEventForIdentity(identity: ProcessIdentity, index: EvidenceIndex, atMs: number | null): CanonicalEvent | null {
  const record = index.byNodeKey.get(nodeKeyFor(identity) ?? "");
  if (record === undefined) return null;

  // Resolved once per event, not twice: the identity of an event must be asked
  // for a single time so the filter and the comparison cannot disagree.
  const candidates: CanonicalEvent[] = [];
  for (const event of index.events) {
    const eventProcess = eventIdentity(event, index);
    if (eventProcess === null) continue;
    if (sameProcess(eventProcess, identity)) candidates.push(event);
  }
  if (candidates.length === 0) return null;
  if (atMs === null) return candidates[candidates.length - 1]!;
  let best: CanonicalEvent | null = null;
  for (const event of candidates) {
    if (eventCursorMs(event, index) > atMs) continue;
    if (best === null || event.sequence > best.sequence) best = event;
  }
  if (best !== null) return best;
  return candidates[0]!;
}

/**
 * Where the shared cursor goes when a reader selects a process.
 *
 * RULE CURSOR_FOR_PROCESS: the first observed evidence for that identity.
 *   - a process with procfs samples moves the cursor to its *first* recorded
 *     sample, because that is the earliest moment the record contains evidence
 *     for it;
 *   - a process with no sample (the CAPS engine) moves the cursor to the event
 *     that established it.
 * Both are real persisted timestamps. The rule never averages, never snaps to
 * the nearest arbitrary moment, and never lands on time the record lacks.
 */
export function cursorMsForIdentity(identity: ProcessIdentity, index: EvidenceIndex): number | null {
  const key = nodeKeyFor(identity);
  if (key === null) return null;
  const record = index.byNodeKey.get(key);
  if (record === undefined) return null;
  if (record.firstSampleAtMs !== null) return record.firstSampleAtMs;
  return record.firstAtMs;
}

/**
 * The first and last recorded sample of an identity, for inspector context.
 *
 * The PID index is only a lookup accelerator: the endpoints are re-checked with
 * the same start-time guard as every other filter, so a recycled PID cannot
 * hand one process the sample range of another.
 */
export function sampleRangeForIdentity(identity: ProcessIdentity, index: EvidenceIndex): { first: TelemetrySample; last: TelemetrySample } | null {
  const range = index.sampleRangeByPid.get(identity.pid);
  if (range === undefined) return null;
  if (!identityMatchesSample(identity, range.first.snapshot) || !identityMatchesSample(identity, range.last.snapshot)) return null;
  return range;
}

/**
 * True when a procfs snapshot is the same process as an identity.
 *
 * Both the PID and the derived start time are compared when the record carries
 * them. This is the inspector's filter, so a reader who selects one process
 * never sees another process's numbers presented as its own.
 */
export function identityMatchesSample(identity: ProcessIdentity, snapshot: ProcessSnapshot): boolean {
  const pid = metricValue<number>(snapshot.pid as TelemetryMetric<number> | undefined);
  if (pid === null || pid !== identity.pid) return false;
  const startTime = metricValue<string>(snapshot.startTime as TelemetryMetric<string> | undefined);
  if (identity.processStartTime === null || startTime === null) return true;
  return startTime === identity.processStartTime;
}

/** The recorded execvp() transition of an identity, or null when unrecorded. */
export function execTransitionForIdentity(identity: ProcessIdentity, index: EvidenceIndex): { sequence: number; atMs: number } | null {
  const key = nodeKeyFor(identity);
  if (key === null) return null;
  const record = index.byNodeKey.get(key);
  if (record === undefined || record.execSequence === null || record.execAtMs === null) return null;
  return { sequence: record.execSequence, atMs: record.execAtMs };
}

// ---------------------------------------------------------------------------
// Resolution: one selection -> what every surface should show
// ---------------------------------------------------------------------------

export interface EvidenceResolution {
  sessionId: string;
  /** True when the selection's process still matches a process in the record. */
  identityResolved: boolean;
  identity: ProcessIdentity | null;
  nodeKey: string | null;
  /** How strong the identity match was, or null when there was no match. */
  identityConfidence: IdentityConfidence | null;
  /** The event the selection points at, when the record contains it. */
  event: CanonicalEvent | null;
  eventSeq: number | null;
  /** The cursor every synchronized surface should show. */
  cursorMs: number | null;
  /** Verified hierarchy around the selected process. Never inferred. */
  parentNodeKey: string | null;
  childNodeKeys: string[];
  relatedEdgeKeys: string[];
  relatedNodeKeys: string[];
  /** The event sequence to highlight on a marker, when one matches. */
  markerSequence: number | null;
  /** Why part of the selection could not be honoured, in plain words. */
  unresolved: string[];
}

/**
 * Resolve a selection against the record.
 *
 * This is the single decision function the surfaces share. The 3D scene, the
 * timeline, the inspector, and the event list all ask it the same question, so
 * they cannot drift apart.
 *
 * The event selection wins the cursor when the record contains that event,
 * because an event has an exact recorded timestamp; the process selection
 * supplies identity and hierarchy; the process selection supplies the cursor
 * only when no event was selected. Nothing is guessed in either direction.
 */
export function resolveSelection(selection: EvidenceSelection, index: EvidenceIndex): EvidenceResolution {
  const unresolved: string[] = [];

  const event = selection.eventSeq === null ? null : index.bySequence.get(selection.eventSeq) ?? null;
  if (selection.eventSeq !== null && event === null) {
    unresolved.push(`Event #${selection.eventSeq} is not present in this record, so nothing was moved to it.`);
  }

  // --- identity: the explicit selection first, then the selected event -----
  let identity = selection.identity;
  let identityConfidence = identity === null ? null : matchConfidence(identity, indexIdentityOf(identity, index));
  if (identity !== null && identity.sessionId !== selection.sessionId) {
    // A selection from another execution is stale, not a match. The store is
    // session-scoped, but the rule lives here so no caller can cross records.
    unresolved.push(`PID ${identity.pid} belongs to ${identity.sessionId}, not to ${selection.sessionId}, so it was not selected here.`);
    identity = null;
    identityConfidence = null;
  } else if (identity !== null && indexIdentityOf(identity, index) === null) {
    unresolved.push(`PID ${identity.pid} is not an observed process in this record, so no node was selected.`);
  }
  if (event !== null) {
    const fromEvent = eventIdentity(event, index);
    if (fromEvent === null) {
      unresolved.push(`${event.type} carries no verified process identity, so no process was selected for it.`);
    } else if (identity === null) {
      identity = fromEvent;
      // Confidence is measured against the record, never assumed: an event
      // whose process has no derived start time matches on session+pid only.
      identityConfidence = matchConfidence(fromEvent, indexIdentityOf(fromEvent, index));
    } else {
      // Two different processes were selected. The record cannot show both as
      // one, so the event's process is not substituted for the reader's choice.
      const confidence = matchConfidence(identity, fromEvent);
      if (confidence === null) {
        unresolved.push(`Event #${event.sequence} belongs to PID ${fromEvent.pid}, not the selected PID ${identity.pid}; the selection was left on PID ${identity.pid}.`);
      } else {
        identityConfidence = confidence;
      }
    }
  }

  const record = identity === null ? null : index.byNodeKey.get(nodeKeyFor(identity)!) ?? null;

  // --- hierarchy: verified edges only, read from the same PPID observations
  const nodeKey = identity === null ? null : nodeKeyFor(identity);
  let parentNodeKey: string | null = null;
  const childNodeKeys: string[] = [];
  const relatedEdgeKeys: string[] = [];
  if (record !== null) {
    for (const other of index.processes) {
      if (other === record) continue;
      // Verified parent: the child observed a PPID equal to the parent's PID.
      if (other.identity.role === "child" && record.identity.role === "caps-engine" && other.observedPpid === record.identity.pid) {
        childNodeKeys.push(nodeKeyFor(other.identity)!);
        relatedEdgeKeys.push(`edge-${nodeKeyFor(record.identity)}->${nodeKeyFor(other.identity)}`);
      }
      if (other.identity.role === "caps-engine" && record.identity.role === "child" && record.observedPpid === other.identity.pid) {
        parentNodeKey = nodeKeyFor(other.identity);
        relatedEdgeKeys.push(`edge-${parentNodeKey}->${nodeKeyFor(record.identity)}`);
      }
    }
  }

  // --- cursor: an exact event timestamp wins; otherwise the process rule ----
  let cursorMs: number | null = null;
  if (event !== null) cursorMs = eventCursorMs(event, index);
  else if (identity !== null) cursorMs = cursorMsForIdentity(identity, index);
  if (cursorMs === null) cursorMs = selection.cursorMs;

  return {
    sessionId: selection.sessionId,
    identityResolved: identity !== null && record !== null,
    identity,
    nodeKey,
    identityConfidence,
    event,
    eventSeq: event?.sequence ?? null,
    cursorMs,
    parentNodeKey,
    childNodeKeys,
    relatedEdgeKeys,
    relatedNodeKeys: parentNodeKey === null ? childNodeKeys : [parentNodeKey, ...childNodeKeys],
    markerSequence: event?.sequence ?? null,
    unresolved,
  };
}

/** The identity as the record holds it, so a caller's copy can be compared. */
function indexIdentityOf(identity: ProcessIdentity, index: EvidenceIndex): ProcessIdentity | null {
  return index.byNodeKey.get(nodeKeyFor(identity)!)?.identity ?? null;
}

// ---------------------------------------------------------------------------
// Evidence description, for the panel that shows what was selected
// ---------------------------------------------------------------------------

export interface EvidenceValue {
  label: string;
  /** The displayed value, or the literal "UNAVAILABLE" with a reason. */
  display: string;
  provenance: "OBSERVED" | "DERIVED" | "UNAVAILABLE" | "EVENT";
  reason?: string;
}

export interface EvidenceDescriptor {
  kind: "process" | "event" | "exec" | "none";
  /** Canonical sequence, when the selection is an event or a transition. */
  sequence: number | null;
  timestamp: string | null;
  atMs: number | null;
  eventType: CanonicalEvent["type"] | null;
  identity: ProcessIdentity | null;
  identityConfidence: IdentityConfidence | null;
  values: EvidenceValue[];
  unresolved: string[];
}

const UNAVAILABLE = "UNAVAILABLE";

/**
 * A compact description of the selected evidence.
 *
 * Only fields the record contains are described. A value the kernel never
 * reported is shown as UNAVAILABLE together with the backend's own reason, and
 * no large event payload is copied here: the existing raw event view is the
 * place to read the whole envelope.
 */
export function describeSelection(selection: EvidenceSelection, index: EvidenceIndex): EvidenceDescriptor {
  const resolution = resolveSelection(selection, index);
  const record = resolution.identity === null ? null : index.byNodeKey.get(nodeKeyFor(resolution.identity)!) ?? null;
  const values: EvidenceValue[] = [];

  if (record !== null) {
    values.push({ label: "CAPS execution id", display: record.identity.sessionId, provenance: "OBSERVED" });
    values.push({ label: "Linux PID", display: String(record.identity.pid), provenance: "OBSERVED" });
    values.push({
      label: "Parent PID",
      display: record.observedPpid === null ? UNAVAILABLE : String(record.observedPpid),
      provenance: record.observedPpid === null ? "UNAVAILABLE" : "OBSERVED",
      reason: record.observedPpid === null ? "No procfs PPID was collected for this process" : undefined,
    });
    values.push({
      label: "Process start",
      display: record.identity.processStartTime ?? UNAVAILABLE,
      provenance: record.identity.processStartTime === null ? "UNAVAILABLE" : "DERIVED",
      reason: record.identity.processStartTime === null ? "Derived start time is absent from the record" : undefined,
    });
    values.push({
      label: "Identity match",
      display: resolution.identityConfidence === null ? UNAVAILABLE : resolution.identityConfidence,
      provenance: resolution.identityConfidence === null ? "UNAVAILABLE" : "OBSERVED",
    });
    values.push({
      label: "Program image",
      display: record.command ?? UNAVAILABLE,
      provenance: record.command === null ? "UNAVAILABLE" : "OBSERVED",
      reason: record.command === null ? "No procfs command was collected before the process was reaped" : undefined,
    });
    values.push({
      label: "procfs samples",
      display: record.sampleCount === 0 ? UNAVAILABLE : String(record.sampleCount),
      provenance: record.sampleCount === 0 ? "UNAVAILABLE" : "OBSERVED",
      reason: record.sampleCount === 0 ? "This process is never sampled: the collector follows the CAPS-reported child only" : undefined,
    });
  }

  if (resolution.event !== null) {
    values.push({ label: "Event sequence", display: `#${resolution.event.sequence}`, provenance: "EVENT" });
    values.push({ label: "Event type", display: resolution.event.type, provenance: "EVENT" });
    values.push({ label: "Event source", display: resolution.event.source, provenance: "EVENT" });
    if (resolution.event.pid === null) values.push({ label: "Event PID", display: UNAVAILABLE, provenance: "UNAVAILABLE", reason: "This event carries no PID in its envelope" });
  }

  return {
    kind: resolution.event !== null ? (isExecEvent(index, resolution.event.sequence) ? "exec" : "event") : resolution.identity !== null ? "process" : "none",
    sequence: resolution.event?.sequence ?? null,
    timestamp: resolution.event?.timestamp ?? null,
    atMs: resolution.cursorMs,
    eventType: resolution.event?.type ?? null,
    identity: resolution.identity,
    identityConfidence: resolution.identityConfidence,
    values,
    unresolved: resolution.unresolved,
  };
}

/** True when the sequence is the recorded execvp() transition of a process. */
export function isExecEvent(index: EvidenceIndex, sequence: number | null): boolean {
  if (sequence === null) return false;
  return index.processes.some((record) => record.execSequence === sequence);
}
