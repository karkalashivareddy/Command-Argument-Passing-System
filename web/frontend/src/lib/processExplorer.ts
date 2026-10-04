/**
 * Process Explorer state: sorting, filtering, grouping, and the CAPS-owned
 * distinction.
 *
 * Extracted from the component so the rules can be tested directly. These are
 * the decisions that decide what a reader SEES, and each one has a failure mode
 * that produces a plausible-looking wrong answer:
 *
 *   - sorting by RSS must place UNAVAILABLE last, not at zero;
 *   - the process tree must tolerate a parent that is not in the sample;
 *   - "CAPS-owned" must come from the gateway's own attribution, never from
 *     matching a command name.
 *
 * The last one is the important one. Deciding ownership by looking for "caps" in
 * the command line would mark every unrelated process that mentions the string
 * as CAPS-owned, and would mark a genuinely CAPS-spawned workload as a host
 * process if its argv did not happen to contain it.
 */

import type { HostProcessRow, ProcessState, RelationshipConfidence, SystemMetric } from "../api/observability";

/** Sort keys the explorer offers. */
export type SortKey =
  | "pid"
  | "command"
  | "state"
  | "cpuMs"
  | "rssBytes"
  | "pssBytes"
  | "threads"
  | "readBytes"
  | "writeBytes";

export type SortDirection = "asc" | "desc";

/**
 * Read a metric for sorting, treating UNAVAILABLE as "no value" rather than 0.
 *
 * This is the single most important function in the module. Sorting by RSS with
 * a plain `?? 0` puts every process CAPS cannot measure at the top of an
 * ascending list, which is the exact opposite of the truth: an unreadable metric
 * is not the smallest value, it is an absent one, and it belongs at the end
 * where the reader can see there is a gap.
 */
function sortableValue(metric: SystemMetric<number> | undefined): number | null {
  if (metric === undefined || metric.provenance === "UNAVAILABLE" || metric.value === null) return null;
  return metric.value;
}

export function compareRows(a: HostProcessRow, b: HostProcessRow, key: SortKey, direction: SortDirection): number {
  const sign = direction === "asc" ? 1 : -1;

  // Rows with no value for the sort key always sink, regardless of direction.
  // Reversing them by direction would put the unknowns at the top when sorting
  // ascending, which reads as "the biggest processes are the ones we cannot see".
  const av = rowValue(a, key);
  const bv = rowValue(b, key);
  if (av === null && bv === null) return a.identity.pid - b.identity.pid;
  if (av === null) return 1;
  if (bv === null) return -1;

  if (typeof av === "number" && typeof bv === "number") {
    if (av !== bv) return sign * (av - bv);
    return a.identity.pid - b.identity.pid;
  }
  const cmp = String(av).localeCompare(String(bv));
  if (cmp !== 0) return sign * cmp;
  return a.identity.pid - b.identity.pid;
}

function rowValue(row: HostProcessRow, key: SortKey): number | string | null {
  switch (key) {
    case "pid":
      return row.identity.pid;
    case "command":
      return commandLabel(row);
    case "state":
      return row.state.value;
    case "cpuMs":
      return sortableValue(row.cpuTimeMs);
    case "rssBytes":
      return sortableValue(row.rssBytes);
    case "pssBytes":
      return sortableValue(row.pssBytes);
    case "threads":
      return sortableValue(row.threads);
    case "readBytes":
      return sortableValue(row.readBytes);
    case "writeBytes":
      return sortableValue(row.writeBytes);
  }
}

/**
 * The command a row is searched and sorted by.
 *
 * `argv[0]` when the kernel let us read it, otherwise the kernel's `comm`, and
 * the empty string when neither was readable. Returning "" rather than a
 * placeholder like "-" matters: an unreadable name has to sort and filter as
 * absent, so it cannot be mistaken for a process actually called "-".
 */
export function commandLabel(row: HostProcessRow): string {
  const argv = row.cmdline.value;
  if (argv !== null && argv.length > 0) return argv[0]!;
  return row.name.value ?? "";
}

export function sortRows(rows: readonly HostProcessRow[], key: SortKey, direction: SortDirection): HostProcessRow[] {
  return [...rows].sort((a, b) => compareRows(a, b, key, direction));
}

/**
 * Filter by a free-text query.
 *
 * Searches four things, and the reason two of them are both state-related
 * matters: `state.value` is the kernel's own letter from /proc/<pid>/stat
 * ("S") while `stateName.value` is CAPS's decoding of it ("sleeping"), and
 * `rowState` is CAPS's classification of the row (LIVE, DISAPPEARED,
 * PERMISSION_DENIED). A reader who types "zombie" and a reader who types
 * "DISAPPEARED" are both asking about state, and searching only one spelling
 * makes the other query silently return nothing.
 */
export function filterByQuery(rows: readonly HostProcessRow[], query: string): HostProcessRow[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter(
    (r) =>
      String(r.identity.pid).includes(q) ||
      commandLabel(r).toLowerCase().includes(q) ||
      (r.name.value ?? "").toLowerCase().includes(q) ||
      (r.cmdline.value ?? []).join(" ").toLowerCase().includes(q) ||
      (r.state.value ?? "").toLowerCase().includes(q) ||
      (r.stateName.value ?? "").toLowerCase().includes(q) ||
      r.rowState.toLowerCase().includes(q),
  );
}

/** Keep only rows in the requested lifecycle states. */
export function filterByState(rows: readonly HostProcessRow[], states: readonly ProcessState[]): HostProcessRow[] {
  if (states.length === 0) return [...rows];
  return rows.filter((r) => states.includes(r.rowState));
}

