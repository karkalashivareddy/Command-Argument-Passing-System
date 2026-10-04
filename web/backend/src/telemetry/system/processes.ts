/**
 * Host process inventory.
 *
 * WHAT A PROCESS ROW IS ALLOWED TO CLAIM
 * --------------------------------------
 * Every row is a `/proc/<pid>` entry read at one instant. Several things can
 * go wrong in the microseconds between enumerating `/proc` and reading a
 * process's files, and each produces a distinct state rather than a zero:
 *
 *   - The process exited and the kernel removed its `/proc` entry. Expected on
 *     a busy host and not an error. State `EXITED`.
 *   - The entry was replaced between the enumeration and the read, so the PID
 *     now belongs to a different process. The read is rejected, because a row
 *     showing one process's command and another's memory is worse than no row.
 *     State `DISAPPEARED`, with the identity mismatch named in the reason.
 *   - The process belongs to another user and procfs is mounted `hidepid=2`,
 *     or the gateway lacks CAP_SYS_PTRACE. State `PERMISSION_DENIED`, with the
 *     fields that *were* readable still populated.
 *   - A field the kernel does not publish for this process. That field alone is
 *     UNAVAILABLE; the rest of the row stands.
 *
 * WHY A BOUNDED SAMPLE
 * --------------------
 * A host with 900 processes needs ~5 file reads each to populate a full row,
 * which is ~4,500 syscalls. Doing that every 500 ms would cost more CPU than
 * most of the workloads being observed. Discovery therefore enumerates cheaply
 * and often, and the expensive per-process field read is budgeted: past
 * `maxSampled` processes the row is emitted with the identity fields only and
 * says so, rather than being silently dropped or silently zeroed.
 */

import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readTextFile, procPath, readBootId, type KernelPaths } from "./read.js";
import { derived, observed, unavailable, type ProcessSummary, type SystemMetric } from "./types.js";
import { buildSmapsRollup, type SmapsRollup } from "./smaps.js";

/**
 * Why a row is in the state it is.
 *
 * `LIVE` means every requested field was read. The other four are not errors
 * in the product; they are statements about what the kernel permitted at that
 * instant, and the UI shows them as badges rather than as failures.
 */
export type ProcessState = "LIVE" | "EXITED" | "DISAPPEARED" | "PERMISSION_DENIED" | "UNAVAILABLE";

/**
 * How well CAPS can support a parent/child claim.
 *
 * Distinct from `ProcessState`, which describes the ROW. This describes the LINK.
 */
export type RelationshipConfidence = "VERIFIED" | "UNVERIFIED" | "UNAVAILABLE";

/** One process as observed. */
export interface HostProcess {
  pid: SystemMetric<number>;
  ppid: SystemMetric<number>;
  /** Identity: (pid, startTicks, bootId). A PID alone is not an identity. */
  identity: ProcessIdentity;
  /**
   * Whether CAPS started this process.
   *
   * `true` means the gateway spawned it and has verified the kernel identity
   * still matches, so it is both attributable and signalable. A host process is
   * never CAPS-owned, and CAPS does not claim otherwise.
   *
   * This is an identity comparison, never a name comparison. Matching on the
   * string "caps" anywhere in a command line would mark unrelated host work as
   * ours, and would miss a real workload whose argv happens not to mention us.
   */
  capsOwned: boolean;
  /**
   * How far the kernel's PPID value can be trusted as a parent link.
   *
   * `VERIFIED` means the parent was itself read in this same sample, so both ends
   * of the link are observed facts and the tree can be drawn. `UNVERIFIED` means
   * the PPID value was read but the parent is not in the sample -- it has exited,
   * or it is outside the namespace being sampled -- so the row is a leaf as far
   * as CAPS can prove. `UNAVAILABLE` means the PPID itself could not be read.
   */
  relationshipConfidence: SystemMetric<RelationshipConfidence>;
  name: SystemMetric<string>;
  cmdline: SystemMetric<string[]>;
  state: SystemMetric<string>;
  /** The kernel's single-letter state letter, decoded. */
  stateName: SystemMetric<string>;
  uid: SystemMetric<number>;
  gid: SystemMetric<number>;
  threads: SystemMetric<number>;
  cpuTimeMs: SystemMetric<number>;
  cpuPercent: SystemMetric<number>;
  rssBytes: SystemMetric<number>;
  /**
   * Proportional set size from smaps_rollup.
   *
   * Always UNAVAILABLE unless PSS was requested, because it is the most
   * expensive read available. Its absence is normal, not a defect.
   */
  pssBytes: SystemMetric<number>;
  anonymousBytes: SystemMetric<number>;
  fileBackedBytes: SystemMetric<number>;
  sharedBytes: SystemMetric<number>;
  swapBytes: SystemMetric<number>;
  virtualMemoryBytes: SystemMetric<number>;
  voluntaryContextSwitches: SystemMetric<number>;
  nonVoluntaryContextSwitches: SystemMetric<number>;
  minorFaults: SystemMetric<number>;
  majorFaults: SystemMetric<number>;
  readBytes: SystemMetric<number>;
  writeBytes: SystemMetric<number>;
  processGroupId: SystemMetric<number>;
  sessionId: SystemMetric<number>;
  cpuAffinity: SystemMetric<string>;
  /** Optional kernel scheduler telemetry. */
  schedulerRuntimeNs: SystemMetric<number>;
  schedulerWaitNs: SystemMetric<number>;
  schedulerTimeslices: SystemMetric<number>;
  /** Which fields were read, which were skipped by budget, which were denied. */
  rowState: ProcessState;
  stateReason: string | null;
  /** True when only identity fields were read because the budget was spent. */
  sampled: boolean;
}

