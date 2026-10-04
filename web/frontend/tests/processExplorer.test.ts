/**
 * Process Explorer state model.
 *
 * The assertions here are about what a reader is shown, and each targets a
 * specific way a plausible implementation shows something false.
 */

import { describe, expect, it } from "vitest";

import type { HostProcessRow, RelationshipConfidence, SystemMetric } from "../src/api/observability";
import {
  buildTree,
  commandLabel,
  compareRows,
  countByState,
  describeIdentity,
  filterByQuery,
  filterByState,
  flattenTree,
  partitionByOwnership,
  relationshipConfidenceOf,
  sortRows,
  type SortKey,
} from "../src/lib/processExplorer";

/**
 * A numeric metric fixture.
 *
 * Typed as `SystemMetric<number>` even when the value is null, because that is
 * exactly the case under test: a metric whose declared type admits a number but
 * which carries the UNAVAILABLE provenance and a null value. Declaring the type
 * as `SystemMetric<null>` instead would be a different type, and the product's
 * own type is `SystemMetric<number>` with `value: T | null`.
 */
function num(value: number | null, provenance: SystemMetric<number>["provenance"] = "OBSERVED"): SystemMetric<number> {
  return {
    value,
    unit: "1",
    source: "/proc",
    timestamp: "2026-01-01T00:00:00.000Z",
    provenance,
    ...(value === null ? { reason: "not readable on this host" } : {}),
  };
}

/** A string-valued metric fixture, used for the kernel state letter. */
function text(value: string | null, provenance: SystemMetric<string>["provenance"] = "OBSERVED"): SystemMetric<string> {
  return {
    value,
    unit: "1",
    source: "/proc",
    timestamp: "2026-01-01T00:00:00.000Z",
    provenance,
    ...(value === null ? { reason: "not readable on this host" } : {}),
  };
}

/** The UNAVAILABLE numeric metric, spelled once so the intent is obvious. */
const MISSING = (): SystemMetric<number> => num(null, "UNAVAILABLE");

/**
 * The argv metric.
 *
 * This is where the command a row is searched and sorted by actually comes from
 * -- `argv[0]` -- so the fixtures below set `cmdline` rather than a convenient
 * `command` field the gateway has never sent.
 */
function argv(values: string[]): SystemMetric<string[]> {
  return { value: values, unit: "1", source: "/proc/<pid>/cmdline", timestamp: "2026-01-01T00:00:00.000Z", provenance: "OBSERVED" };
}

/**
 * A relationship-confidence metric.
 *
 * Typed rather than reusing `text`, because `SystemMetric` is invariant in `T`:
 * a `SystemMetric<string>` is not a `SystemMetric<RelationshipConfidence>`, and
 * widening to `string` would compile while losing the constraint that the value
 * is one of three named states. A fixture that silently accepted "maybe" would
 * make the confidence assertions meaningless.
 */
function confidence(value: RelationshipConfidence | null, provenance: SystemMetric<RelationshipConfidence>["provenance"] = "OBSERVED"): SystemMetric<RelationshipConfidence> {
  return {
    value,
    unit: "1",
    source: "/proc",
    timestamp: "2026-01-01T00:00:00.000Z",
    provenance,
    ...(value === null ? { reason: "the parent relationship could not be established" } : {}),
  };
}

/**
 * A host process row shaped like the one the gateway actually sends.
 *
 * Every field is present, including the ones these tests never read. A fixture
 * that only carried the fields under test would compile against a type with
 * twenty fewer members than the real one and would have kept passing after the
 * wire shape changed -- which is exactly what happened: this fixture used to
 * describe `pgid`, `sid`, `cpuUserMs`, `lifecycle`, and `firstSeen`, none of
 * which the gateway has ever sent, and the two pages built on it crashed at
 * runtime while this suite stayed green.
 */
