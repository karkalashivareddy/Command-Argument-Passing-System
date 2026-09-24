import { useEffect, useRef, useState } from "react";

import type { CanonicalEvent, SessionStatus } from "../types/observability";

export interface LiveEvent {
  event: CanonicalEvent;
}

export interface EndedPayload {
  sessionId: string;
  status: SessionStatus;
  exitCode: number | null;
  signal: number | null;
  durationMs: number | null;
}

export interface SseClientOptions {
  sessionId: string;
  onEvent: (ev: CanonicalEvent) => void;
  onEnded?: (detail: EndedPayload) => void;
  onError?: (err: Error) => void;
  enabled?: boolean;
}

/**
 * Subscribe to a session's real-time event stream using a native EventSource.
 * The gateway writes `id: <sequence>` before every event, so a connection
 * drop reconnects with Last-Event-ID and we resume exactly where we left off.
 * No polling, no fabrication — every event is what CAPS actually reported.
 */
export function useLiveEvents({ sessionId, onEvent, onEnded, onError, enabled = true }: SseClientOptions): void {
  const onEventRef = useRef(onEvent);
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  onEventRef.current = onEvent;
  onEndedRef.current = onEnded;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/events`;
    const es = new EventSource(url);

    const handle = (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as LiveEvent | EndedPayload;
        if ("event" in data) {
          onEventRef.current?.(data.event);
        } else if ("status" in data && "sessionId" in data) {
          onEndedRef.current?.(data);
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    es.addEventListener("execution.received", handle);
    es.addEventListener("execution.ended", handle);
    es.onerror = () => onErrorRef.current?.(new Error("connection interrupted"));

    return () => {
      es.removeEventListener("execution.received", handle);
      es.removeEventListener("execution.ended", handle);
      es.close();
    };
  }, [sessionId, enabled]);
}

/**
 * Live feed of events across every session (backed by the gateway's
 * `/api/live/stream`). Used by the Overview/Live dashboards.
 */
export function useGlobalFeed(limit = 200): { events: CanonicalEvent[]; connected: boolean } {
  const [events, setEvents] = useState<CanonicalEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/live/stream");
    const seen = new Set<string>();
    const handle = (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as LiveEvent;
        const ev = data.event;
        if (!ev || seen.has(ev.id)) return;
        seen.add(ev.id);
        setEvents((prev) => {
          const next = [...prev, ev];
          return next.length > limit ? next.slice(next.length - limit) : next;
        });
        setConnected(true);
      } catch {
        /* ignore */
      }
    };
    es.addEventListener("execution.received", handle);
    es.onerror = () => setConnected(false);
    return () => {
      es.removeEventListener("execution.received", handle);
      es.close();
    };
  }, [limit]);

  return { events, connected };
}