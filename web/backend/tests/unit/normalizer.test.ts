import { describe, expect, it } from "vitest";

import { gatewayEvent, normalizeCapsEvent } from "../../src/execution/normalizer.js";
import { EventBus } from "../../src/events/bus.js";

function evId(prefix: string): string {
  return `${prefix}_test`;
}

describe("normalizeCapsEvent", () => {
  const ctx = { sessionId: "exec_x", sequence: 4, evId, rawTs: Date.parse("2026-01-01T00:00:00Z") };

  it("maps known CAPS names to canonical types", () => {
    expect(normalizeCapsEvent({ event: "COMMAND_RECEIVED", command: "echo" }, ctx)?.type).toBe("command.received");
    expect(normalizeCapsEvent({ event: "PARSED" }, ctx)?.type).toBe("command.parsed");
    expect(normalizeCapsEvent({ event: "REDIRECTION_OPENED" }, ctx)?.type).toBe("redirection.opened");
    expect(normalizeCapsEvent({ event: "PROCESS_STARTED", command: "sleep", pid: 100 }, ctx)?.type).toBe("process.started");
    expect(normalizeCapsEvent({ event: "PROCESS_EXITED", exit_code: 0, duration_ms: 12 }, ctx)?.type).toBe("process.exited");
    expect(normalizeCapsEvent({ event: "SIGNAL_RECEIVED", signal: 2 }, ctx)?.type).toBe("signal.received");
    expect(normalizeCapsEvent({ event: "SESSION_SUMMARY", succeeded: 1 }, ctx)?.type).toBe("session.summary");
    expect(normalizeCapsEvent({ event: "EXEC_ERROR" }, ctx)?.type).toBe("process.exec_error");
  });

  it("returns null for unknown event names instead of inventing semantics", () => {
    expect(normalizeCapsEvent({ event: "ALIEN_EVENT" }, ctx)).toBeNull();
    expect(normalizeCapsEvent({}, ctx)).toBeNull();
  });

  it("passes through numbered caps fields and adds canonical envelope", () => {
    const ev = normalizeCapsEvent({ event: "PROCESS_EXITED", exit_code: 0, duration_ms: 123.4 }, ctx);
    expect(ev).toMatchObject({ sessionId: "exec_x", sequence: 4, source: "caps", pid: null });
    expect(ev?.payload.exitCode).toBe(0);
    expect(ev?.payload.durationMs).toBe(123.4);
    expect(ev?.monotonicMs).toBe(123.4);
  });

  it("preserves pid for process events", () => {
    const ev = normalizeCapsEvent({ event: "PROCESS_STARTED", pid: 999 }, ctx);
    expect(ev?.pid).toBe(999);
    expect(ev?.payload.pid).toBe(999);
  });
});

describe("gatewayEvent", () => {
  it("builds a gateway-sourced event", () => {
    const ev = gatewayEvent({ sessionId: "exec_y", sequence: 1, evId }, "gateway", "execution.created", {}, { monotonicMs: 5 });
    expect(ev.source).toBe("gateway");
    expect(ev.type).toBe("execution.created");
    expect(ev.sequence).toBe(1);
    expect(ev.sessionId).toBe("exec_y");
  });
});

describe("EventBus", () => {
  it("delivers to the session channel and the global channel", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const un = bus.subscribe("exec_a", (e) => seen.push(`s:${e.type}`));
    const ung = bus.subscribe(EventBus.GLOBAL, (e) => seen.push(`g:${e.sessionId}`));

    const ev = gatewayEvent({ sessionId: "exec_a", sequence: 1, evId }, "gateway", "execution.created", {});
    bus.publish(ev);
    expect(seen).toEqual(["s:execution.created", "g:exec_a"]);

    un();
    ung();
    bus.publish(gatewayEvent({ sessionId: "exec_a", sequence: 2, evId }, "gateway", "execution.completed", {}));
    expect(seen).toHaveLength(2);
  });

  it("does not deliver to other session channels", () => {
    const bus = new EventBus();
    let other = 0;
    bus.subscribe("exec_b", () => other++);
    bus.publish(gatewayEvent({ sessionId: "exec_a", sequence: 1, evId }, "gateway", "execution.created", {}));
    expect(other).toBe(0);
  });
});
