import { useEffect, useState } from "react";

import { api, ApiError } from "../api/client";
import { useLiveEvents } from "../api/sse";
import type { CanonicalEvent, SessionRecord } from "../types/observability";

export interface SessionView {
  session: SessionRecord | null;
  events: CanonicalEvent[];
  loading: boolean;
  error: string | null;
  connected: boolean;
  ended: boolean;
}

const TERMINAL = new Set<SessionRecord["status"]>(["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"]);

/**
 * Load a session's record plus its event replay. If the session is still
 * live, attach to the SSE stream and append events strictly by id (deduped),
 * flipping `ended` when a terminal event arrives. Real data only.
 */
export function useSession(sessionId: string | undefined, opts?: { live?: boolean }): SessionView {
  const live = opts?.live ?? true;
  const [view, setView] = useState<SessionView>({
    session: null,
    events: [],
    loading: Boolean(sessionId),
    error: null,
    connected: false,
    ended: false,
  });

  useEffect(() => {
    if (!sessionId) {
      setView((v) => ({ ...v, loading: false, error: "Missing session id." }));
      return;
    }
    let cancelled = false;

    setView((v) => ({ ...v, loading: true, error: null, session: null, events: [] }));
    (async () => {
      try {
        const session = await api.getSession(sessionId);
        if (cancelled) return;
        const ended = TERMINAL.has(session.status);
        setView({ session, events: [], loading: false, error: null, connected: false, ended });
        if (ended) {
          const replay = await api.replay(sessionId).catch(() => null);
          if (!cancelled && replay) setView((v) => ({ ...v, events: replay.events ?? [] }));
        }
      } catch (err) {
        if (cancelled) return;
        setView((v) => ({
          ...v,
          loading: false,
          error: err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err),
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useLiveEvents({
    sessionId: sessionId ?? "",
    enabled: live && Boolean(sessionId) && !view.ended && view.session !== null,
    onOpen: () => setView((v) => ({ ...v, connected: true })),
    onEvent: (ev) => {
      setView((v) => {
        if (v.events.some((e) => e.id === ev.id)) return v;
        const session = v.session ? { ...v.session } : null;
        if (session && ev.type === "process.started") {
          session.pid = ev.pid;
          session.status = "RUNNING";
        } else if (session && ev.type === "process.exited") {
          if (typeof ev.payload.exitCode === "number") session.exitCode = ev.payload.exitCode;
          if (typeof ev.payload.durationMs === "number") session.durationMs = ev.payload.durationMs;
        } else if (session && ev.type === "signal.received" && typeof ev.payload.signal === "number") {
          session.signal = ev.payload.signal;
        }
        return { ...v, session, connected: true, events: [...v.events, ev] };
      });
      if (ev.type === "session.summary" || ev.type === "execution.completed" || ev.type === "execution.failed" || ev.type === "execution.timeout") {
        setView((v) => (v.ended ? v : { ...v, ended: true }));
      }
    },
    onEnded: (detail) => {
      setView((v) =>
        v.ended
          ? v
          : {
              ...v,
              ended: true,
              session: v.session ? { ...v.session, status: detail.status, exitCode: detail.exitCode, signal: detail.signal, durationMs: detail.durationMs } : v.session,
            },
      );
      if (sessionId && live) {
        void api.replay(sessionId)
          .then((r) => setView((v) => ({ ...v, events: r.events ?? [] })))
          .catch(() => {});
      }
    },
    onError: () => setView((v) => ({ ...v, connected: false })),
  });

  return view;
}