function row(overrides: Partial<HostProcessRow> = {}): HostProcessRow {
  const pid = overrides.identity?.pid ?? 100;
  const name = `/usr/bin/thing-${pid}`;
  return {
    pid: num(pid),
    ppid: num(1),
    identity: { pid, startTicks: 1000 + pid, bootId: "boot-1", key: `${pid}@${1000 + pid}#boot-1` },
    capsOwned: false,
    relationshipConfidence: confidence("VERIFIED"),
    name: text(name),
    cmdline: { ...text(name), value: [name] } as SystemMetric<string[]>,
    state: text("S"),
    stateName: text("sleeping"),
    uid: num(0),
    gid: num(0),
    cpuTimeMs: num(15),
    cpuPercent: num(0.5),
    rssBytes: num(1024),
    pssBytes: num(512),
    anonymousBytes: num(256),
    fileBackedBytes: num(256),
    sharedBytes: num(0),
    swapBytes: num(0),
    virtualMemoryBytes: num(4096),
    readBytes: num(0),
    writeBytes: num(0),
    minorFaults: num(3),
    majorFaults: num(0),
    threads: num(1),
    voluntaryContextSwitches: num(2),
    nonVoluntaryContextSwitches: num(0),
    processGroupId: num(pid),
    sessionId: num(1),
    cpuAffinity: text("0-3"),
    schedulerRuntimeNs: num(0),
    schedulerWaitNs: num(0),
    schedulerTimeslices: num(0),
    rowState: "LIVE",
    stateReason: null,
    sampled: true,
    ...overrides,
  };
}

describe("an unavailable metric is absent, not zero", () => {
  it("sorts to the bottom when ascending by RSS", () => {
    // The failure this prevents: `?? 0` would place every unreadable row at
    // the TOP of an ascending list, reading as "the largest processes are the
    // ones we cannot measure".
    const rows = [
      row({ identity: { pid: 1, startTicks: 1, bootId: "b", key: "1" }, rssBytes: num(100) }),
      row({ identity: { pid: 2, startTicks: 2, bootId: "b", key: "2" }, rssBytes: MISSING() }),
      row({ identity: { pid: 3, startTicks: 3, bootId: "b", key: "3" }, rssBytes: num(5000) }),
    ];
    const sorted = sortRows(rows, "rssBytes", "asc");
    expect(sorted.map((r) => r.identity.pid)).toEqual([1, 3, 2]);
    expect(sorted[2]!.rssBytes.value).toBeNull();
  });

  it("still sinks when descending, because direction must not promote unknowns", () => {
    const rows = [
      row({ identity: { pid: 1, startTicks: 1, bootId: "b", key: "1" }, rssBytes: num(100) }),
      row({ identity: { pid: 2, startTicks: 2, bootId: "b", key: "2" }, rssBytes: MISSING() }),
      row({ identity: { pid: 3, startTicks: 3, bootId: "b", key: "3" }, rssBytes: num(5000) }),
    ];
    const sorted = sortRows(rows, "rssBytes", "desc");
    expect(sorted.map((r) => r.identity.pid)).toEqual([3, 1, 2]);
  });

  it("reports the CPU total as unknown when either half is unknown", () => {
    const partial = row({
      identity: { pid: 5, startTicks: 5, bootId: "b", key: "5" },
      cpuTimeMs: MISSING(),
    });
    // Reporting the known half would understate, and reporting 0 would invent
    // a figure.
    expect(compareRows(partial, row(), "cpuMs", "desc")).toBe(1);
  });

  it("sums CPU time when both halves are readable", () => {
    const a = row({ identity: { pid: 1, startTicks: 1, bootId: "b", key: "1" }, cpuTimeMs: num(150) });
    const b = row({ identity: { pid: 2, startTicks: 2, bootId: "b", key: "2" }, cpuTimeMs: num(15) });
    expect(sortRows([b, a], "cpuMs", "desc")[0]!.identity.pid).toBe(1);
  });
});

describe("sorting is stable and total", () => {
  it("falls back to pid when the sort key ties", () => {
    // Without a tiebreak the order depends on the input order, which makes the
    // view jump between polls for no reason the reader can see.
    const a = row({ identity: { pid: 7, startTicks: 1, bootId: "b", key: "a" } });
    const b = row({ identity: { pid: 3, startTicks: 1, bootId: "b", key: "b" } });
    expect(sortRows([a, b], "rssBytes", "asc").map((r) => r.identity.pid)).toEqual([3, 7]);
    expect(sortRows([b, a], "rssBytes", "asc").map((r) => r.identity.pid)).toEqual([3, 7]);
  });

  it("orders commands as text, not numerically", () => {
    const rows = [
      row({ identity: { pid: 1, startTicks: 1, bootId: "b", key: "a" }, cmdline: argv(["zebra"]) }),
      row({ identity: { pid: 2, startTicks: 2, bootId: "b", key: "b" }, cmdline: argv(["alpha"]) }),
    ];
    expect(commandLabel(sortRows(rows, "command", "asc")[0]!)).toBe("alpha");
  });
});

