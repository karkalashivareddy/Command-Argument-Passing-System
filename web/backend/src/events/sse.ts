import type { FastifyReply, FastifyRequest } from "fastify";

import type { CanonicalEvent } from "../types/observability.js";
import { logger } from "../utils/logger.js";

const KEEPALIVE_MS = 15_000;

/**
 * Three separate concepts, deliberately not conflated.
 *
 *   canonical event id   `evt_...`   a stable identity for one event, unique
 *                                      across every session in the database.
 *   canonical sequence   0, 1, 2, …  the position of an event *within one
 *                                      session*.  This is what `Last-Event-ID`
 *                                      means, and it is the only value a
 *                                      resume can be computed from.
 *   transport frame      the SSE text on the wire.  A frame carries a
 *                                      `data:` payload, an `event:` name, and
 *                                      optionally an `id:`.
 *
 * The previous implementation used `Number.MAX_SAFE_INTEGER` as the `id:` of
 * the end-of-stream frame.  That value is not a sequence, it does not exist in
 * any session, and a browser reconnecting with it as `Last-Event-ID` would ask
 * the gateway to resume from a position past the end and receive nothing.  The
 * end frame now carries no `id:` at all, so `Last-Event-ID` can only ever hold
 * a real sequence.
 *
 * Frame names are also now distinct from lifecycle state.  The old
 * `execution.received` / `execution.ended` pair conflated "an event arrived"
 * with "the execution ended", which made it impossible to tell a completed
 * event from a completed stream by looking at the frame.
 */
export const SSE_EVENT_FRAME = "caps.event";
export const SSE_END_FRAME = "stream.end";

export class SseStream {
  private closed = false;
  private readonly keepAlive: NodeJS.Timeout;
  private readonly onCloseHook: () => void;

  constructor(
    private readonly req: FastifyRequest,
    private readonly reply: FastifyReply,
    onClose: () => void,
  ) {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders?.();

    req.raw.on("close", () => this.close());
    this.keepAlive = setInterval(() => {
      if (!this.closed) this.reply.raw.write(": ping\n\n");
    }, KEEPALIVE_MS);
    this.keepAlive.unref?.();
    this.onCloseHook = onClose;
  }

  /**
   * Write one canonical event.
   *
   * `id` is the canonical sequence within the session, which is precisely what
   * the browser echoes back as `Last-Event-ID` after a reconnect.
   */
  sendEvent(ev: CanonicalEvent): void {
    if (this.closed) return;
    try {
      this.reply.raw.write(
        `id: ${ev.sequence}\nevent: ${SSE_EVENT_FRAME}\ndata: ${JSON.stringify(ev)}\n\n`,
      );
    } catch {
      this.close();
    }
  }

  /**
   * Close the stream.  Deliberately has no `id:` line: this frame is a
   * transport signal, not an event in the session's sequence, and giving it a
   * fake sequence would corrupt the resume position of any reconnecting
   * client.
   */
  sendEnd(detail: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.reply.raw.write(`event: ${SSE_END_FRAME}\ndata: ${JSON.stringify(detail)}\n\n`);
    } catch {
      /* the socket is already gone; close() below still runs */
    }
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    try {
      this.reply.raw.end();
    } catch {
      /* already closed */
    }
    this.onCloseHook();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Close a session stream with the session's own final facts.
 *
 * The detail carries the status and exit facts read from the session row, not
 * a guess: the last canonical event was already delivered with its own
 * `id:`, and this frame only closes the transport.
 */
export function sendSessionEnd(
  sse: SseStream,
  sessionId: string,
  status: string,
  detail: { exitCode: number | null; signal: number | null; durationMs: number | null },
): void {
  sse.sendEnd({ sessionId, status, ...detail });
  logStreamLifecycle(sessionId, true);
}

export function logStreamLifecycle(sessionId: string, open: boolean): void {
  logger.debug("SSE", open ? "stream opened" : "stream closed", { sessionId });
}

/**
 * Parse `Last-Event-ID`.
 *
 * Returns -1 for "no resume position".  A value that is not a non-negative
 * integer is treated as absent rather than coerced, so a corrupt header can
 * never be used to skip past events.
 */
export function readLastEventId(req: FastifyRequest): number {
  const raw = req.headers["last-event-id"];
  if (typeof raw !== "string") return -1;
  if (!/^\d{1,15}$/.test(raw.trim())) return -1;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : -1;
}
