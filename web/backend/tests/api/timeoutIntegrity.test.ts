/**
 * A timed-out session must satisfy the same invariants as any other session.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * On every timeout the runner used to emit `execution.timeout` from
 * handleTimeout(), which is a TERMINAL event type, and then emitted the same
 * terminal type again from finalize(). That produced three defects at once:
 *
 *   1. invariant I5 (exactly one terminal event per session) was violated;
 *   2. invariant I6 (the terminal event is the last one) was violated, because
 *      the sampler kept writing process.snapshot rows after it;
 *   3. the live SSE stream closed on the FIRST terminal event, so no subscriber
 *      ever received process.exited, the escalation, or the real terminal event.
 *
 * Nothing caught it. The one existing test on this path asserted only
 * `sess.status === "TIMED_OUT"` -- which was, and still is, correct. What was
 * wrong was everything the product says about the session it produced, and the
 * product's own /replay integrity block was reporting the violations.
 *
 * So these assertions read the session's OWN integrity report rather than the
 * status. A status assertion passes whether or not the evidence is coherent.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TERMINAL,
  engineAvailable,
  startTestServer,
  stopTestServer,
  type StartedServer,
} from "./harness.js";

/** The shape `GET /api/sessions/:id/replay` actually returns. */
interface IntegrityReport {
  valid: boolean;
  errors: number;
  warnings: number;
  violations: Array<{ id: string; detail?: string }>;
}
interface ReplayBody {
  events: Array<{ type: string; sequence: number }>;
  integrity: IntegrityReport;
}

const TERMINAL_EVENTS = new Set([
  "execution.completed",
  "execution.failed",
  "execution.timeout",
  "execution.cancelled",
]);

/*
 * One timed-out session, shared by every assertion below.
 *
 * Five separate executions would be five separate timeouts, which is both slow
 * and -- worse -- non-deterministic in aggregate: each assertion would then be
 * describing a different run. The properties under test are properties OF a
 * session, so they must be read from one.
 */
describe.skipIf(!engineAvailable)("a timed-out session is internally consistent", () => {
  let started: StartedServer;
  let sessionId: string;
  let status: string;
  let replay: ReplayBody;

  beforeAll(async () => {
    started = await startTestServer();

    // The shortest timeout the API accepts (its floor is 1000ms) against a long
    // sleep, so the timeout is the thing under test rather than the program's
    // own duration.
    const exec = await started.app.inject({
      method: "POST",
      url: TERMINAL.execute,
      payload: { commandLine: "sleep 30", timeoutMs: 1_000 },
    });
    expect(exec.statusCode).toBe(202);
    sessionId = (exec.json() as { sessionId: string }).sessionId;

    // Wait for the SESSION to be complete, defined as its event stream containing
    // a terminal event -- not as the status row saying TIMED_OUT. The status and
    // the terminal event are written in one transaction, but a status poll can
    // observe the row a moment before a concurrent replay read observes the
    // committed event, and reading replay at that instant yields a truncated
    // stream that would make every assertion below fail for the wrong reason.
    let settled = false;
    for (let i = 0; i < 200 && !settled; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const rp = await started.app.inject({ method: "GET", url: `/api/sessions/${sessionId}/replay` });
      const seen = rp.json() as ReplayBody;
      if (seen.events.some((e) => TERMINAL_EVENTS.has(e.type))) {
        replay = seen;
        settled = true;
      }
    }
    if (!settled) throw new Error("the timed-out session never produced a terminal event");

    // GET /api/sessions/:id returns the session record flat, not wrapped.
    const s = await started.app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    status = (s.json() as { status?: string }).status ?? "PENDING";
  }, 60_000);

  afterAll(() => stopTestServer(started));

  it("reached the terminal state the assertions assume", () => {
    // Without this, a gateway that never timed out would make every other
    // assertion below vacuously true.
    expect(status).toBe("TIMED_OUT");
    expect(replay.events.length).toBeGreaterThan(0);
  });

  it("records the timeout exactly once, as a terminal event", () => {
    const terminal = replay.events.filter((e) => TERMINAL_EVENTS.has(e.type));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.type).toBe("execution.timeout");
  });

  it("terminates the stream with the terminal event last", () => {
    const terminalIndexes = replay.events
      .map((e, i) => (TERMINAL_EVENTS.has(e.type) ? i : -1))
      .filter((i) => i >= 0);
    // With exactly one terminal event this is the same fact as the count above,
    // but stated as the invariant it is: a subscriber reading in order must see
    // the timeout last, or the events after it are unreachable on a live stream.
    expect(Math.max(...terminalIndexes)).toBe(replay.events.length - 1);
  });

  it("reports no invariant violation of its own making", () => {
    // Asserted in full rather than filtered: a timeout that produces a coherent
    // stream produces no violations at all, and a filtered assertion would hide
    // the I5/I6 regressions this suite was written for.
    expect(replay.integrity.violations).toEqual([]);
    expect(replay.integrity.valid).toBe(true);
    expect(replay.integrity.errors).toBe(0);
  });

  it("keeps the event sequence contiguous, with no skipped number", () => {
    const sequences = replay.events.map((e) => e.sequence);
    expect(sequences).toEqual(sequences.map((_, i) => i));
  });

  it("still records the child's exit, which the truncated stream used to swallow", () => {
    // This is the evidence a faculty member actually looks for: the timeout
    // fired, the child was signalled, and the kernel reported how it died.
    expect(replay.events.map((e) => e.type)).toContain("process.exited");
  });
});
