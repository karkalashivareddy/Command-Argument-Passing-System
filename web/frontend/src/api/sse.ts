import { useEffect, useRef, useState } from "react";

import type { CanonicalEvent, SessionStatus } from "../types/observability";

/**
 * SSE frame names.
 *
 * The gateway distinguishes "a canonical event arrived" from "the stream is
 * over", and the two names say so. The previous pair, `execution.received` and
 * `execution.ended`, was ambiguous: a reader could not tell a completed *event*
 * from a completed *stream* by looking at the frame, and both sounded as if the
 * execution itself had finished.
 *
 * Only the canonical-event frame carries an `id:`, and that id is the event's
 * sequence within its session. That is what makes a native `EventSource`
 * reconnect send a meaningful `Last-Event-ID`.
 */
export const SSE_EVENT_FRAME = "caps.event";
export const SSE_END_FRAME = "stream.end";

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
  onOpen?: () => void;
  onError?: (err: Error) => void;
  enabled?: boolean;
}

/**
 * Subscribe to a session's real-time event stream using a native EventSource.
 * The gateway writes `id: <sequence>` before every event, so a connection
 * drop reconnects with Last-Event-ID and we resume exactly where we left off.
 * No polling or regenerated events. CAPS events keep source "caps"; lifecycle
 * envelopes created by the gateway keep source "gateway".
 */
export function useLiveEvents({ sessionId, onEvent, onEnded, onOpen, onError, enabled = true }: SseClientOptions): void {
  const onEventRef = useRef(onEvent);
  const onEndedRef = useRef(onEnded);
  const onOpenRef = useRef(onOpen);
  const onErrorRef = useRef(onError);
  onEventRef.current = onEvent;
  onEndedRef.current = onEnded;
  onOpenRef.current = onOpen;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/events`;
    const es = new EventSource(url);
    es.onopen = () => onOpenRef.current?.();

    const handle = (e: MessageEvent<string>) => {
      try {
        // The `caps.event` frame contains the canonical
        // event envelope directly (id/sessionId/sequence/type/source/...).
        const data = JSON.parse(e.data) as CanonicalEvent | EndedPayload;
        if ("type" in data && "id" in data && "sequence" in data) {
          onEventRef.current?.(data);
        } else if ("status" in data && "sessionId" in data) {
          onEndedRef.current?.(data);
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    es.addEventListener(SSE_EVENT_FRAME, handle);
    es.addEventListener(SSE_END_FRAME, handle);
    es.onerror = () => onErrorRef.current?.(new Error("connection interrupted"));

    return () => {
      es.removeEventListener(SSE_EVENT_FRAME, handle);
      es.removeEventListener(SSE_END_FRAME, handle);
      es.close();
    };
  }, [sessionId, enabled]);
}

/**
 * Live feed of events across every session (backed by the gateway's
 * `/api/live/stream`). Used by the Overview/Live dashboards.
 */
export function useGlobalFeed(limit = 200): { events: CanonicalEvent[]; connected: boolean; connection: "connecting" | "connected" | "reconnecting" } {
  const [events, setEvents] = useState<CanonicalEvent[]>([]);
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");

  useEffect(() => {
    const es = new EventSource("/api/live/stream");
    const seen = new Set<string>();
    const handle = (e: MessageEvent<string>) => {
      try {
        const ev = JSON.parse(e.data) as CanonicalEvent;
        if (!ev.id || !ev.sessionId || !ev.type || seen.has(ev.id)) return;
        seen.add(ev.id);
        setEvents((prev) => {
          const next = [...prev, ev];
          return next.length > limit ? next.slice(next.length - limit) : next;
        });
        setConnection("connected");
      } catch {
        /* ignore */
      }
    };
    es.onopen = () => setConnection("connected");
    es.addEventListener(SSE_EVENT_FRAME, handle);
    es.onerror = () => setConnection("reconnecting");
    return () => {
      es.removeEventListener(SSE_EVENT_FRAME, handle);
      es.close();
    };
  }, [limit]);

  return { events, connected: connection === "connected", connection };
}