/**
 * The identity tuple.
 *
 * `startTicks` is the crucial part: a PID is reused, and on a long-lived host
 * the same number can be a different process an hour later. `bootId` scopes
 * `startTicks`, which are only meaningful within one boot. Together these
 * three identify a process for as long as the process lives.
 */
export interface ProcessIdentity {
  pid: number;
  startTicks: number | null;
  bootId: string | null;
  /** Stable string form used as a map key across subsystems. */
  key: string;
}

export function identityKey(pid: number, startTicks: number | null, bootId: string | null): string {
  return `${pid}@${startTicks ?? "?"}#${bootId ?? "?"}`;
}

/** The kernel's state letters, from proc_pid_stat(5). */
export const STATE_LETTERS: Readonly<Record<string, string>> = {
  R: "running",
  S: "sleeping",
  D: "uninterruptible sleep",
  Z: "zombie",
  T: "stopped",
  t: "tracing stop",
  X: "dead",
  x: "dead",
  K: "wakekill",
  W: "waking",
  P: "parked",
  I: "idle",
};

/** Carried between samples so cpuPercent and rates can be differenced. */
export interface ProcessPrevious {
  identities: Map<string, ProcessCounters>;
  atMs: number;
}

export interface ProcessCounters {
  cpuTicks: number;
  /** null when the kernel's stat line carried no usable minor_faults value. */
  minorFaults: number | null;
  readBytes: number;
  writeBytes: number;
  startTicks: number;
}

export interface DiscoverOptions {
  maxSampled?: number;
  previous?: ProcessPrevious | null;
  includePss?: boolean;
  pssPids?: readonly number[];
  timestamp: string;
  noteError?: (message: string) => void;
  /**
   * Identity keys -- `pid@startTicks#bootId` -- of the processes the gateway
   * itself started and has verified. Supplied by the caller because only the
   * execution layer knows this; procfs cannot answer it.
   */
  capsOwnedIdentities?: ReadonlySet<string>;
}

export interface DiscoverResult {
  processes: HostProcess[];
  discovered: number;
  sampled: number;
  fieldsUnavailable: number;
  pssSkipped: number;
  previous: ProcessPrevious;
}

const KILOBYTES = 1024;
const NANOSECONDS_PER_MS = 1_000_000;

