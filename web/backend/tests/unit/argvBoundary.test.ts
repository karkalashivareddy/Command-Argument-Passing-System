/**
 * argv must survive the C engine -> gateway boundary.
 *
 * The engine has emitted per-stage argv for some time, and the gateway drops it.
 * Nothing failed when that happened: every test passed, the API answered 200, and
 * the only symptom was a documentation screenshot titled "per-stage argv" showing
 * "not recorded: the stage produced no start event" for a stage that had just
 * started. A payload field that exists in the engine, is documented in the event
 * contract, and is silently discarded at one boundary needs a test that fails when
 * it is discarded -- which is this one.
 */

import { describe, expect, it } from "vitest";

import { normalizeCapsEvent } from "../../src/execution/normalizer.js";
import type { RawCapsEvent } from "../../src/execution/parser.js";

function normalize(raw: RawCapsEvent) {
  const event = normalizeCapsEvent(raw, {
    sessionId: "exec_test",
    sequence: 0,
    evId: () => "evt_1",
    rawTs: 1_700_000_000_000,
  });
  if (event === null) throw new Error(`event ${String(raw.event)} was rejected`);
  return event;
}

describe("process.started carries the argv the engine recorded", () => {
  it("passes the argv array through", () => {
    const event = normalize({
      event: "PROCESS_STARTED",
      command: "echo hello world",
      pid: 4242,
      pgid: 4200,
      stage: 1,
      stages: 3,
      argv: ["/usr/bin/echo", "hello", "world"],
    });
    expect(event.payload.argv).toEqual(["/usr/bin/echo", "hello", "world"]);
  });

  it("preserves elements that contain spaces and quotes rather than re-joining them", () => {
    // The reason argv travels as an array instead of being reconstructed from the
    // joined label: "a b" and ["a", "b"] render identically, so a consumer that
    // splits the label cannot tell them apart. Re-deriving it here would be a
    // second lexer, and two lexers disagree about one quoting case eventually.
    const argv = ["/usr/bin/echo", "one two", 'three"four', "five\\six", ""];
    const event = normalize({ event: "PROCESS_STARTED", command: "echo", pid: 1, stage: 0, stages: 1, argv });
    expect(event.payload.argv).toEqual(argv);
  });

  it("keeps the truncation flag and the dropped count, so a short argv is not read as the whole one", () => {
    const event = normalize({
      event: "PROCESS_STARTED",
      command: "grep",
      pid: 7,
      stage: 0,
      stages: 1,
      argv: ["/usr/bin/grep"],
      argv_truncated: true,
      argv_elements_dropped: 41,
      argv_elements_total: 42,
    });
    expect(event.payload.argv_truncated).toBe(true);
    expect(event.payload.argv_elements_dropped).toBe(41);
    expect(event.payload.argv_elements_total).toBe(42);
  });

  it("reports no truncation when the engine reported none", () => {
    const event = normalize({ event: "PROCESS_STARTED", command: "true", pid: 1, stage: 0, stages: 1, argv: ["/usr/bin/true"] });
    // Absent rather than false: the engine did not make the claim, and the
    // gateway should not make it on the engine's behalf.
    expect(event.payload.argv_truncated).toBeUndefined();
  });

  it("leaves argv absent when the engine sent none, instead of inventing an empty vector", () => {
    const event = normalize({ event: "PROCESS_STARTED", command: "x", pid: 1, stage: 0, stages: 1 });
    expect(event.payload.argv).toBeUndefined();
  });

  it("ignores an argv that is not an array rather than stringifying it", () => {
    const event = normalize({ event: "PROCESS_STARTED", command: "x", pid: 1, stage: 0, stages: 1, argv: "echo hi" });
    expect(event.payload.argv).toBeUndefined();
  });
});
