import { create } from "zustand";

import { api } from "../api/client";
import type { EndedPayload } from "../api/sse";
import type { CanonicalEvent, RedirectionSpec, SessionRecord } from "../types/observability";

export type ConnectionState = "idle" | "connecting" | "live" | "ended" | "reconnecting";
export type OutputTab = "stdout" | "stderr";

interface ExecutionState {
  sessionId: string | null;
  created: { status: string; argvPreview: string[] } | null;
  events: CanonicalEvent[];
  session: SessionRecord | null;
  connection: ConnectionState;
  connectionError: string | null;
  startedAt: number; // performance.now() when created, for elapsed timing
  stdout: string;
  stderr: string;
  outputTab: OutputTab;

  begin: (input: {
    command: string;
    args: string[];
    redirections: RedirectionSpec;
    timeoutMs?: number;
  }) => Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>;
  attach: (sessionId: string, status: string, argvPreview: string[]) => void;
  appendEvent: (ev: CanonicalEvent) => void;
  end: (detail: EndedPayload) => void;
  markConnected: () => void;
  setConnectionError: (err: string) => void;
  setSession: (s: SessionRecord | null) => void;
  setOutput: (stdout: string, stderr: string) => void;
  setOutputTab: (t: OutputTab) => void;
  reset: () => void;
}

export const useExecution = create<ExecutionState>((set, get) => ({
  sessionId: null,
  created: null,
  events: [],
  session: null,
  connection: "idle",
  connectionError: null,
  startedAt: 0,
  stdout: "",
  stderr: "",
  outputTab: "stdout",

  begin: async (input) => {
    set({ connection: "connecting", connectionError: null, events: [], session: null, stdout: "", stderr: "" });
    try {
      const res = await api.createSession(input);
      get().attach(res.sessionId, res.status, res.argvPreview);
      return { ok: true, sessionId: res.sessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ connection: "ended", connectionError: message });
      return { ok: false, message };
    }
  },

  attach: (sessionId, status, argvPreview) =>
    set({ sessionId, created: { status, argvPreview }, events: [], startedAt: performance.now(), outputTab: "stdout" }),

  appendEvent: (ev) => {
    const s = get();
    if (s.events.some((e) => e.id === ev.id)) return;
    set({ events: [...s.events, ev] });
    if (ev.type === "execution.completed" || ev.type === "execution.failed" || ev.type === "execution.timeout") {
      set({ connection: "ended" });
    }
  },

  end: (_detail: EndedPayload) => {
    set({ connection: "ended" });
  },

  markConnected: () => set((s) => ({ connection: s.connection === "connecting" ? "live" : s.connection })),
  setConnectionError: (err) => set({ connectionError: err, connection: "reconnecting" }),
  setSession: (s) => set({ session: s }),
  setOutput: (stdout, stderr) => set({ stdout, stderr }),
  setOutputTab: (t) => set({ outputTab: t }),
  reset: () => set({ sessionId: null, created: null, events: [], session: null, connection: "idle", connectionError: null, stdout: "", stderr: "" }),
}));