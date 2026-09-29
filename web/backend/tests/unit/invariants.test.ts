import { describe, expect, it } from "vitest";

import { EventBus } from "../../src/events/bus.js";
import { validateEventStream } from "../../src/events/invariants.js";
import type { CanonicalEvent, CanonicalEventType } from "../../src/types/observability.js";

/**
 * The stream is the history of record.  These tests build streams that are
 * broken in each of the ways the invariants exist to catch, and assert that
 * the checker names the specific problem rather than returning a bare false.
 */

let counter = 0;
function ev(type: CanonicalEventType, sequence: number, extra: Partial<CanonicalEvent> = {}): CanonicalEvent {
  counter += 1;
  return {
    id: `evt_${counter}`,
    sessionId: "exec_test",
    sequence,
    type,
    source: type.startsWith("execution.") ? "gateway" : "caps",
    timestamp: new Date(1_700_000_000_000 + sequence * 10).toISOString(),
    monotonicMs: null,
    pid: null,
    payload: {},
    ...extra,
  };
}

function stream(...events: CanonicalEvent[]): CanonicalEvent[] {
  return events;
}

/** A minimal, valid stream: created -> started -> process -> exited -> done. */
function validStream(): CanonicalEvent[] {
  return stream(
    ev("execution.created", 0),
    ev("execution.started", 1),
    ev("process.started", 2, { pid: 42 }),
    ev("process.exited", 3, { pid: 42, payload: { exitCode: 0, outcome: "COMPLETED" } }),
    ev("execution.completed", 4),
  );
}

describe("validateEventStream", () => {
  it("accepts a well-formed stream", () => {
    const r = validateEventStream(validStream());
    expect(r.valid).toBe(true);
    expect(r.errorCount).toBe(0);
    expect(r.summary.terminalType).toBe("execution.completed");
    expect(r.summary.eventCount).toBe(5);
  });

  it("sorts its input, so it judges the stream rather than the argument", () => {
    const shuffled = validStream().reverse();
    expect(validateEventStream(shuffled).valid).toBe(true);
  });

  it("detects a sequence gap and names the missing position", () => {
    // Event 3 is missing while 4 still exists: a lost event, not renumbering.
    const withGap = validStream().filter((e) => e.sequence !== 3);
    const r = validateEventStream(withGap);
    expect(r.valid).toBe(false);
    const gap = r.violations.find((v) => v.invariant === "I4-contiguous-sequence");
    expect(gap).toBeDefined();
    expect(gap!.message).toMatch(/expected sequence 3 but found 4/);
    expect(gap!.message).toMatch(/gap/);
  });

  it("detects a duplicated sequence", () => {
    const dup = validStream();
    dup[3] = { ...dup[3]!, sequence: 2 };
    const r = validateEventStream(dup);
    expect(r.violations.some((v) => v.invariant === "I2-unique-sequence")).toBe(true);
  });

  it("detects a duplicated event id (the same event delivered twice)", () => {
    const dup = validStream();
    dup[4] = { ...dup[4]!, id: dup[3]!.id };
    const r = validateEventStream(dup);
    expect(r.violations.some((v) => v.invariant === "I8-unique-event-id")).toBe(true);
  });

  it("detects two terminal events", () => {
    const two = [...validStream(), ev("execution.failed", 5)];
    const r = validateEventStream(two);
    expect(r.violations.some((v) => v.invariant === "I5-single-terminal")).toBe(true);
  });

  it("detects a terminal event that is not last", () => {
    // A telemetry sample recorded AFTER execution.completed.
    const bad = [...validStream(), ev("process.snapshot", 5, { pid: 42, payload: {} })];
    const r = validateEventStream(bad);
    expect(r.violations.some((v) => v.invariant === "I6-terminal-is-last")).toBe(true);
  });

  it("detects a telemetry sample after the terminal event", () => {
    const bad = [
      ...validStream(),
      ev("process.snapshot", 5, { pid: 42, payload: {} }),
      ev("execution.completed", 6),
    ];
    const r = validateEventStream(bad);
    const late = r.violations.find((v) => v.invariant === "I7-no-snapshot-after-terminal");
    expect(late).toBeDefined();
    expect(late!.sequences).toEqual([5]);
  });

  it("detects a stream that does not begin with execution.created", () => {
    const r = validateEventStream(stream(ev("process.started", 0, { pid: 1 })));
    expect(r.violations.some((v) => v.invariant === "I9-origin-event")).toBe(true);
  });

  it("detects a process lifecycle event with no process.started", () => {
    const orphan = stream(
      ev("execution.created", 0),
      ev("execution.started", 1),
      ev("process.exited", 2, { pid: 7, payload: { exitCode: 0, outcome: "COMPLETED" } }),
      ev("execution.completed", 3),
    );
    const r = validateEventStream(orphan);
    expect(r.violations.some((v) => v.invariant === "I11-no-orphan-process-lifecycle")).toBe(true);
  });

  it("detects execution.completed with no successful process exit", () => {
    // This is the summary-is-not-proof-of-success rule, checked structurally.
    const fake = stream(
      ev("execution.created", 0),
      ev("execution.started", 1),
      ev("session.summary", 2, { payload: { observed_cleanly: true } }),
      ev("execution.completed", 3),
    );
    const r = validateEventStream(fake);
    const v = r.violations.find((x) => x.invariant === "I12-success-has-process-exit");
    expect(v).toBeDefined();
    expect(v!.message).toMatch(/summary is not proof/i);
  });

  it("flags a corrupt payload as a warning, not an error", () => {
    const corrupt = validStream();
    corrupt[2] = { ...corrupt[2]!, payload: { payloadCorrupt: true, payloadError: "Unexpected token" } };
    const r = validateEventStream(corrupt);
    // A warning: the event still exists and its sequence is intact, but no
    // consumer should read its payload as real.
    expect(r.valid).toBe(true);
    expect(r.warningCount).toBe(1);
    expect(r.violations[0]!.severity).toBe("warning");
  });

  it("detects a finalized row with no terminal event (boot-recovery shape)", () => {
    const unfinished = stream(ev("execution.created", 0), ev("execution.started", 1));
    const r = validateEventStream(unfinished, { sessionStatus: "FAILED" });
    const v = r.violations.find((x) => x.invariant === "I10-terminal-present-when-finalized");
    expect(v).toBeDefined();
    expect(v!.message).toMatch(/unfinished/);
  });

  it("detects a terminal stream with a non-final row", () => {
    const r = validateEventStream(validStream(), { sessionStatus: "RUNNING" });
    expect(r.violations.some((x) => x.invariant === "I10-terminal-present-when-finalized")).toBe(true);
  });

  it("detects a stream mixing two sessions", () => {
    const mixed = validStream();
    mixed[2] = { ...mixed[2]!, sessionId: "exec_other" };
    const r = validateEventStream(mixed);
    expect(r.violations.some((x) => x.invariant === "I1-single-session")).toBe(true);
    expect(r.summary.sessionId).toBeNull();
  });

  it("accepts an empty stream as trivially valid", () => {
    const r = validateEventStream([]);
    expect(r.valid).toBe(true);
    expect(r.summary.eventCount).toBe(0);
  });
});