/** Parse `/proc/<pid>/stat`, using the last ')' because comm may contain one. */
export function parseStatLine(text: string): {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  pgrp: number;
  session: number;
  utime: number;
  stime: number;
  minflt: number | null;
  majflt: number | null;
  threads: number | null;
  startTicks: number;
} | null {
  const open = text.indexOf(" (");
  const close = text.lastIndexOf(")");
  if (open <= 0 || close <= open) return null;
  const pid = Number(text.slice(0, open).trim());
  const comm = text.slice(open + 2, close);
  const f = text.slice(close + 1).trim().split(/\s+/);
  if (f.length < 20) return null;
  const num = (i: number): number | null => {
    const raw = f[i];
    if (raw === undefined || !/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  };
  const state = f[0];
  if (state === undefined || !/^[A-Za-z]$/.test(state)) return null;
  // fields[0] is proc_pid_stat(5) field 3 (state); subtract 3 to reach a
  // 1-based field number. utime is field 14 => index 11.
  const ppid = num(1);
  const pgrp = num(2);
  const session = num(3);
  const utime = num(11);
  const stime = num(12);
  const minflt = num(7);
  const majflt = num(9);
  const threads = num(17);
  const startTicks = num(19);
  if (ppid === null || pgrp === null || session === null || utime === null || stime === null || startTicks === null) return null;
  return {
    pid,
    comm,
    state,
    ppid,
    pgrp,
    session,
    utime,
    stime,
    /*
     * minor_faults, major_faults and num_threads are carried through as null
     * when the kernel's own line does not contain a usable number for them.
     *
     * They used to be defaulted here, as `minflt ?? 0`, `majflt ?? 0` and
     * `threads ?? 1`. That is three fabricated measurements, and each one is
     * wrong in a direction that matters:
     *
     *   - 0 minor faults says the process has never taken a page fault, which
     *     no process on a Linux host can be true of after startup;
     *   - 0 major faults says the process has never paged in from disk, which
     *     reads as "no disk pressure" on a page-fault chart;
     *   - 1 thread says the process is single-threaded, which is the basis of
     *     every "threads per process" figure in the UI.
     *
     * A kernel that publishes zero is a real zero and is preserved. A field the
     * kernel did not publish is UNAVAILABLE, and the caller turns null into an
     * explicit UNAVAILABLE metric with a reason rather than a number.
     */
    minflt,
    majflt,
    threads,
    startTicks,
  };
}

function statusMap(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    out.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return out;
}

function kibToBytes(status: Map<string, string>, key: string): number | null {
  const raw = status.get(key);
  if (raw === undefined) return null;
  const m = /^(\d+)\s+kB$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n * KILOBYTES : null;
}

function statusUint(status: Map<string, string>, key: string): number | null {
  const raw = status.get(key);
  if (raw === undefined) return null;
  const token = raw.trim().split(/\s+/)[0];
  if (token === undefined || !/^\d+$/.test(token)) return null;
  const n = Number(token);
  return Number.isSafeInteger(n) ? n : null;
}

/** Split NUL-separated `/proc/<pid>/cmdline` into arguments. */
export function parseCmdline(text: string): string[] {
  // A kernel thread has an empty cmdline. That is a real fact, not a failure,
  // so it is reported as an empty argv rather than UNAVAILABLE.
  const trimmed = text.replace(/\0+$/, "");
  if (trimmed === "") return [];
  return trimmed.split("\0");
}

/** One process row plus the counters to carry into the next sample. */
export interface HostProcessResult {
  row: HostProcess;
  counters: ProcessCounters | null;
}

/**
 * Read one process.
 *
 * Returns a fully-populated row, or a row whose fields are individually
 * UNAVAILABLE with the kernel's own reason. It never throws for a process that
 * disappeared.
 */
export function readHostProcess(
  paths: KernelPaths,
  pid: number,
  clockTicks: number | null,
  bootId: string | null,
  previous: ProcessCounters | null,
  nowMs: number,
  previousAtMs: number | null,
  options: { includePss: boolean; smaps: SmapsRollup | null; timestamp: string },
): HostProcessResult {
  const root = procPath(paths, String(pid));
  const statPath = `${root}/stat`;

  const statRead = readTextFile(statPath);
  if (!statRead.ok) {
    const exited = statRead.failure.kind === "missing";
    const reason = statRead.failure.reason;
    const state: ProcessState = exited ? "EXITED" : statRead.failure.kind === "permission" ? "PERMISSION_DENIED" : "UNAVAILABLE";
    return { row: emptyRow(pid, bootId, state, reason, options.timestamp, statPath), counters: null };
  }

  const stat = parseStatLine(statRead.text);
  if (stat === null) {
    return { row: emptyRow(pid, bootId, "UNAVAILABLE", "/proc/<pid>/stat was readable but did not parse as a process stat line", options.timestamp, statPath), counters: null };
  }

  // PID reuse detection. If the kernel gave us a different process than the one
  // sampled last time, every counter in this row belongs to that other
  // process, and reporting it under the old identity would be a lie. The row
  // is reported as DISAPPEARED and the counters are not differenced.
  let counters: ProcessCounters | null = null;
  let cpuPercent: SystemMetric<number>;
  if (previous === null) {
    cpuPercent = unavailable<number>("%", statPath, options.timestamp, "First sample of this process identity: CPU utilization needs two samples separated by a measured interval");
  } else if (previous.startTicks !== stat.startTicks) {
    cpuPercent = unavailable<number>("%", statPath, options.timestamp, "The PID was reused: start ticks changed between samples, so the previous counters belong to a different process and cannot be differenced against these");
  } else if (previousAtMs === null || nowMs - previousAtMs <= 0 || clockTicks === null) {
    cpuPercent = unavailable<number>("%", statPath, options.timestamp, "No measurable interval between the two samples, or the kernel clock tick rate is unavailable");
  } else {
    const dTicks = stat.utime + stat.stime - previous.cpuTicks;
    const intervalMs = nowMs - previousAtMs;
    cpuPercent =
      dTicks < 0
        ? unavailable<number>("%", statPath, options.timestamp, "The process CPU counter decreased between samples, which does not happen for a single process identity")
        : derived((dTicks / clockTicks / (intervalMs / 1000)) * 100, "%", `${statPath} utime+stime, delta of two samples`, options.timestamp, "delta(utime + stime) / CLK_TCK / interval_seconds * 100. 100% means one logical CPU fully occupied by this process; a multithreaded process may legitimately exceed 100%.");
    counters = {
      cpuTicks: stat.utime + stat.stime,
      minorFaults: stat.minflt,
      readBytes: previous.readBytes,
      writeBytes: previous.writeBytes,
      startTicks: stat.startTicks,
    };
  }

  const statusRead = readTextFile(`${root}/status`);
  const status = statusRead.ok ? statusMap(statusRead.text) : new Map<string, string>();
  const statusReason = statusRead.ok ? null : statusRead.failure.reason;

  /*
   * Classify a failed /proc/<pid>/status read by what actually happened.
   *
   * This used to be `statusRead.ok ? "LIVE" : "PERMISSION_DENIED"`, which
   * reported a process that simply exited as one whose memory CAPS was forbidden
   * to read. Those are opposite claims with opposite consequences: a permission
   * problem is an operator-actionable host configuration fact, while a vanished
   * /proc entry is the single most ordinary event on a busy host. Reporting
   * routine churn as a permissions failure trains an operator to ignore the
   * badge that matters.
   *
   * The distinction is entirely in the failure kind the read already reported:
   *
   *   missing     the kernel removed the entry between the stat read and this
   *               one. EXITED is the truth: this process really did stop
   *               existing partway through being sampled.
   *   permission  hidepid=2, another user, or no CAP_SYS_PTRACE.
   *               PERMISSION_DENIED is the truth.
   *   malformed   the file exists and is not what a status file is. That is a
   *               kernel or container artefact, not a permission decision.
   *   io          anything else, including a symlink loop. UNAVAILABLE.
   *
   * The stat read succeeded, so the fields it produced are real and stay
   * populated. Only the row's state changes.
   */
  const statusState: ProcessState = statusRead.ok
    ? "LIVE"
    : statusRead.failure.kind === "missing"
      ? "EXITED"
      : statusRead.failure.kind === "permission"
        ? "PERMISSION_DENIED"
        : "UNAVAILABLE";
  const statusStateReason: string | null = statusRead.ok
    ? null
    : statusRead.failure.kind === "missing"
      ? `/proc/${pid}/stat was readable, then /proc/${pid}/status no longer existed: the process exited between the two reads. ${statusRead.failure.reason}. The fields read from stat are the ones this process actually published; nothing has been substituted for the missing ones.`
      : statusRead.failure.reason;

  // The PID in /proc/<pid>/status is the kernel's own cross-check that the
  // directory still refers to the process we think it does.
  const statusPid = statusPidOf(status);
  if (statusPid !== null && statusPid !== pid) {
    return { row: emptyRow(pid, bootId, "DISAPPEARED", `/proc/${pid}/status reports PID ${statusPid}; the directory was replaced between reads, so this row has been discarded rather than mixed across two processes`, options.timestamp, `${root}/status`), counters: null };
  }

  const identity: ProcessIdentity = { pid, startTicks: stat.startTicks, bootId, key: identityKey(pid, stat.startTicks, bootId) };

  const cmdlineRead = readTextFile(`${root}/cmdline`);
  const cpuTicksTotal = stat.utime + stat.stime;
  const cpuTimeMs =
    clockTicks === null
      ? unavailable<number>("ms", statPath, options.timestamp, "Kernel clock tick rate (_SC_CLK_TCK) is unavailable, so ticks cannot be converted to milliseconds")
      : derived((cpuTicksTotal / clockTicks) * 1000, "ms", `${statPath} utime + stime`, options.timestamp, "(utime + stime) / _SC_CLK_TCK * 1000. Cumulative CPU time consumed by this process across all threads.");

  const ioRead = readTextFile(`${root}/io`);
  const io = ioRead.ok ? parseIo(ioRead.text) : new Map<string, number>();
  const ioReason = ioRead.ok ? null : ioRead.failure.reason;

  const schedRead = readTextFile(`${root}/schedstat`);
  const sched = schedRead.ok ? parseSchedstat(schedRead.text, options.timestamp) : null;
  const schedReason = schedRead.ok
    ? null
    : schedRead.failure.kind === "missing"
      ? "This kernel does not expose /proc/<pid>/schedstat. It is CONFIG_SCHEDSTATS-gated, so its absence is normal and not a permission problem."
      : schedRead.failure.reason;

  const affinityRead = readTextFile(`${root}/status`);
  const affinity =
    affinityRead.ok && status.has("Cpus_allowed_list")
      ? observed(status.get("Cpus_allowed_list")!, "1", `${root}/status Cpus_allowed_list`, options.timestamp, "CPUs this process is permitted to run on")
      : unavailable<string>("1", `${root}/status Cpus_allowed_list`, options.timestamp, statusReason ?? "Cpus_allowed_list is absent from this kernel's /proc/<pid>/status");

  const stateLetter = stat.state;
  const nameFromStat = stat.comm;
  const commandLineName = cmdlineRead.ok && parseCmdline(cmdlineRead.text).length > 0 ? parseCmdline(cmdlineRead.text)[0]! : null;

  const row: HostProcess = {
    pid: observed(stat.pid, "1", statPath, options.timestamp, "Process ID as the kernel reports it in /proc/<pid>/stat"),
    ppid: observed(stat.ppid, "1", statPath, options.timestamp, "Parent process ID. Not a verified parent relationship: a process re-parented to init on its parent's exit still reports that PPID value."),
    identity,
    // Settled by `annotateRelationships` once the whole sample is known: both
    // answers depend on processes outside this one row.
    capsOwned: false,
    relationshipConfidence: unavailable<RelationshipConfidence>("1", statPath, options.timestamp, "Not settled yet: the parent link can only be judged against the rest of the sample"),
    name: observed(commandLineName ?? nameFromStat, "1", cmdlineRead.ok ? `${root}/cmdline` : statPath, options.timestamp, "argv[0] when readable, otherwise the kernel's comm field, which is truncated to 15 characters"),
    cmdline:
      cmdlineRead.ok
        ? observed(parseCmdline(cmdlineRead.text), "1", `${root}/cmdline`, options.timestamp, "Arguments as the kernel holds them. Empty for a kernel thread, which is a fact rather than a failure.")
        : unavailable<string[]>("1", `${root}/cmdline`, options.timestamp, cmdlineRead.failure.reason),
    state: observed(stateLetter, "1", statPath, options.timestamp, "Single-letter process state from proc_pid_stat(5)"),
    stateName: observed(STATE_LETTERS[stateLetter] ?? `unknown state letter "${stateLetter}"`, "1", statPath, options.timestamp, "Decoded form of the state letter"),
    uid: (() => {
      const v = statusUint(status, "Uid");
      return v === null ? unavailable<number>("1", `${root}/status Uid`, options.timestamp, statusReason ?? "Uid is absent from this process's status") : observed(v, "1", `${root}/status Uid`, options.timestamp, "Real user ID");
    })(),
    gid: (() => {
      const v = statusUint(status, "Gid");
      return v === null ? unavailable<number>("1", `${root}/status Gid`, options.timestamp, statusReason ?? "Gid is absent from this process's status") : observed(v, "1", `${root}/status Gid`, options.timestamp, "Real group ID");
    })(),
    threads: metricOrUnavailable(
      stat.threads,
      "1",
      `${statPath} field 20 (num_threads)`,
      options.timestamp,
      "The kernel's stat line for this process did not contain a readable num_threads value",
      "Thread count from /proc/<pid>/stat field 20. Linux publishes a real 0 only for a process that has not yet created its first thread; an unreadable field is UNAVAILABLE, not zero.",
    ),
    cpuTimeMs,
    cpuPercent,
    rssBytes: metricOrUnavailable(kibToBytes(status, "VmRSS"), "bytes", `${root}/status VmRSS`, options.timestamp, statusReason ?? "VmRSS is absent from this process's status"),
    pssBytes: options.smaps !== null ? options.smaps.pss : unavailable<number>("bytes", `${root}/smaps_rollup`, options.timestamp, "PSS was not read for this process on this sample. It is deliberately excluded from the fast cadence because smaps is the most expensive read Linux offers; request it for a specific process instead."),
    anonymousBytes: options.smaps !== null ? options.smaps.anonymous : unavailable<number>("bytes", `${root}/smaps_rollup`, options.timestamp, "Not read on this sample: PSS detail is only taken on the slow pass or on demand"),
    fileBackedBytes: options.smaps !== null ? options.smaps.fileBacked : unavailable<number>("bytes", `${root}/smaps_rollup`, options.timestamp, "Not read on this sample: PSS detail is only taken on the slow pass or on demand"),
    sharedBytes: (() => {
      const v = kibToBytes(status, "RssShmem");
      return v === null ? unavailable<number>("bytes", `${root}/status RssShmem`, options.timestamp, statusReason ?? "RssShmem is absent from this process's status") : observed(v, "bytes", `${root}/status RssShmem`, options.timestamp, "Resident shared memory (shmem) mappings");
    })(),
    swapBytes: (() => {
      const v = kibToBytes(status, "VmSwap");
      return v === null ? unavailable<number>("bytes", `${root}/status VmSwap`, options.timestamp, statusReason ?? "VmSwap is absent, which is normal for a process with no swapped pages") : observed(v, "bytes", `${root}/status VmSwap`, options.timestamp, "Swapped-out anonymous memory belonging to this process");
    })(),
    virtualMemoryBytes: metricOrUnavailable(kibToBytes(status, "VmSize"), "bytes", `${root}/status VmSize`, options.timestamp, statusReason ?? "VmSize is absent from this process's status"),
    voluntaryContextSwitches: metricOrUnavailable(statusUint(status, "voluntary_ctxt_switches"), "1", `${root}/status voluntary_ctxt_switches`, options.timestamp, statusReason ?? "voluntary_ctxt_switches is absent from this process's status"),
    nonVoluntaryContextSwitches: metricOrUnavailable(statusUint(status, "nonvoluntary_ctxt_switches"), "1", `${root}/status nonvoluntary_ctxt_switches`, options.timestamp, statusReason ?? "nonvoluntary_ctxt_switches is absent from this process's status"),
    minorFaults: metricOrUnavailable(
      stat.minflt,
      "1",
      `${statPath} field 10 (minflt)`,
      options.timestamp,
      "The kernel's stat line for this process did not contain a readable minor_faults value",
      "minor_faults field: faults that did not require disk I/O, usually first-touch or copy-on-write",
    ),
    majorFaults: metricOrUnavailable(
      stat.majflt,
      "1",
      `${statPath} field 12 (majflt)`,
      options.timestamp,
      "The kernel's stat line for this process did not contain a readable major_faults value",
      "major_faults field: faults that required disk I/O, the ones that indicate real paging",
    ),
    readBytes: ioMetric(io, "read_bytes", `${root}/io read_bytes`, options.timestamp, ioReason),
    writeBytes: ioMetric(io, "write_bytes", `${root}/io write_bytes`, options.timestamp, ioReason),
    processGroupId: observed(stat.pgrp, "1", statPath, options.timestamp, "Process group ID. Group membership is a kernel fact; a process may be in a group led by a process that has already exited."),
    sessionId: observed(stat.session, "1", statPath, options.timestamp, "Session ID, i.e. the controlling terminal's session"),
    cpuAffinity: affinity,
    schedulerRuntimeNs: sched !== null ? sched.runtime : unavailable<number>("ns", `${root}/schedstat`, options.timestamp, schedReason ?? "schedstat unavailable"),
    schedulerWaitNs: sched !== null ? sched.wait : unavailable<number>("ns", `${root}/schedstat`, options.timestamp, schedReason ?? "schedstat unavailable"),
    schedulerTimeslices: sched !== null ? sched.timeslices : unavailable<number>("1", `${root}/schedstat`, options.timestamp, schedReason ?? "schedstat unavailable"),
    rowState: statusState,
    stateReason: statusStateReason,
    sampled: true,
  };

  if (counters !== null) {
    // Carry the disk-side counters forward so the next delta is meaningful.
    counters.readBytes = io.get("read_bytes") ?? previous?.readBytes ?? 0;
    counters.writeBytes = io.get("write_bytes") ?? previous?.writeBytes ?? 0;
    counters.minorFaults = stat.minflt;
  } else if (previous !== null && previous.startTicks === stat.startTicks) {
    // The process is the same one as last time, so its cumulative counters are
    // still a valid basis for the next delta even though no rate was computed
    // this pass (first sample, or a zero interval).
    counters = {
      cpuTicks: cpuTicksTotal,
      minorFaults: stat.minflt,
      readBytes: io.get("read_bytes") ?? previous.readBytes,
      writeBytes: io.get("write_bytes") ?? previous.writeBytes,
      startTicks: stat.startTicks,
    };
  }

  return { row, counters };
}

function statusPidOf(status: Map<string, string>): number | null {
  const raw = status.get("Pid");
  if (raw === undefined) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

function metricOrUnavailable(value: number | null, unit: string, source: string, timestamp: string, reason: string, note?: string): SystemMetric<number> {
  return value === null
    ? unavailable<number>(unit, source, timestamp, reason)
    : observed(value, unit, source, timestamp, note ?? "As published by the kernel in this process's /proc entry");
}

function ioMetric(io: Map<string, number>, key: string, source: string, timestamp: string, reason: string | null): SystemMetric<number> {
  const v = io.get(key);
  if (v !== undefined) {
    return observed(v, "bytes", source, timestamp, "Bytes this process asked the block layer to transfer. /proc/<pid>/io is readable only by the process owner or a process with CAP_SYS_PTRACE.");
  }
  return unavailable<number>("bytes", source, timestamp, reason ?? `${key} is absent from /proc/<pid>/io`);
}

function parseIo(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (key !== "read_bytes" && key !== "write_bytes" && key !== "rchar" && key !== "wchar") continue;
    const n = Number(line.slice(colon + 1).trim());
    if (Number.isSafeInteger(n) && n >= 0) out.set(key, n);
  }
  return out;
}

/**
 * Parse `/proc/<pid>/schedstat`.
 *
 * Three whitespace-separated numbers: time spent on the CPU in nanoseconds,
 * time spent waiting on a runqueue in nanoseconds, and the number of timeslices
 * the process has received. CONFIG_SCHEDSTATS gates the file, so it is
 * legitimately absent on many kernels.
 */
export function parseSchedstat(
  text: string,
  timestamp: string,
): { runtime: SystemMetric<number>; wait: SystemMetric<number>; timeslices: SystemMetric<number> } | null {
  const f = text.trim().split(/\s+/);
  if (f.length < 3) return null;
  const nums = f.slice(0, 3).map((v) => (/^\d+$/.test(v) ? Number(v) : Number.NaN));
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const source = "/proc/<pid>/schedstat";
  return {
    runtime: observed(nums[0]!, "ns", `${source} field 1`, timestamp, "Time the process spent scheduled on a CPU, in nanoseconds. Optional kernel telemetry: the file is gated by CONFIG_SCHEDSTATS."),
    wait: observed(nums[1]!, "ns", `${source} field 2`, timestamp, "Time the process spent waiting on a runqueue, in nanoseconds. This is the scheduler's own view of contention, and is independent of pressure stall information."),
    timeslices: observed(nums[2]!, "1", `${source} field 3`, timestamp, "Number of timeslices the process has been scheduled"),
  };
}

function emptyRow(pid: number, bootId: string | null, state: ProcessState, reason: string, timestamp: string, source: string): HostProcess {
  const bad = <T>(unit: string): SystemMetric<T> => unavailable<T>(unit, source, timestamp, reason);
  const identity: ProcessIdentity = { pid, startTicks: null, bootId, key: identityKey(pid, null, bootId) };
  return {
    pid: bad("1"),
    ppid: bad("1"),
    identity,
    // Both are settled by `annotateRelationships` once the whole sample is
    // known. Claiming them here would mean either guessing or reading /proc twice.
    capsOwned: false,
    relationshipConfidence: bad("1"),
    name: bad("1"),
    cmdline: bad("1"),
    state: bad("1"),
    stateName: bad("1"),
    uid: bad("1"),
    gid: bad("1"),
    threads: bad("1"),
    cpuTimeMs: bad("ms"),
    cpuPercent: bad("%"),
    rssBytes: bad("bytes"),
    pssBytes: bad("bytes"),
    anonymousBytes: bad("bytes"),
    fileBackedBytes: bad("bytes"),
    sharedBytes: bad("bytes"),
    swapBytes: bad("bytes"),
    virtualMemoryBytes: bad("bytes"),
    voluntaryContextSwitches: bad("1"),
    nonVoluntaryContextSwitches: bad("1"),
    minorFaults: bad("1"),
    majorFaults: bad("1"),
    readBytes: bad("bytes"),
    writeBytes: bad("bytes"),
    processGroupId: bad("1"),
    sessionId: bad("1"),
    cpuAffinity: bad("1"),
    schedulerRuntimeNs: bad("ns"),
    schedulerWaitNs: bad("ns"),
    schedulerTimeslices: bad("1"),
    rowState: state,
    stateReason: reason,
    sampled: false,
  };
}

/** Count unreadable fields, so a partial row is visible as partial. */
function countUnavailable(row: HostProcess): number {
  const values = Object.values(row) as unknown[];
  let n = 0;
  for (const v of values) {
    if (typeof v === "object" && v !== null && "provenance" in v) {
      if ((v as { provenance: string }).provenance === "UNAVAILABLE") n += 1;
    }
  }
  return n;
}

/**
 * Enumerate `/proc` and read a bounded sample of processes.
 *
 * Ordering matters: PIDs are read in ascending numeric order so the sample is
 * deterministic for a given `/proc` state, and the first `maxSampled` numeric
 * entries are the ones that get a full field read. That is a budget, not a
 * priority scheme, and `sampled` on each row says whether it was spent, so the
 * UI can state the number of processes it did not detail rather than implying
 * the list is complete.
 */
export function discoverProcesses(paths: KernelPaths, options: DiscoverOptions): DiscoverResult {
  const maxSampled = options.maxSampled ?? CADENCE_FALLBACK_MAX_SAMPLED;
  const bootId = readBootId(paths);
  const clockTicks = probeClockTicks();
  const nowMs = Date.now();
  const previousAtMs = options.previous?.atMs ?? null;
  const noteError = options.noteError ?? ((): void => undefined);

  let names: string[];
  try {
    names = readdirSync(paths.proc);
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as NodeJS.ErrnoException).code) : "UNKNOWN";
    noteError(`process discovery: ${paths.proc} could not be listed (${code})`);
    return { processes: [], discovered: 0, sampled: 0, fieldsUnavailable: 0, pssSkipped: 0, previous: { identities: new Map(), atMs: nowMs } };
  }

  // Only fully numeric entries are processes. Filtering by pattern rather than
  // by Number() avoids accepting "+12" or " 12" style names.
  const pids = names
    .filter((n) => /^\d+$/.test(n))
    .map((n) => Number(n))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .sort((a, b) => a - b);

  const nextCounters = new Map<string, ProcessCounters>();
  const processes: HostProcess[] = [];
  let sampled = 0;
  let fieldsUnavailable = 0;
  let pssSkipped = 0;

  for (const pid of pids) {
    const budgetSpent = sampled >= maxSampled;
    // The identity-only read is what the budget applies to: without a
    // start-ticks read there is no identity, and the row cannot be trusted
    // across samples.
    const result = readHostProcess(
      paths,
      pid,
      clockTicks,
      bootId,
      null,
      nowMs,
      previousAtMs,
      { includePss: false, smaps: null, timestamp: options.timestamp },
    );

    if (budgetSpent) {
      pssSkipped += 1;
      if (result.row.rowState === "EXITED") continue;
      processes.push({ ...result.row, sampled: false, stateReason: `Not detailed on this pass: the per-process sample budget of ${maxSampled} was reached. ${result.row.stateReason ?? ""}`.trim() });
      continue;
    }

    sampled += 1;
    if (result.counters !== null) nextCounters.set(result.row.identity.key, result.counters);
    fieldsUnavailable += countUnavailable(result.row);
    if (result.row.rowState === "EXITED") continue;
    processes.push(result.row);
  }

  annotateRelationships(processes, options.capsOwnedIdentities ?? new Set<string>(), options.timestamp);

  return { processes, discovered: pids.length, sampled, fieldsUnavailable, pssSkipped, previous: { identities: nextCounters, atMs: nowMs } };
}