describe("filtering", () => {
  const rows = [
    row({ identity: { pid: 100, startTicks: 1, bootId: "b", key: "a" }, cmdline: argv(["nginx: worker"]) }),
    row({ identity: { pid: 200, startTicks: 2, bootId: "b", key: "b" }, cmdline: argv(["caps_memory_burn"]), rowState: "LIVE" }),
    row({ identity: { pid: 300, startTicks: 3, bootId: "b", key: "c" }, cmdline: argv(["sleep"]), rowState: "EXITED" }),
  ];

  it("matches on pid", () => {
    expect(filterByQuery(rows, "200").map((r) => r.identity.pid)).toEqual([200]);
  });

  it("matches on command, case-insensitively", () => {
    expect(filterByQuery(rows, "NGINX").map((r) => r.identity.pid)).toEqual([100]);
  });

  it("matches on the kernel state letter as reported", () => {
    // The searchable state is `state.value` -- the kernel's own letter from
    // /proc/<pid>/stat -- and not the gateway's row state, which is a different
    // vocabulary describing CAPS's relationship to the row. Searching for the
    // lifecycle word and finding nothing is confusing, so the row state is
    // searched too.
    const withKernelState = [
      row({ identity: { pid: 300, startTicks: 3, bootId: "b", key: "c" }, state: text("Z (zombie)"), rowState: "EXITED" }),
    ];
    expect(filterByQuery(withKernelState, "zombie").map((r) => r.identity.pid)).toEqual([300]);
    expect(filterByQuery(withKernelState, "EXITED").map((r) => r.identity.pid)).toEqual([300]);
  });

  it("returns everything for an empty query", () => {
    expect(filterByQuery(rows, "   ")).toHaveLength(3);
  });

  it("filters by an explicit state set, and an empty set means no filter", () => {
    expect(filterByState(rows, ["EXITED"]).map((r) => r.identity.pid)).toEqual([300]);
    expect(filterByState(rows, [])).toHaveLength(3);
  });
});

describe("CAPS-owned work is separated from host processes", () => {
  const rows = [
    row({ identity: { pid: 1, startTicks: 1, bootId: "b", key: "a" }, capsOwned: true, cmdline: argv(["caps_memory_burn"]) }),
    row({ identity: { pid: 2, startTicks: 2, bootId: "b", key: "b" }, capsOwned: false, cmdline: argv(["systemd"]) }),
    row({ identity: { pid: 3, startTicks: 3, bootId: "b", key: "c" }, capsOwned: false, cmdline: argv(["nginx"]) }),
  ];

  it("uses the gateway's attribution, not the command name", () => {
    const { capsOwned, host } = partitionByOwnership(rows);
    expect(capsOwned.map((r) => r.identity.pid)).toEqual([1]);
    expect(host.map((r) => r.identity.pid)).toEqual([2, 3]);
  });

  it("does not claim a host process that merely mentions caps", () => {
    // The failure this prevents: matching on the command string would mark this
    // as CAPS-owned and imply CAPS could signal it.
    const impostor = row({
      identity: { pid: 9, startTicks: 9, bootId: "b", key: "z" },
      capsOwned: false,
      cmdline: argv(["grep caps /var/log/syslog"]),
    });
    const { capsOwned } = partitionByOwnership([impostor]);
    expect(capsOwned).toHaveLength(0);
  });

  it("does not deny ownership of real CAPS work whose argv lacks the name", () => {
    const real = row({
      identity: { pid: 11, startTicks: 11, bootId: "b", key: "y" },
      capsOwned: true,
      cmdline: argv(["/bin/sleep 30"]),
    });
    expect(partitionByOwnership([real]).capsOwned.map((r) => r.identity.pid)).toEqual([11]);
  });
});

