import { beforeEach, describe, expect, it } from "vitest";

import type { ProcessIdentity } from "../lib/evidenceCorrelation";
import { cursorForView, useInvestigation } from "./investigation";

/**
 * The shared investigation selection, asserted as a state machine.
 *
 * The store performs no I/O, so every one of these is a synchronous check. The
 * properties that matter are: a selection never leaves its session, the three
 * selection concepts stay separate fields, and clearing one does not quietly
 * clear another.
 */

const SESSION = "exec_store";
const OTHER = "exec_other";
const childIdentity: ProcessIdentity = { sessionId: SESSION, pid: 401, processStartTime: "2026-04-01T00:00:00.500000Z", role: "child" };

beforeEach(() => {
  useInvestigation.setState({
    sessionId: null,
    cursorMs: null,
    cursorPinned: false,
    cursorSource: "live",
    identity: null,
    eventSeq: null,
    lens: "normal",
    revision: 0,
  });
});

const state = () => useInvestigation.getState();

describe("opening a session", () => {
  it("carries nothing over from another execution", () => {
    state().openSession(SESSION);
    state().selectEvidence(SESSION, 7, childIdentity, 1500);
    expect(state().identity).not.toBeNull();

    state().openSession(OTHER);
    expect(state().sessionId).toBe(OTHER);
    expect(state().identity).toBeNull();
    expect(state().eventSeq).toBeNull();
    expect(state().cursorMs).toBeNull();
    expect(state().cursorPinned).toBe(false);
    // The lens is a reading preference, not evidence, so it survives navigation.
    expect(state().lens).toBe("normal");
  });

  it("leaves an existing selection alone when reopened", () => {
    state().openSession(SESSION);
    state().selectEvidence(SESSION, 7, childIdentity, 1500);
    const revision = state().revision;
    state().openSession(SESSION);
    expect(state().identity).toBe(childIdentity);
    expect(state().eventSeq).toBe(7);
    // No needless invalidation of derived work.
    expect(state().revision).toBe(revision);
  });
});

describe("process selection", () => {
  it("replaces the process without touching the cursor", () => {
    state().openSession(SESSION);
    state().moveCursor(SESSION, 900, "user");
    state().selectProcess(SESSION, childIdentity);
    expect(state().identity).toBe(childIdentity);
    // Time selection is its own concept: choosing a process is not choosing a time.
    expect(state().cursorMs).toBe(900);
    expect(state().cursorPinned).toBe(true);
  });

  it("drops an event selection, because the two are separate concepts", () => {
    state().openSession(SESSION);
    state().selectEvidence(SESSION, 7, childIdentity, 1500);
    state().selectProcess(SESSION, null);
    expect(state().eventSeq).toBeNull();
    expect(state().cursorMs).toBe(1500);
  });

  it("adopts a session it did not have, rather than dropping the reader's click", () => {
    state().openSession(SESSION);
    state().selectProcess(OTHER, { ...childIdentity, sessionId: OTHER });
    expect(state().sessionId).toBe(OTHER);
    expect(state().identity?.sessionId).toBe(OTHER);
  });
});

describe("evidence selection is atomic", () => {
  it("sets the event, its verified process, and its exact moment together", () => {
    state().openSession(SESSION);
    state().selectEvidence(SESSION, 42, childIdentity, 2750);
    expect(state().eventSeq).toBe(42);
    expect(state().identity).toBe(childIdentity);
    expect(state().cursorMs).toBe(2750);
    expect(state().cursorPinned).toBe(true);
    expect(state().cursorSource).toBe("user");
  });

  it("keeps a replaying cursor attributed to the replay", () => {
    state().openSession(SESSION);
    state().moveCursor(SESSION, 1000, "replay");
    state().selectEvidence(SESSION, 4, childIdentity, 1500);
    expect(state().cursorSource).toBe("replay");
  });

  it("releases the cursor when the evidence carries no moment", () => {
    state().openSession(SESSION);
    state().moveCursor(SESSION, 1000, "user");
    state().selectEvidence(SESSION, null, null, null);
    expect(state().cursorMs).toBeNull();
    expect(state().cursorPinned).toBe(false);
    expect(state().cursorSource).toBe("live");
  });
});

describe("clearing", () => {
  it("clearProcess leaves an event selection alone", () => {
    state().openSession(SESSION);
    state().selectEvidence(SESSION, 7, childIdentity, 1500);
    state().clearProcess(SESSION);
    expect(state().identity).toBeNull();
    expect(state().eventSeq).toBe(7);
  });

  it("clearEvent leaves a process selection alone", () => {
    state().openSession(SESSION);
    state().selectEvidence(SESSION, 7, childIdentity, 1500);
    state().clearEvent(SESSION);
    expect(state().eventSeq).toBeNull();
    expect(state().identity).toBe(childIdentity);
  });

  it("clearAll drops the process and the event, and leaves the cursor alone", () => {
    state().openSession(SESSION);
    state().selectEvidence(SESSION, 7, childIdentity, 1500);
    state().clearAll(SESSION);
    expect(state().identity).toBeNull();
    expect(state().eventSeq).toBeNull();
    // Clearing evidence never rewinds time; only releaseCursor does that.
    expect(state().cursorMs).toBe(1500);
    expect(state().cursorPinned).toBe(true);
  });

  it("ignores a clear aimed at a different session", () => {
    state().openSession(SESSION);
    state().selectEvidence(SESSION, 7, childIdentity, 1500);
    state().clearAll(OTHER);
    expect(state().identity).toBe(childIdentity);
    expect(state().eventSeq).toBe(7);
    expect(state().sessionId).toBe(SESSION);
  });
});

describe("the cursor", () => {
  it("follows the newest evidence until a reader moves it", () => {
    state().openSession(SESSION);
    expect(cursorForView(state(), true)).toBeNull();
    state().moveCursor(SESSION, 750, "user");
    expect(cursorForView(state(), true)).toBe(750);
    state().releaseCursor(SESSION);
    expect(state().cursorPinned).toBe(false);
    expect(cursorForView(state(), true)).toBeNull();
  });

  it("does not invalidate derived work when nothing moved", () => {
    state().openSession(SESSION);
    state().moveCursor(SESSION, 750, "user");
    const revision = state().revision;
    state().moveCursor(SESSION, 750, "user");
    expect(state().revision).toBe(revision);
  });

  it("is shown verbatim in replay, whether or not it is pinned", () => {
    state().openSession(SESSION);
    state().moveCursor(SESSION, 0, "replay");
    expect(cursorForView(state(), false)).toBe(0);
  });
});

describe("the shared selection object", () => {
  it("is exactly what the pure correlation layer consumes", () => {
    state().openSession(SESSION);
    state().selectEvidence(SESSION, 7, childIdentity, 1500);
    expect(state().selection()).toEqual({ sessionId: SESSION, cursorMs: 1500, identity: childIdentity, eventSeq: 7 });
  });

  it("reports a lens change once", () => {
    state().setLens("faults");
    const revision = state().revision;
    expect(state().lens).toBe("faults");
    state().setLens("faults");
    expect(state().revision).toBe(revision);
    state().setLens("cpu");
    expect(state().lens).toBe("cpu");
  });
});
