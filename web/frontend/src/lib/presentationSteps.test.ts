/**
 * The presentation script's rules, asserted rather than trusted.
 *
 * These are the tests that would catch the two failures a reviewer cannot see
 * without running the product: a session-scoped step that navigates somewhere it
 * should not, and a step list that has drifted out of order. Both are cheap to
 * check and expensive to discover during a talk.
 */

import { describe, expect, it } from "vitest";

import {
  PRESENTATION_STEPS,
  destinationFor,
  positionLabel,
  stepAt,
} from "./presentationSteps";

describe("the presentation script", () => {
  it("has exactly the twelve steps in the required order", () => {
    expect(PRESENTATION_STEPS.map((s) => s.title)).toEqual([
      "WHAT IS CAPS?",
      "COMMAND",
      "ARGV",
      "FORK",
      "EXEC",
      "REAL PID",
      "PROCFS",
      "LIVE EVENTS",
      "3D PROCESS SPACE",
      "TERMINATION",
      "FLIGHT RECORDER",
      "EVIDENCE / PROVENANCE",
    ]);
  });

  it("numbers every step consistently with its position", () => {
    PRESENTATION_STEPS.forEach((step, i) => {
      expect(step.position).toBe(i + 1);
      // Zero-padded to two digits, which is what the panel renders and what the
      // presenter's notes will say out loud.
      expect(step.code).toBe(String(i + 1).padStart(2, "0"));
    });
  });

  it("gives every step exactly one sentence of explanation", () => {
    for (const step of PRESENTATION_STEPS) {
      // A full stop, and no internal full stop that would make it two sentences.
      const sentences = step.sentence.split(". ").filter((s) => s.trim().length > 0);
      expect(sentences.length, `${step.code} has more than one sentence`).toBe(1);
      expect(step.sentence.endsWith("."), `${step.code} is not a complete sentence`).toBe(true);
    }
  });

  it("names a destination region for every step", () => {
    for (const step of PRESENTATION_STEPS) {
      expect(step.region.length, `${step.code} has no named destination`).toBeGreaterThan(0);
    }
  });

  it("never interpolates anything into a host step's route", () => {
    // A host step must work for a presenter who has never run anything, so its
    // route is a literal path. A template here would silently become `/execution/`.
    for (const step of PRESENTATION_STEPS.filter((s) => s.scope === "host")) {
      expect(step.route.startsWith("/"), `${step.code} is not an absolute route`).toBe(true);
      expect(step.route, `${step.code} interpolates into its route`).not.toMatch(/[${}]/);
    }
  });

  it("clamps an out-of-range index instead of rendering nothing", () => {
    expect(stepAt(-5).position).toBe(1);
    expect(stepAt(999).position).toBe(PRESENTATION_STEPS.length);
    expect(positionLabel(0)).toBe("01 / 12");
    expect(positionLabel(11)).toBe("12 / 12");
  });
});

describe("destination resolution", () => {
  const sessionStep = PRESENTATION_STEPS.find((s) => s.title === "ARGV")!;
  const hostStep = PRESENTATION_STEPS.find((s) => s.title === "PROCFS")!;

  it("navigates a host step to its own route with no session at all", () => {
    const result = destinationFor(hostStep, null);
    expect(result).toEqual({ ok: true, to: "/system", region: hostStep.region });
  });

  it("refuses to navigate a session step when no session exists", () => {
    // THE load-bearing assertion. A fabricated session id would open a flight
    // recorder whose every metric is UNAVAILABLE, under a heading claiming an
    // execution -- and it would look like a working page.
    const result = destinationFor(sessionStep, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).toMatch(/needs an execution|needs a recorded execution/i);
    }
  });

  it("treats a blank session id as no session", () => {
    // A whitespace id is what a half-cleared input or a trailing-slash regex
    // capture produces. It must not become `/execution/ `.
    expect(destinationFor(sessionStep, "   ").ok).toBe(false);
  });

  it("interpolates a real session id into a session step's route", () => {
    const result = destinationFor(sessionStep, "exec_abc123");
    expect(result).toEqual({ ok: true, to: "/arguments/exec_abc123", region: sessionStep.region });
  });

  it("sends the 3D space step to the session's own /3d route", () => {
    const step = PRESENTATION_STEPS.find((s) => s.title === "3D PROCESS SPACE")!;
    const result = destinationFor(step, "exec_abc123");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.to).toBe("/execution/exec_abc123/3d");
  });

  it("sends the flight recorder step into explicit replay", () => {
    // Replay is a different surface from the live recorder even though the route
    // is the same, and the query is what says so.
    const step = PRESENTATION_STEPS.find((s) => s.title === "FLIGHT RECORDER")!;
    const result = destinationFor(step, "exec_abc123");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.to).toBe("/execution/exec_abc123?replay=1");
  });

  it("gives every session step a written explanation of why it cannot navigate", () => {
    for (const step of PRESENTATION_STEPS) {
      if (step.scope !== "session") continue;
      // The panel renders `unmet` verbatim when there is no session, so an empty
      // string would render an empty warning box.
      expect(step.unmet.length, `${step.code} has no unmet-explanation`).toBeGreaterThan(0);
    }
  });
});
