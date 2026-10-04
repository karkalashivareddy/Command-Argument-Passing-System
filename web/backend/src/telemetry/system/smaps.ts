/**
 * PSS and smaps-based memory accounting.
 *
 * WHY PSS IS TREATED AS THE PRECISE MEMORY FIGURE
 * ----------------------------------------------
 * `VmRSS` from `/proc/<pid>/status` counts every byte in the process's resident
 * set. When two processes map the same page of a shared library, the kernel
 * accounts that page in *both* processes' RSS. Summing RSS across a host
 * therefore double-counts shared memory and can exceed the machine's physical
 * memory, which is why it is useless for capacity planning.
 *
 * Proportional Set Size fixes this: each shared page is divided by the number
 * of processes mapping it, so summing PSS across all processes yields physical
 * memory. The kernel computes it in `smaps_rollup`, which is a pre-aggregated
 * version of the full `smaps` walk and is far cheaper to read.
 *
 * The cost is still real. `smaps` forces the kernel to walk and fold the
 * process's entire page table, which on a large process is comparable to a
 * page fault storm. Linux documents it as expensive precisely because of this.
 * So:
 *
 *   - PSS is never collected on the fast sampling cadence.
 *   - It is collected for a bounded number of processes per slow pass.
 *   - It is collected on demand for a process the user selected.
 *   - When it has not been read, it is UNAVAILABLE with that reason. It is
 *     never reported as 0, because 0 PSS would mean "this process uses no
 *     memory", which is a different and usually false statement.
 *
 * The distinction between RSS and PSS is not hidden behind a tooltip: the UI
 * presents them as two different metrics with different meanings, and the
 * telemetry contract documents both.
 */

import { readTextFile, procPath, type KernelPaths } from "./read.js";
import { derived, observed, unavailable, type SystemMetric } from "./types.js";

const KILOBYTES = 1024;

/** The smaps_rollup figures this collector reports. */
export interface SmapsRollup {
  pss: SystemMetric<number>;
  rss: SystemMetric<number>;
  anonymous: SystemMetric<number>;
  fileBacked: SystemMetric<number>;
  shared: SystemMetric<number>;
  privateClean: SystemMetric<number>;
  privateDirty: SystemMetric<number>;
  sharedClean: SystemMetric<number>;
  sharedDirty: SystemMetric<number>;
  swap: SystemMetric<number>;
}

/**
 * The exact key strings the kernel writes in `smaps_rollup`, per
 * proc_pid_smaps(5). The casing is significant: the file says `Pss` and
 * `Pss_Anon`, and a lookup that folds case silently finds nothing and would
 * report PSS as unavailable on a kernel that publishes it perfectly well.
 */
const FILE_KEYS = {
  rss: "Rss",
  pss: "Pss",
  anonymous: "Pss_Anon",
  fileBacked: "Pss_File",
  shared: "Pss_Shmem",
  privateClean: "Private_Clean",
  privateDirty: "Private_Dirty",
  sharedClean: "Shared_Clean",
  sharedDirty: "Shared_Dirty",
  swap: "Swap",
} as const;

type SmapsKey = keyof typeof FILE_KEYS;

/** Why smaps_rollup may be absent, stated for the UI. */
export const SMAPS_ABSENT_REASON =
  "smaps_rollup is not available for this process. The file is gated by CONFIG_PROC_PAGE_MONITOR, and reading it additionally requires permission to the process. Its absence is normal and is never reported as a zero memory figure.";

/**
 * Parse `/proc/<pid>/smaps_rollup`.
 *
 * Format: one `Key: <n> kB` line per figure. A kernel may publish a subset, so
 * each key is resolved independently and a missing one becomes UNAVAILABLE
 * rather than 0.
 */