/**
 * Split CAPS-owned work from host processes.
 *
 * Both groups are real and neither implies ownership of the other. A host
 * process is one CAPS did not start and cannot signal; saying otherwise would
 * be a serious overstatement of what this product controls.
 */
export function partitionByOwnership(rows: readonly HostProcessRow[]): {
  capsOwned: HostProcessRow[];
  host: HostProcessRow[];
} {
  const capsOwned: HostProcessRow[] = [];
  const host: HostProcessRow[] = [];
  for (const r of rows) {
    if (r.capsOwned) capsOwned.push(r);
    else host.push(r);
  }
  return { capsOwned, host };
}

export interface TreeNode {
  row: HostProcessRow;
  children: TreeNode[];
  depth: number;
}

/**
 * Build a process forest.
 *
 * A row whose parent is not in the sample is promoted to a root rather than
 * dropped. That happens routinely -- the parent may have exited, or it may
 * belong to a PID namespace CAPS is not sampling -- and dropping the row would
 * make a live process invisible, which is the one thing a process explorer must
 * never do.
 *
 * The `pid` cycle guard is not defensive noise. A malformed or racing sample
 * where A's PPID is B and B's PPID is A would otherwise recurse forever and take
 * the page down, so a node already on the current path is not expanded again.
 */
export function buildTree(rows: readonly HostProcessRow[]): TreeNode[] {
  const byPid = new Map<number, HostProcessRow>();
  for (const r of rows) byPid.set(r.identity.pid, r);

  const childrenOf = new Map<number, HostProcessRow[]>();

  /*
   * A row is either a root or a child. Roots are collected in the same pass.
   *
   * The cycle case needs care and the reason is worth stating, because the
   * obvious implementations are both wrong in a way that matters here.
   *
   * Resolving strictly -- a row is a root only if its parent is not in the
   * sample -- yields an EMPTY forest for a cycle where A's parent is B and B's
   * parent is A. Both processes then disappear from the explorer. That is worse
   * than the infinite recursion it replaces, because a process explorer that
   * hides live processes is lying about the machine.
   *
   * Building from every PID as a potential root instead duplicates rows: a node
   * appears once under its real parent and again as its own root.
   *
   * So: attach children first, then choose roots as the rows that have children
   * which are not on their own ancestor path. Simpler and equivalent: build from
   * all PIDs, mark every row reached as a child, and take what remains. A cycle
   * leaves both members marked, so one is promoted explicitly below.
   */
  const roots: HostProcessRow[] = [];
  const attached = new Set<number>();

  for (const row of rows) {
    const ppid = row.ppid.value;
    const parent = ppid === null ? undefined : byPid.get(ppid);
    // `parent === row` is the self-parent case a kernel cannot produce, but a
    // stale sample can look like it, and treating a row as its own child would
    // recurse forever.
    if (parent === undefined || parent === row) {
      roots.push(row);
      continue;
    }
    const existing = childrenOf.get(parent.identity.pid);
    if (existing === undefined) childrenOf.set(parent.identity.pid, [row]);
    else existing.push(row);
    attached.add(row.identity.pid);
  }

  /*
   * A cycle leaves every member attached to another, so `roots` is empty. Break
   * it by promoting the lowest PID of the unrooted group: the choice is
   * arbitrary, and saying so is better than pretending the kernel told us which
   * process started first.
   */
  if (roots.length === 0 && rows.length > 0) {
    let lowest = rows[0]!;
    for (const row of rows) {
      if (row.identity.pid < lowest.identity.pid) lowest = row;
    }
    roots.push(lowest);
  }

  const build = (row: HostProcessRow, depth: number, onPath: ReadonlySet<number>): TreeNode => {
    const kids = (childrenOf.get(row.identity.pid) ?? [])
      .filter((c) => !onPath.has(c.identity.pid))
      .map((c) => build(c, depth + 1, new Set([...onPath, row.identity.pid])));
    return { row, children: kids, depth };
  };

  return roots
    .map((r) => build(r, 0, new Set([r.identity.pid])))
    .sort((a, b) => a.row.identity.pid - b.row.identity.pid);
}

export function flattenTree(nodes: readonly TreeNode[]): HostProcessRow[] {
  const out: HostProcessRow[] = [];
  const walk = (list: readonly TreeNode[]): void => {
    for (const n of list) {
      out.push(n.row);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** A one-line human summary of a row's identity, never guessing a value. */
export function describeIdentity(row: HostProcessRow): string {
  const ticks = row.identity.startTicks;
  return `pid ${row.identity.pid}, start ticks ${ticks === null ? "unavailable" : ticks}, boot ${
    row.identity.bootId ?? "unavailable"
  }`;
}

/**
 * The confidence a reader should attach to this row's parent relationship.
 *
 * Surfaced rather than hidden, because it changes what the tree view means: a
 * row whose PPID is UNVERIFIED is a leaf as far as CAPS can prove, not
 * definitively a root.
 */
export function relationshipConfidenceOf(row: HostProcessRow): RelationshipConfidence {
  return row.relationshipConfidence.value ?? "UNAVAILABLE";
}

/** How many rows are in each lifecycle state, for the filter's own summary. */
export function countByState(rows: readonly HostProcessRow[]): Record<ProcessState, number> {
  const counts: Record<ProcessState, number> = {
    LIVE: 0,
    EXITED: 0,
    DISAPPEARED: 0,
    PERMISSION_DENIED: 0,
    UNAVAILABLE: 0,
  };
  for (const r of rows) counts[r.rowState] += 1;
  return counts;
}