/**
 * Settle `capsOwned` and `relationshipConfidence` across the whole sample.
 *
 * Neither can be answered one row at a time, which is why they are filled in
 * here rather than in `readHostProcess`:
 *
 *   - ownership asks "did *we* start this?" and the answer lives in the
 *     gateway's execution registry, not in procfs;
 *   - a parent link can only be judged against the rest of the sample, because
 *     "is my parent here" is a question about the sample, not about the row.
 *
 * Ownership is matched on the full identity -- PID *and* start ticks *and* boot
 * id -- because a PID on its own is reused. A row whose PID matches a CAPS
 * session but whose start ticks do not is a different process that inherited the
 * number, and calling it ours would be the most damaging kind of wrong here: it
 * would advertise a process as signalable when CAPS has no handle on it.
 *
 * `sampleContext` exists so a single row read outside the discovery pass -- the
 * Process Detail route -- can be annotated against the SAME inventory the list
 * route serves. Without it the detail view could only see itself, and would
 * report every parent link as UNVERIFIED while the inventory beside it reported
 * VERIFIED: two views of one process disagreeing because one of them was handed
 * less context.
 */
export function annotateRelationships(
  processes: HostProcess[],
  capsOwnedIdentities: ReadonlySet<string>,
  timestamp: string,
  sampleContext?: ReadonlySet<number>,
): void {
  const sampledPids = new Set<number>(sampleContext ?? []);
  for (const p of processes) sampledPids.add(p.identity.pid);

  for (const row of processes) {
    row.capsOwned = capsOwnedIdentities.has(row.identity.key);

    if (row.ppid.value === null) {
      row.relationshipConfidence = unavailable<RelationshipConfidence>(
        "1",
        row.ppid.source,
        timestamp,
        row.ppid.reason ?? "the parent PID could not be read, so there is no link to judge",
      );
      continue;
    }

    if (sampledPids.has(row.ppid.value)) {
      row.relationshipConfidence = observed<RelationshipConfidence>(
        "VERIFIED",
        "1",
        row.ppid.source,
        timestamp,
        `The kernel reports PPID ${row.ppid.value}, and that process was itself read in this sample, so both ends of the link are observed.`,
      );
      continue;
    }

    row.relationshipConfidence = observed<RelationshipConfidence>(
      "UNVERIFIED",
      "1",
      row.ppid.source,
      timestamp,
      `The kernel reports PPID ${row.ppid.value}, but that process is not in this sample: it has exited, it is outside the PID namespace being sampled, or the sample budget excluded it. The row is a leaf as far as CAPS can prove, not definitively a root.`,
    );
  }
}