export function parseSmapsRollup(text: string, source: string, timestamp: string): SmapsRollup | null {
  const byKey = new Map<string, number>();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    const m = /^(\d+)\s+kB$/.exec(raw);
    if (m === null) continue;
    const n = Number(m[1]);
    if (!Number.isSafeInteger(n)) continue;
    byKey.set(key, n);
  }
  if (byKey.size === 0) return null;

  const lookup = (key: SmapsKey, label: string, note: string): SystemMetric<number> => {
    const fileKey = FILE_KEYS[key];
    const kib = byKey.get(fileKey);
    if (kib === undefined) {
      return unavailable<number>("bytes", source, timestamp, `${fileKey} is absent from this kernel's smaps_rollup`);
    }
    return derived(kib * KILOBYTES, "bytes", source, timestamp, note);
  };

  const pss = lookup("pss", "PSS", "Proportional Set Size in bytes: each shared page divided by the number of processes mapping it, so summing PSS across all processes equals physical memory. This is the precise memory-accounting path; RSS is not.");
  return {
    pss,
    rss: lookup("rss", "RSS", "Resident set size in bytes, as the kernel computes it while walking the page table. Counts shared pages in full for every mapping process, so it must not be summed across processes."),
    anonymous: lookup("anonymous", "Pss_Anon", "Anonymous (non-file-backed) PSS in bytes"),
    fileBacked: lookup("fileBacked", "Pss_File", "File-backed PSS in bytes: pages backed by a file, which may be evicted under pressure"),
    shared: lookup("shared", "Pss_Shmem", "Shared-memory (shmem) PSS in bytes"),
    privateClean: lookup("privateClean", "Private_Clean", "Private clean pages: process-private and already on disk, so reclaimable without swapping"),
    privateDirty: lookup("privateDirty", "Private_Dirty", "Private dirty pages: process-private and must be written to disk before they can be reclaimed"),
    sharedClean: lookup("sharedClean", "Shared_Clean", "Shared clean pages"),
    sharedDirty: lookup("sharedDirty", "Shared_Dirty", "Shared dirty pages"),
    swap: lookup("swap", "Swap", "Swapped PSS in bytes, as computed by the kernel's page-table walk"),
  };
}

/**
 * Read PSS for one process.
 *
 * Returns `null` when the file is absent or unreadable, so the caller can keep
 * the metric UNAVAILABLE without inventing a value. The caller supplies the
 * reason, because "not read this sample" and "denied by the kernel" are
 * different situations that the UI words differently.
 */
export function buildSmapsRollup(paths: KernelPaths, pid: number, timestamp: string): SmapsRollup | null {
  const path = procPath(paths, String(pid), "smaps_rollup");
  const result = readTextFile(path);
  if (!result.ok) return null;
  return parseSmapsRollup(result.text, path, timestamp);
}

/**
 * Probe whether this kernel supports smaps at all, using the gateway's own
 * `/proc/self/smaps_rollup`.
 *
 * Checked once because the answer is a kernel build option, and a UI that can
 * say "this kernel does not support PSS at all" is more useful than one that
 * shows 400 processes each individually missing a PSS value.
 */
export function probeSmapsSupport(paths: KernelPaths, timestamp: string): SystemMetric<boolean> {
  const path = procPath(paths, "self", "smaps_rollup");
  const result = readTextFile(path);
  if (!result.ok) {
    return unavailable<boolean>(
      "1",
      path,
      timestamp,
      result.failure.kind === "missing"
        ? `${SMAPS_ABSENT_REASON} The gateway's own smaps_rollup is absent, so CONFIG_PROC_PAGE_MONITOR is not enabled on this kernel.`
        : `${SMAPS_ABSENT_REASON} The gateway's own smaps_rollup could not be read: ${result.failure.reason}`,
    );
  }
  const parsed = parseSmapsRollup(result.text, path, timestamp);
  if (parsed === null) {
    return unavailable<boolean>("1", path, timestamp, "smaps_rollup was readable but contained no recognisable kB figures");
  }
  return observed(true, "1", path, timestamp, "The gateway could read its own smaps_rollup, so PSS is available on this kernel");
}