describe("the process forest tolerates a partial sample", () => {
  it("nests a child under its parent", () => {
    const rows = [
      row({ identity: { pid: 1, startTicks: 1, bootId: "b", key: "a" }, ppid: num(0) }),
      row({ identity: { pid: 2, startTicks: 2, bootId: "b", key: "b" }, ppid: num(1) }),
      row({ identity: { pid: 3, startTicks: 3, bootId: "b", key: "c" }, ppid: num(2) }),
    ];
    const tree = buildTree(rows);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children[0]!.children[0]!.row.identity.pid).toBe(3);
    expect(tree[0]!.children[0]!.depth).toBe(1);
  });

  it("promotes a row whose parent is not in the sample", () => {
    // Dropping it would make a live process invisible, which is the one thing a
    // process explorer must never do.
    const orphan = row({ identity: { pid: 50, startTicks: 1, bootId: "b", key: "o" }, ppid: num(9999) });
    const tree = buildTree([orphan]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.row.identity.pid).toBe(50);
  });

it("terminates on a parent/child cycle and still shows both rows", () => {
    /*
     * A racing or malformed sample can produce A's PPID = B and B's PPID = A.
     * Without a guard this recurses forever and takes the page down.
     *
     * The assertion that matters is that BOTH rows remain visible. Detecting the
     * cycle and then hiding one of the processes would trade a hang for a lie:
     * a real process would vanish from the explorer. One of them becomes a root,
     * which is an honest description of "CAPS cannot establish the order here".
     */
    const rows = [
      row({ identity: { pid: 10, startTicks: 1, bootId: "b", key: "a" }, ppid: num(11) }),
      row({ identity: { pid: 11, startTicks: 2, bootId: "b", key: "b" }, ppid: num(10) }),
    ];
    const tree = buildTree(rows);
    const flat = flattenTree(tree);
    expect(flat).toHaveLength(2);
    expect(new Set(flat.map((r) => r.identity.pid))).toEqual(new Set([10, 11]));
  });

  it("does not treat a row as its own child", () => {
    const selfParent = row({ identity: { pid: 42, startTicks: 1, bootId: "b", key: "s" }, ppid: num(42) });
    const flat = flattenTree(buildTree([selfParent]));
    expect(flat).toHaveLength(1);
  });

  it("treats an unavailable PPID as a root", () => {
    const unknownParent = row({
      identity: { pid: 60, startTicks: 1, bootId: "b", key: "u" },
      ppid: MISSING(),
    });
    expect(buildTree([unknownParent])).toHaveLength(1);
  });
});

describe("identity and confidence are stated, never guessed", () => {
  it("names the identity tuple", () => {
    expect(describeIdentity(row())).toBe("pid 100, start ticks 1100, boot boot-1");
  });

  it("says unavailable rather than omitting the field", () => {
    const r = row({ identity: { pid: 1, startTicks: null, bootId: null, key: "k" } });
    expect(describeIdentity(r)).toBe("pid 1, start ticks unavailable, boot unavailable");
  });

  it("reports the relationship confidence the gateway gave", () => {
    expect(relationshipConfidenceOf(row())).toBe("VERIFIED");
    expect(
      relationshipConfidenceOf(
        row({ relationshipConfidence: confidence("UNVERIFIED") }),
      ),
    ).toBe("UNVERIFIED");
    // The confidence metric's own type admits a confidence string, and an absent
    // one is `null` with the UNAVAILABLE provenance.
    expect(
      relationshipConfidenceOf(
        row({ relationshipConfidence: confidence(null, "UNAVAILABLE") }),
      ),
    ).toBe("UNAVAILABLE");
  });
});

describe("state counts cover every lifecycle state", () => {
  it("counts all five states, including the ones with no rows", () => {
    const rows = [
      row({ identity: { pid: 1, startTicks: 1, bootId: "b", key: "a" }, rowState: "LIVE" }),
      row({ identity: { pid: 2, startTicks: 2, bootId: "b", key: "b" }, rowState: "DISAPPEARED" }),
    ];
    const counts = countByState(rows);
    expect(counts.LIVE).toBe(1);
    expect(counts.DISAPPEARED).toBe(1);
    // Zero must be reported as zero, not omitted: a reader needs to know the
    // state was considered and had no rows.
    expect(counts.EXITED).toBe(0);
    expect(counts.PERMISSION_DENIED).toBe(0);
    expect(counts.UNAVAILABLE).toBe(0);
  });
});

describe("every offered sort key works", () => {
  it("does not throw for any key", () => {
    const keys: SortKey[] = [
      "pid", "command", "state", "cpuMs", "rssBytes", "pssBytes", "threads", "readBytes", "writeBytes",
    ];
    const rows = [row(), row({ identity: { pid: 101, startTicks: 1, bootId: "b", key: "z" } })];
    for (const k of keys) {
      expect(() => sortRows(rows, k, "asc")).not.toThrow();
      expect(sortRows(rows, k, "asc")).toHaveLength(2);
    }
  });
});
