/**
 * Ownership and parent-link annotation.
 *
 * Both answers are about relationships BETWEEN processes, so both have a way to
 * be wrong that looks right on screen:
 *
 *   - `capsOwned` matched on a command name would claim host processes and
 *     promise a signal CAPS cannot deliver;
 *   - a parent link reported as VERIFIED when the parent was never observed
 *     would turn "we could not find it" into "it does not exist".
 */

import { describe, expect, it } from "vitest";

import { annotateRelationships, identityKey, type HostProcess } from "../../src/telemetry/system/processes.js";
import type { SystemMetric } from "../../src/telemetry/system/types.js";

const BOOT = "boot-1";

function metric<T>(value: T | null, provenance: SystemMetric<T>["provenance"] = "OBSERVED"): SystemMetric<T> {
  return {
    value,
    unit: "1",
    source: "/proc",
    timestamp: "2026-01-01T00:00:00.000Z",
    provenance,
    ...(value === null ? { reason: "not readable on this host" } : {}),
  };
}

function row(pid: number, ppid: number | null, startTicks: number | null = 100 + pid): HostProcess {
  return {
    pid: metric(pid),
    ppid: metric(ppid),
    identity: { pid, startTicks, bootId: BOOT, key: identityKey(pid, startTicks, BOOT) },
    capsOwned: false,
    relationshipConfidence: metric("UNAVAILABLE" as const, "UNAVAILABLE"),
    name: metric(`/bin/p${pid}`),
    cmdline: metric([`/bin/p${pid}`]),
    state: metric("S"),
    stateName: metric("sleeping"),
    uid: metric(0),
    gid: metric(0),
    threads: metric(1),
    cpuTimeMs: metric(1),
    cpuPercent: metric(0),
    rssBytes: metric(1),
    pssBytes: metric(1, "UNAVAILABLE"),
    anonymousBytes: metric(1),
    fileBackedBytes: metric(1),
    sharedBytes: metric(1),
    swapBytes: metric(1),
    virtualMemoryBytes: metric(1),
    voluntaryContextSwitches: metric(1),
    nonVoluntaryContextSwitches: metric(1),
    minorFaults: metric(1),
    majorFaults: metric(1),
    readBytes: metric(1),
    writeBytes: metric(1),
    processGroupId: metric(pid),
    sessionId: metric(1),
    cpuAffinity: metric("0-3"),
    schedulerRuntimeNs: metric(1, "UNAVAILABLE"),
    schedulerWaitNs: metric(1, "UNAVAILABLE"),
    schedulerTimeslices: metric(1, "UNAVAILABLE"),
    rowState: "LIVE",
    stateReason: null,
    sampled: true,
  };
}

describe("CAPS ownership is an identity claim, not a name claim", () => {
  it("claims only the identity the gateway recorded", () => {
    const ours = row(100, 1);
    const theirs = row(200, 1);
    annotateRelationships([ours, theirs], new Set([ours.identity.key]), "2026-01-01T00:00:00.000Z");
    expect(ours.capsOwned).toBe(true);
    expect(theirs.capsOwned).toBe(false);
  });

  it("does not claim a process that merely reused a CAPS PID", () => {
    // Same PID, different start ticks: a different process that inherited the
    // number. Claiming it would advertise a process CAPS has no handle on.
    const impostor = row(100, 1, 999);
    annotateRelationships([impostor], new Set([identityKey(100, 200, BOOT)]), "2026-01-01T00:00:00.000Z");
    expect(impostor.capsOwned).toBe(false);
  });

  it("does not claim a process from a different boot", () => {
    const otherBoot = row(100, 1);
    otherBoot.identity = { ...otherBoot.identity, bootId: "boot-2", key: identityKey(100, otherBoot.identity.startTicks, "boot-2") };
    annotateRelationships([otherBoot], new Set([identityKey(100, otherBoot.identity.startTicks, BOOT)]), "2026-01-01T00:00:00.000Z");
    expect(otherBoot.capsOwned).toBe(false);
  });

  it("claims nothing when the gateway has recorded nothing", () => {
    const rows = [row(1, 0), row(2, 1)];
    annotateRelationships(rows, new Set(), "2026-01-01T00:00:00.000Z");
    expect(rows.every((r) => !r.capsOwned)).toBe(true);
  });
});

describe("a parent link is only verified when the parent was observed", () => {
  it("is VERIFIED when the parent is in the same sample", () => {
    const parent = row(1, 0);
    const child = row(2, 1);
    annotateRelationships([parent, child], new Set(), "2026-01-01T00:00:00.000Z");
    expect(child.relationshipConfidence.value).toBe("VERIFIED");
    expect(child.relationshipConfidence.provenance).toBe("OBSERVED");
  });

  it("is UNVERIFIED when the parent is not in the sample", () => {
    // The parent has exited, or is outside the sampled namespace. "We could not
    // see it" must not be rendered as "it has no parent".
    const orphan = row(2, 4000);
    annotateRelationships([orphan], new Set(), "2026-01-01T00:00:00.000Z");
    expect(orphan.relationshipConfidence.value).toBe("UNVERIFIED");
    expect(orphan.relationshipConfidence.reason).toContain("4000");
  });

  it("is UNAVAILABLE when the PPID itself could not be read", () => {
    const unreadable = row(2, null);
    annotateRelationships([unreadable], new Set(), "2026-01-01T00:00:00.000Z");
    expect(unreadable.relationshipConfidence.value).toBeNull();
    expect(unreadable.relationshipConfidence.provenance).toBe("UNAVAILABLE");
  });

  it("keeps PPID 0 unverified rather than calling init a verified parent", () => {
    // PPID 0 means the parent is outside the PID namespace. Treating it as a
    // normal link would claim a parent CAPS never saw.
    const init = row(1, 0);
    annotateRelationships([init], new Set(), "2026-01-01T00:00:00.000Z");
    expect(init.relationshipConfidence.value).toBe("UNVERIFIED");
  });
});
