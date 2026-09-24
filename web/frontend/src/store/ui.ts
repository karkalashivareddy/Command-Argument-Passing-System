import { create } from "zustand";

import { api, ApiError } from "../api/client";
import type { CapabilitiesResponse, HealthResponse } from "../types/observability";

export type EngineState = "checking" | "online" | "offline";

interface UiState {
  engine: HealthResponse | null;
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
  capabilities: null,
  engineState: "checking",
  engineDetail: "Querying the CAPS gateway…",
  sidebarCollapsed: false,
  paletteOpen: false,
  toast: null,
  fetchEngine: async () => {
    try {
      const [engine, capabilities] = await Promise.all([api.health(), api.capabilities()]);
      set({
        engine,
        capabilities,
        engineState: engine.engine.available ? "online" : "offline",
        engineDetail: engine.engine.available
          ? `${engine.platform} · ${engine.version}`
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