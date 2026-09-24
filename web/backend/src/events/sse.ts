import type { FastifyReply, FastifyRequest } from "fastify";

import type { CanonicalEvent } from "../types/observability.js";
import { logger } from "../utils/logger.js";

const KEEPALIVE_MS = 15_000;

/**
 * Minimal Server-Sent Events implementation on top of Fastify's raw reply
 * (no heavyweight SSE dependency). Guarantees:
 *  - every `data:` block is preceded by an `id:` line equal to the event
 *    sequence, so a native `EventSource` reconnecting automatically sends
 *    `Last-Event-ID` and the gateway can resume from the last sequence;
 *  - keep-alive comment lines keep proxy connections from idling out;
 *  - the connection is torn down cleanly on client close.
 */
export class SseStream {
  private closed = false;
  private readonly keepAlive: NodeJS.Timeout;

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
    void req;
    this._onClose = onClose;
  }

  private _onClose: () => void = () => {};

  send(type: string, data: unknown, sequence: number): void {
    if (this.closed) return;
    try {
      this.reply.raw.write(`id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.close();
    }
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
    this._onClose();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export function sendEvent(sse: SseStream, ev: CanonicalEvent): void {
  sse.send("execution.received", ev, ev.sequence);
}

export function sendEnd(sse: SseStream, sessionId: string, status: string, detail: Record<string, unknown>): void {
  sse.send(
    "execution.ended",
    { sessionId, status, ...detail },
    Number.MAX_SAFE_INTEGER,
  );
  sse.close();
}

export function logStreamLifecycle(sessionId: string, open: boolean): void {
  logger.debug("SSE", open ? "stream opened" : "stream closed", { sessionId });
}