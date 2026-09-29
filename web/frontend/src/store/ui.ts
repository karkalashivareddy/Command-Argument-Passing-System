import { create } from "zustand";

import { api, ApiError, type ReadinessResponse } from "../api/client";
import type { CapabilitiesResponse, HealthResponse } from "../types/observability";

export type EngineState = "checking" | "online" | "degraded" | "offline";

interface UiState {
  engine: HealthResponse | null;
  readiness: ReadinessResponse | null;
  capabilities: CapabilitiesResponse | null;
  engineState: EngineState;
  engineDetail: string;
  sidebarCollapsed: boolean;
  paletteOpen: boolean;
  toast: { id: number; message: string; kind: "info" | "success" | "error" } | null;
  fetchEngine: () => Promise<void>;
  toggleSidebar: () => void;
  openPalette: (open: boolean) => void;
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
  pushToast: (message, kind = "info") => set({ toast: { id: Date.now(), message, kind } }),
  clearToast: () => set({ toast: null }),
}));