/** Default sample budget, kept local to avoid a circular import with collector. */
const CADENCE_FALLBACK_MAX_SAMPLED = 400;

/**
 * Read PSS for a specific, caller-named set of processes.
 *
 * This is the on-demand path the UI uses when a user selects a process, and it
 * is bounded by the caller rather than by the collector's cadence. It returns a
 * map keyed by PID so the caller can merge the values into existing rows.
 */
export function readPssForPids(
  paths: KernelPaths,
  pids: readonly number[],
  timestamp: string,
): Map<number, SmapsRollup> {
  const out = new Map<number, SmapsRollup>();
  for (const pid of pids) {
    const rollup = buildSmapsRollup(paths, pid, timestamp);
    if (rollup !== null) out.set(pid, rollup);
  }
  return out;
}

/** `_SC_CLK_TCK`, cached because it is a compile-time constant of the kernel. */
let cachedClockTicks: number | null | undefined;
export function probeClockTicks(): number | null {
  if (cachedClockTicks !== undefined) return cachedClockTicks;
  try {
    // getconf is invoked with an absolute path and no shell, so this cannot be
    // redirected by anything the browser controls.
    const out = execFileSync("/usr/bin/getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 250 });
    const n = Number(out.trim());
    cachedClockTicks = Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    cachedClockTicks = null;
  }
  return cachedClockTicks;
}

/** Test seam: forget the cached tick rate. */
export function resetClockTicksCache(): void {
  cachedClockTicks = undefined;
}

/**
 * Aggregate the state counts across a process list.
 *
 * A process the kernel would not let us read is counted as unavailable, not as
 * belonging to any state: it is genuinely in one, and pretending otherwise
 * would misreport the machine as idle.
 */
export function processSummaryFrom(
  processes: readonly HostProcess[],
  timestamp: string,
  extras: { processesCreated: number | null },
): ProcessSummary {
  const where = "/proc/<pid>/stat state field, across the discovered process set";
  let total = 0;
  let running = 0;
  let sleeping = 0;
  let stopped = 0;
  let zombie = 0;
  let uninterruptible = 0;
  let threadsTotal = 0;
  let classified = 0;
  let threadsUnknown = 0;

  for (const p of processes) {
    total += 1;
    if (p.rowState !== "LIVE") continue;
    const letter = p.state.value;
    if (letter === null) continue;
    classified += 1;
    /*
     * A thread count the kernel did not publish is counted as unknown rather
     * than as one thread. `p.threads.value ?? 1` put every unreadable process
     * into threadsTotal as a single-threaded process, which is exactly the
     * fabrication this product exists to avoid: the total was then reported as
     * OBSERVED while N of its contributions were invented.
     *
     * The total is still a sum of real counts -- it just covers fewer processes
     * -- and the reason says how many were excluded, so the figure is readable
     * as "sum over N of M classified processes" instead of as a silent estimate.
     */
    const threads = p.threads.value;
    if (threads === null) {
      threadsUnknown += 1;
    } else {
      threadsTotal += threads;
    }
    switch (letter) {
      case "R": running += 1; break;
      case "S": sleeping += 1; break;
      case "T":
      case "t": stopped += 1; break;
      case "Z": zombie += 1; break;
      case "D": uninterruptible += 1; break;
      default: break;
    }
  }

  const unclassified = total - classified;
  const note = unclassified > 0 ? ` ${unclassified} process(es) could not be classified because the kernel did not permit a status read; they are counted in the total but in no state bucket, rather than being assigned a state they may not be in.` : "";
  const threadsNote =
    threadsUnknown > 0
      ? ` Sum of the thread counts of the ${classified - threadsUnknown} classified process(es) that published one; ${threadsUnknown} did not and are excluded rather than counted as single-threaded.`
      : " Sum of the thread count over classified processes";

  return {
    total: observed(total, "1", where, timestamp, `Numeric /proc/<pid> entries discovered on this pass.${note}`),
    running: observed(running, "1", where, timestamp, "State letter R: currently executing or runnable"),
    sleeping: observed(sleeping, "1", where, timestamp, "State letter S: interruptible sleep, waiting for an event"),
    stopped: observed(stopped, "1", where, timestamp, "State letters T and t: stopped by a job-control or tracing signal"),
    zombie: observed(zombie, "1", where, timestamp, "State letter Z: exited but not yet reaped. A non-trivial zombie count means something is not calling wait()."),
    uninterruptible: observed(uninterruptible, "1", where, timestamp, "State letter D: uninterruptible sleep, usually waiting on block I/O. A sustained D count is a storage problem, not a CPU one."),
    threadsTotal: observed(threadsTotal, "1", where, timestamp, threadsNote),
    processesCreated:
      extras.processesCreated === null
        ? unavailable<number>("1", "/proc/stat processes field", timestamp, "The `processes` field is absent from /proc/stat on this kernel")
        : observed(extras.processesCreated, "1", "/proc/stat processes field", timestamp, "Forks completed since boot, cumulative"),
  };
}

export { NANOSECONDS_PER_MS };