describe("EventBus buffered subscription", () => {
  const makeEvent = (id: string, sessionId: string, sequence: number): CanonicalEvent => ({
    id,
    sessionId,
    sequence,
    type: "process.snapshot",
    source: "gateway",
    timestamp: new Date().toISOString(),
    monotonicMs: null,
    pid: 1,
    payload: {},
  });

  it("buffers events published before flush, then delivers them", () => {
    const bus = new EventBus();
    const sub = bus.subscribeBuffered("s1");
    const got: CanonicalEvent[] = [];
    sub.setDelivery((e) => got.push(e));

    // Published while the caller is "reading the store": buffered, not lost.
    bus.publish(makeEvent("a", "s1", 5));
    bus.publish(makeEvent("b", "s1", 6));
    expect(got).toHaveLength(0);
    expect(sub.pending).toBe(2);

    sub.flush(() => false);
    expect(got.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("drops events the caller already sent (the read-then-flush overlap)", () => {
    const bus = new EventBus();
    const sub = bus.subscribeBuffered("s1");
    const got: CanonicalEvent[] = [];
    const sent = new Set<number>([5, 6]);
    sub.setDelivery((e) => got.push(e));

    bus.publish(makeEvent("a", "s1", 5));
    bus.publish(makeEvent("b", "s1", 6));
    bus.publish(makeEvent("c", "s1", 7));

    sub.flush((e) => sent.has(e.sequence));
    expect(got.map((e) => e.id)).toEqual(["c"]);
  });

  it("goes straight to the delivery target after flush", () => {
    const bus = new EventBus();
    const sub = bus.subscribeBuffered("s1");
    const got: CanonicalEvent[] = [];
    sub.setDelivery((e) => got.push(e));
    sub.flush(() => false);

    bus.publish(makeEvent("later", "s1", 9));
    expect(got.map((e) => e.id)).toEqual(["later"]);
  });

  it("stops delivering after close", () => {
    const bus = new EventBus();
    const sub = bus.subscribeBuffered("s1");
    const got: CanonicalEvent[] = [];
    sub.setDelivery((e) => got.push(e));
    bus.publish(makeEvent("a", "s1", 1));
    sub.flush(() => false);
    sub.close();
    bus.publish(makeEvent("b", "s1", 2));
    expect(got.map((e) => e.id)).toEqual(["a"]);
    expect(bus.listenerCount("s1")).toBe(0);
  });

  it("delivers nothing when the client disconnected before the flush", () => {
    const bus = new EventBus();
    const sub = bus.subscribeBuffered("s1");
    let closed = false;
    sub.setDelivery(() => {
      if (closed) return;
      throw new Error("must not be called after close");
    });
    bus.publish(makeEvent("a", "s1", 1));
    sub.close();
    closed = true;
    expect(() => sub.flush(() => false)).not.toThrow();
  });

  it("never drops an event published in the read window, even at high volume", () => {
    // The property the milestone states: a client must never miss a persisted
    // event because it connected at the wrong moment.
    const bus = new EventBus();
    const sub = bus.subscribeBuffered("s1");
    const got: number[] = [];
    sub.setDelivery((e) => got.push(e.sequence));

    const persisted: number[] = [];
    for (let i = 0; i < 50; i++) {
      persisted.push(i);
      if (i % 7 === 0) bus.publish(makeEvent(`live-${i}`, "s1", 1000 + i));
    }
    const sent = new Set(persisted);
    sub.flush((e) => sent.has(e.sequence));

    const all = [...persisted, ...got].sort((a, b) => a - b);
    expect(new Set(all).size).toBe(persisted.length + got.length);
    expect(got.every((s) => s >= 1000)).toBe(true);
  });
});
