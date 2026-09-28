import { create } from "zustand";

import type { MetricMode } from "../lib/processSpace";
import type { EvidenceSelection, ProcessIdentity } from "../lib/evidenceCorrelation";

/**
 * The single investigation-selection model shared by every surface of the
 * observatory: the 2D timeline, the 3D process space, the process inspector, the
 * event list, and the replay cursor.
 *
 * The three selection concepts stay separate fields, because they mean different
 * things and must not be collapsed into one identifier:
 *
 *   cursorMs  TIME selection. null means "follow the newest recorded evidence",
 *             which is the live policy. It never means time zero.
 *   identity  PROCESS selection: session + PID + derived kernel start time.
 *             Never a bare PID, so a reused PID cannot be silently matched.
 *   eventSeq  EVENT selection: the canonical event sequence number.
 *
 * Nothing in this store performs I/O. Selecting evidence cannot start an
 * execution, take a telemetry sample, or discover a process: it records intent,
 * and `resolveSelection` in lib/evidenceCorrelation decides what the record
 * actually supports.
 *
 * The selection is scoped to one session. A selection made for one execution is
 * never applied to another, so navigating to a different session cannot present
 * a stale process as if it belonged there.
 */
export interface InvestigationState {
  sessionId: string | null;
  /** Time selection, ms since the record origin; null = follow newest evidence. */
  cursorMs: number | null;
  /** True once a reader has moved the cursor and it should stay put. */
  cursorPinned: boolean;
  /** Where the current cursor value came from. */
  cursorSource: "live" | "user" | "replay";
  identity: ProcessIdentity | null;
  eventSeq: number | null;
  lens: MetricMode;
  /** Bumped whenever the selection changes, so derived work can re-run. */
  revision: number;

  /** Point this store at a session, clearing anything scoped to another one. */
  openSession: (sessionId: string) => void;
  selectProcess: (sessionId: string, identity: ProcessIdentity | null) => void;
  selectEvent: (sessionId: string, eventSeq: number | null) => void;
  /** Select an event and the process it verifiably belongs to, atomically. */
  selectEvidence: (sessionId: string, eventSeq: number | null, identity: ProcessIdentity | null, cursorMs: number | null) => void;
  /** Drop the process selection. An event selection is a separate concept. */
  clearProcess: (sessionId: string) => void;
  /** Drop the event selection. A process selection is a separate concept. */
  clearEvent: (sessionId: string) => void;
  /** Drop both evidence selections. The cursor only moves via releaseCursor. */
  clearAll: (sessionId: string) => void;
  moveCursor: (sessionId: string, cursorMs: number, source: "user" | "replay") => void;
  /** Release the cursor so it follows the newest evidence again. */
  releaseCursor: (sessionId: string) => void;
  setLens: (lens: MetricMode) => void;
  /** The whole selection, as the pure correlation layer consumes it. */
  selection: () => EvidenceSelection;
}

function sameSession(state: InvestigationState, sessionId: string): boolean {
  return state.sessionId === sessionId;
}

export const useInvestigation = create<InvestigationState>((set, get) => ({
  sessionId: null,
  cursorMs: null,
  cursorPinned: false,
  cursorSource: "live",
  identity: null,
  eventSeq: null,
  lens: "normal",
  revision: 0,

  openSession: (sessionId) =>
    set((state) => {
      if (state.sessionId === sessionId) return state;
      // A different execution: nothing carries over. Correlation never crosses
      // sessions, and neither does a cursor.
      return { sessionId, cursorMs: null, cursorPinned: false, cursorSource: "live", identity: null, eventSeq: null, revision: state.revision + 1 };
    }),

  selectProcess: (sessionId, identity) =>
    set((state) => {
      if (!sameSession(state, sessionId)) return { ...state, sessionId, identity, eventSeq: null, revision: state.revision + 1 };
      return { identity, eventSeq: null, revision: state.revision + 1 };
    }),

  selectEvent: (sessionId, eventSeq) =>
    set((state) => {
      if (!sameSession(state, sessionId)) return { ...state, sessionId, eventSeq, revision: state.revision + 1 };
      return { eventSeq, revision: state.revision + 1 };
    }),

  selectEvidence: (sessionId, eventSeq, identity, cursorMs) =>
    set((state) => {
      const base = sameSession(state, sessionId) ? state : { ...state, sessionId };
      return {
        ...base,
        eventSeq,
        identity,
        cursorMs,
        cursorPinned: cursorMs !== null,
        cursorSource: cursorMs === null ? "live" : base.cursorSource === "replay" ? "replay" : "user",
        revision: base.revision + 1,
      };
    }),

  clearProcess: (sessionId) =>
    set((state) => (sameSession(state, sessionId) ? { identity: null, revision: state.revision + 1 } : state)),

  clearEvent: (sessionId) => set((state) => (sameSession(state, sessionId) ? { eventSeq: null, revision: state.revision + 1 } : state)),

  /**
   * Drop both evidence selections. The time selection is untouched on purpose:
   * `releaseCursor` is the one action that lets the cursor follow the newest
   * evidence again, so clearing evidence never silently rewinds time.
   */
  clearAll: (sessionId) =>
    set((state) => (sameSession(state, sessionId) ? { identity: null, eventSeq: null, revision: state.revision + 1 } : state)),

  moveCursor: (sessionId, cursorMs, source) =>
    set((state) => {
      if (!sameSession(state, sessionId)) return { ...state, sessionId, cursorMs, cursorPinned: true, cursorSource: source, revision: state.revision + 1 };
      if (state.cursorMs === cursorMs && state.cursorPinned && state.cursorSource === source) return state;
      return { cursorMs, cursorPinned: true, cursorSource: source, revision: state.revision + 1 };
    }),

  releaseCursor: (sessionId) =>
    set((state) => (sameSession(state, sessionId) ? { cursorMs: null, cursorPinned: false, cursorSource: "live", revision: state.revision + 1 } : state)),

  setLens: (lens) => set((state) => (state.lens === lens ? state : { lens, revision: state.revision + 1 })),

  selection: () => {
    const state = get();
    return {
      sessionId: state.sessionId ?? "",
      cursorMs: state.cursorMs,
      identity: state.identity,
      eventSeq: state.eventSeq,
    };
  },
}));

/**
 * The cursor a view should render.
 *
 * Live views pass the newest evidence as null so the view-model resolves it to
 * the end of the record; a pinned or replayed cursor is used as given. The
 * shared cursor is the only temporal source of truth in the application.
 */
export function cursorForView(state: { cursorMs: number | null; cursorPinned: boolean; cursorSource: "live" | "user" | "replay" }, live: boolean): number | null {
  if (live && !state.cursorPinned) return null;
  return state.cursorMs;
}
