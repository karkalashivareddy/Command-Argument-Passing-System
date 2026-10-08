import { create } from "zustand";

import { api, ApiError, type ReadinessResponse } from "../api/client";
import { PRESENTATION_STEPS } from "../lib/presentationSteps";
import type { CapabilitiesResponse, HealthResponse } from "../types/observability";

/**
 * How many steps the script has, read from the script itself.
 *
 * Named here rather than as a bare literal so the clamp in `stepPresentation`
 * cannot drift from `PRESENTATION_STEPS.length`. A hardcoded 12 next to a
 * twelve-entry array is a number that survives adding a step and then stops
 * letting the presenter reach it.
 */
const PRESENTATION_STEP_COUNT = PRESENTATION_STEPS.length;

export type EngineState = "checking" | "online" | "degraded" | "offline";

/**
 * The presentation script's own state.
 *
 * WHY THIS IS A SLICE OF THE UI STORE AND NOT LOCAL COMPONENT STATE
 * ----------------------------------------------------------------
 * Three separate consumers need to agree on it, and a presenter switching
 * between them must not find them disagreeing:
 *
 *   - the overlay, which renders the step and the auto-advance timer;
 *   - the topbar button, which shows whether a presentation is running;
 *   - `useShortcuts`, which must know to swallow the single-letter navigation
 *     keys while a presentation owns the arrow keys. If that last one did not
 *     know, pressing "P" to go back one step would also navigate to /processes.
 *
 * `sessionId` is part of this state rather than being re-fetched per step
 * because it is the whole honesty constraint in one field: a session-scoped step
 * navigates only when this is a session the gateway actually returned.
 */
export interface PresentationState {
  open: boolean;
  /** Index into PRESENTATION_STEPS. Always clamped before rendering. */
  index: number;
  /** True when the presenter's auto-advance is suspended. */
  paused: boolean;
  /** A session id the gateway actually returned, or null when none is known. */
  sessionId: string | null;
}

interface UiState {
  engine: HealthResponse | null;
  readiness: ReadinessResponse | null;
  capabilities: CapabilitiesResponse | null;
  engineState: EngineState;
  engineDetail: string;
  sidebarCollapsed: boolean;
  paletteOpen: boolean;
  presentation: PresentationState;
  toast: { id: number; message: string; kind: "info" | "success" | "error" } | null;
  fetchEngine: () => Promise<void>;
  toggleSidebar: () => void;
  openPalette: (open: boolean) => void;
  openPresentation: (open: boolean) => void;
  setPresentationIndex: (index: number) => void;
  stepPresentation: (delta: number) => void;
  togglePresentationPaused: () => void;
  setPresentationSession: (sessionId: string | null) => void;
  pushToast: (message: string, kind?: UiState["toast"] extends null | { kind: infer K } ? K : "info") => void;
  clearToast: () => void;
}

export const useUi = create<UiState>((set) => ({
  engine: null,
  readiness: null,
  capabilities: null,
  engineState: "checking",
  engineDetail: "Querying the CAPS gateway…",
  sidebarCollapsed: false,
  paletteOpen: false,
  presentation: { open: false, index: 0, paused: false, sessionId: null },
  toast: null,
  fetchEngine: async () => {
    try {
      // Liveness and readiness are different questions. `/api/health` only
      // says the process is running; `/api/ready` says whether the engine,
      // database, and workspace it depends on are actually usable. A gateway
      // that is alive but cannot execute anything is "degraded", not "online",
      // and saying "online" would be a claim the system does not support.
      const [health, readiness, capabilities] = await Promise.all([
        api.health(),
        api.ready().catch(() => null),
        api.capabilities(),
      ]);
      const engineAvailable = readiness?.checks.engine.available ?? capabilities.engineAvailable;
      const degraded = readiness !== null && !readiness.ready;
      set({
        engine: health,
        readiness,
        capabilities,
        engineState: !engineAvailable ? "offline" : degraded ? "degraded" : "online",
        engineDetail: engineAvailable
          ? degraded
            ? `${health.platform} · ${health.version} · ${readiness!.checks.engine.detail}`
            : `${health.platform} · ${health.version}`
          : "gateway is up but the CAPS binary is unavailable",
      });
    } catch (err) {
      const detail = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      set({ engine: null, engineState: "offline", engineDetail: `cannot reach gateway: ${detail}` });
    }
  },
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  openPalette: (open) => set({ paletteOpen: open }),

  /*
   * Opening always rewinds to step 1 and clears the pause.
   *
   * Resuming where the presenter left off would be friendlier in isolation, but
   * it is the wrong behaviour for a script: a demonstration that opens on step 9
   * with no session behind it shows a panel asserting stages nobody observed.
   * Starting at 1 with a freshly resolved session is the only opening that can
   * be checked against the record.
   */
  openPresentation: (open) =>
    set((s) => ({
      presentation: open
        ? { open: true, index: 0, paused: false, sessionId: s.presentation.sessionId }
        : { ...s.presentation, open: false, paused: false },
    })),

  setPresentationIndex: (index) =>
    set((s) => ({
      presentation: { ...s.presentation, index: Math.max(0, index), paused: false },
    })),

  /*
   * One clamped step in either direction.
   *
   * The clamp is here rather than at render time so the store never holds an
   * index that has no step, and so `BACK` on the first step is a no-op that still
   * clears a pause -- a presenter who presses BACK by accident should get the
   * step they were on, not a stuck panel.
   */
  stepPresentation: (delta) =>
    set((s) => ({
      presentation: {
        ...s.presentation,
        index: Math.min(Math.max(s.presentation.index + delta, 0), PRESENTATION_STEP_COUNT - 1),
        paused: false,
      },
    })),

  togglePresentationPaused: () => set((s) => ({ presentation: { ...s.presentation, paused: !s.presentation.paused } })),

  /*
   * The session the session-scoped steps are allowed to navigate to.
   *
   * Only ever set from a session id the gateway returned. There is deliberately
   * no "make one up" path here: `destinationFor` treats null as "say so in
   * words", and that is the only correct response when nothing has been recorded.
   */
  setPresentationSession: (sessionId) =>
    set((s) => ({ presentation: { ...s.presentation, sessionId } })),
  pushToast: (message, kind = "info") => set({ toast: { id: Date.now(), message, kind } }),
  clearToast: () => set({ toast: null }),
}));
