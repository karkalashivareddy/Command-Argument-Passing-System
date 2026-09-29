import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { FIRST_SAMPLE_RATE_REASON } from "./derive.js";
import { SNAPSHOT_METRIC_KEYS, type Metric, type ProcessSnapshot, type Provenance } from "./types.js";

/**
 * Cache of stable kernel values.
 *
 * Two values are worth caching: `_SC_CLK_TCK` (a compile-time constant of the
 * running kernel) and `/proc/stat`'s `btime` (fixed for the machine's current
 * boot).  Neither changes while the gateway runs, and re-reading `/proc/stat`
 * on every sample of every process is pure waste on a busy recorder.
 *
 * The cache is an explicit, injectable object rather than a module-level
 * variable.  A hidden global would make test results depend on the order tests
 * happen to run in: whichever test read the cache first would decide the
 * value every later test saw.
 */
export class KernelValueCache {
  private readonly clockTicks = new Map<string, number | null>();
  private readonly bootTime = new Map<string, number | null>();

  clockTicksPerSecond(procRoot: string, read: () => number | null): number | null {
    const key = `${procRoot}|${read.name}`;
    if (this.clockTicks.has(key)) return this.clockTicks.get(key)!;
    const value = read();
    this.clockTicks.set(key, value);
    return value;
  }

  bootTimeSeconds(procRoot: string, read: () => number | null): number | null {
    const key = procRoot;
    if (this.bootTime.has(key)) return this.bootTime.get(key)!;
    const value = read();
    this.bootTime.set(key, value);
    return value;
  }

  clear(): void {
    this.clockTicks.clear();
    this.bootTime.clear();
  }
}

/** Process-wide cache. Tests construct their own instead of sharing this. */
export const kernelValues = new KernelValueCache();

/** The global cache, kept for existing callers; prefer injecting KernelValueCache. */
export function resetKernelValueCache(): void {
  kernelValues.clear();
}

export interface ProcStat {
  pid: number;
  command: string;
  state: string;
  ppid: number;
  processGroupId: number;
  sessionId: number;
  userTicks: number;
  systemTicks: number;
  threadCount: number;
  startTicks: number;
  minorFaults: number;
  majorFaults: number;
}

export class ProcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcParseError";
  }
}

/** Parse /proc/<pid>/stat using the last ')' because comm itself may contain ')' and spaces. */
export function parseProcStat(text: string): ProcStat {
  const open = text.indexOf(" (");
  const close = text.lastIndexOf(")");
  if (open <= 0 || close <= open || close + 2 > text.length) throw new ProcParseError("Malformed /proc stat command field");

  const pid = integer(text.slice(0, open).trim());
  const command = text.slice(open + 2, close);
  const fields = text.slice(close + 1).trim().split(/\s+/);
  // fields[0] is field 3 (state) in proc_pid_stat(5).
  if (fields.length < 22 || !/^[A-Za-z]$/.test(fields[0] ?? "")) throw new ProcParseError("Malformed /proc stat fields");

  return {
    pid,
    command,
    state: fields[0]!,
    ppid: integer(fields[1]!),
    processGroupId: integer(fields[2]!),
    sessionId: integer(fields[3]!),
    userTicks: nonNegative(fields[11]!),
    systemTicks: nonNegative(fields[12]!),
    minorFaults: nonNegative(fields[7]!),
    majorFaults: nonNegative(fields[9]!),
    threadCount: nonNegative(fields[17]!),
    startTicks: nonNegative(fields[19]!),
  };
}

export function parseProcStatus(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    result.set(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  return result;
}

export function parseKilobytes(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(\d+)\s+kB$/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n * 1024 : null;
}

/**
 * /proc/<pid>/io fields this gateway understands. Anything else in the
 * file is ignored rather than guessed. syscr/syscw are parsed to confirm the
 * file was readable, but they are not exported as metrics: the gateway
 * reports bytes, not a syscall census.
 */
export interface ProcIo {
  rchar: number;
  wchar: number;
  syscr: number;
  syscw: number;
  readBytes: number;
  writeBytes: number;
}

/** Parse /proc/<pid>/io. Missing keys come back as null, never as 0. */
export function parseProcIo(text: string): Partial<ProcIo> {
  const wanted: Record<string, keyof ProcIo> = {
    rchar: "rchar",
    wchar: "wchar",
    syscr: "syscr",
    syscw: "syscw",
    read_bytes: "readBytes",
    write_bytes: "writeBytes",
  };
  const out: Partial<ProcIo> = {};
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = wanted[line.slice(0, colon).trim()];
    if (key === undefined) continue;
    const n = parseFirstInt(line.slice(colon + 1).trim());
    if (n !== null) out[key] = n;
  }
  return out;
}

/**
 * Kernel clock tick rate.
 *
 * Resolved with `getconf CLK_TCK` from a fixed list of trusted locations, and
 * cached by the caller-supplied `KernelValueCache`.  `getconf` is used rather
 * than a hard-coded 100 because HZ is a kernel build option.
 */
function probeClockTicks(): number | null {
  if (process.platform !== "linux") return null;
  for (const executable of ["/usr/bin/getconf", "/bin/getconf"]) {
    if (!existsSync(executable)) continue;
    const result = spawnSync(executable, ["CLK_TCK"], { encoding: "utf8", timeout: 250, shell: false });
    const hz = Number(result.stdout.trim());
    if (result.status === 0 && Number.isFinite(hz) && hz > 0) return hz;
  }
  return null;
}

export function readClockTicksPerSecond(cache: KernelValueCache = kernelValues): number | null {
  return cache.clockTicksPerSecond("/proc", probeClockTicks);
}

export interface ProcReadOptions {
  procRoot?: string;
  nowMs?: number;
  clockTicksPerSecond?: number | null;
  /** Cache for stable kernel values; pass a fresh one to isolate a test. */
  cache?: KernelValueCache;
}

/**
 * Read every supported metric for one tracked PID in a single pass.
 *
 * This function is the only place that touches procfs. It never guesses: a
 * missing field, an unreadable file, or a parse failure becomes an explicit
 * UNAVAILABLE metric carrying the real kernel reason. Cross-sample rates are
 * filled in afterwards by deriveRates().
 */
export function readProcessSnapshot(pid: number, options: ProcReadOptions = {}): ProcessSnapshot {
  const procRoot = options.procRoot ?? "/proc";
  const nowMs = options.nowMs ?? Date.now();
  const timestamp = new Date(nowMs).toISOString();
  const root = `${procRoot}/${pid}`;
  let stat: ProcStat | null = null;
  let status = new Map<string, string>();
  let io: Partial<ProcIo> = {};
  let unavailableReason: string | null = null;
  let ioUnavailableReason: string | null = null;

  try {
    const parsed = parseProcStat(readFileSync(`${root}/stat`, "utf8"));
    if (parsed.pid !== pid) throw new ProcParseError("/proc stat PID did not match tracked CAPS PID");
    stat = parsed;
  } catch (err) {
    unavailableReason = errorReason(err);
  }
  if (stat !== null) {
    try {
      status = parseProcStatus(readFileSync(`${root}/status`, "utf8"));
    } catch (err) {
      unavailableReason = errorReason(err);
    }
    // /proc/<pid>/io is readable only by the owner (or with CAP_SYS_PTRACE),
    // so an EACCES here is normal and must not be reported as a failure of
    // the whole snapshot.
    try {
      io = parseProcIo(readFileSync(`${root}/io`, "utf8"));
      if (Object.keys(io).length === 0) {
        ioUnavailableReason = "/proc/<pid>/io contained no recognised counters";
      }
    } catch (err) {
      ioUnavailableReason = errorReason(err);
    }
  }

  const cache = options.cache ?? kernelValues;
  const ticks =
    options.clockTicksPerSecond === undefined
      ? readClockTicksPerSecond(cache)
      : options.clockTicksPerSecond;
  const uptimeSeconds = readUptime(procRoot);
  const source = `/proc/${pid}/stat`;
  const sourceStatus = `/proc/${pid}/status`;
  const sourceIo = `/proc/${pid}/io`;
  const sourceDerived = `${source} + ${procRoot}/uptime`;
  const sourceEngine = "gateway child_process.spawn";
  const sourceIdentity = `${source} field 22 + ${procRoot}/stat btime, converted with CLK_TCK`;
  const metric = <T>(value: T, provenance: Provenance, fieldSource: string): Metric<T> => ({ value, provenance, source: fieldSource });
  const unavailable = <T>(fieldSource: string, reason = unavailableReason ?? "Field is absent from this kernel procfs response"): Metric<T> => ({
    value: null,
    provenance: "UNAVAILABLE",
    source: fieldSource,
    reason,
  });
  const missing = <T>(fieldSource: string): Metric<T> => unavailable(fieldSource);

  if (stat === null) {
    // The PID we were asked to sample stays OBSERVED: it came from the CAPS
    // process-start event, not from procfs. Everything procfs would have
    // supplied carries the real kernel reason instead of a value.
    const reason = unavailableReason ?? "Process exited or procfs entry disappeared before sampling";
    const missing = <T>(fieldSource: string): Metric<T> => unavailable<T>(fieldSource, reason);
    const snapshot: ProcessSnapshot = {
      timestamp,
      pid: metric(pid, "OBSERVED", "CAPS PROCESS_STARTED"),
      capsEnginePid: missing(sourceEngine),
      command: missing(source), ppid: missing(source), processGroupId: missing(source), sessionId: missing(source), state: missing(source),
      startTime: missing("DERIVED"), elapsedMs: missing("DERIVED"),
      cpuUserMs: missing("DERIVED"), cpuSystemMs: missing("DERIVED"), cpuTimeMs: missing("DERIVED"), cpuPercent: missing("DERIVED"),
      rssBytes: missing(sourceStatus), virtualMemoryBytes: missing(sourceStatus),
      threadCount: missing(sourceStatus),
      voluntaryContextSwitches: missing(sourceStatus), nonVoluntaryContextSwitches: missing(sourceStatus),
      minorFaults: missing(source), majorFaults: missing(source),
      minorFaultsPerSec: missing("DERIVED"), majorFaultsPerSec: missing("DERIVED"),
      readBytes: missing(sourceIo), writeBytes: missing(sourceIo), rcharBytes: missing(sourceIo), wcharBytes: missing(sourceIo),
      readBytesPerSec: missing("DERIVED"), writeBytesPerSec: missing("DERIVED"), rcharBytesPerSec: missing("DERIVED"), wcharBytesPerSec: missing("DERIVED"),
      identityStartTicks: null,
    };
    return snapshot;
  }

  const elapsedMs = uptimeSeconds === null || ticks === null ? null : Math.max(0, (uptimeSeconds - stat.startTicks / ticks) * 1000);
  const bootSeconds = ticks === null ? null : cache.bootTimeSeconds(procRoot, () => readBootTimeSeconds(procRoot));
  // Stable identity path: a pure function of kernel values, identical for every
  // sample of the same process. The wall-clock path is only a fallback for a
  // kernel that does not publish btime.
  const stableStartMs = bootSeconds === null || ticks === null ? null : Math.round(bootSeconds * 1000 + (stat.startTicks / ticks) * 1000);
  const startMs = stableStartMs ?? (elapsedMs === null ? null : nowMs - elapsedMs);
  const startSource = stableStartMs === null ? sourceDerived : sourceIdentity;
  const timeReason = uptimeSeconds === null ? "Cannot read /proc/uptime" : "Kernel clock tick rate unavailable";
  const statusPid = parseFirstInt(status.get("Pid"));
  const statusPpid = parseFirstInt(status.get("PPid"));
  const threads = parseFirstInt(status.get("Threads"));
  const voluntary = parseFirstInt(status.get("voluntary_ctxt_switches"));
  const involuntary = parseFirstInt(status.get("nonvoluntary_ctxt_switches"));
  const vmRss = parseKilobytes(status.get("VmRSS"));
  const vmSize = parseKilobytes(status.get("VmSize"));
  const ioOrUnavailable = (value: number | undefined): Metric<number> =>
    value === undefined
      ? unavailable(sourceIo, ioUnavailableReason ?? "Counter absent from /proc/<pid>/io")
      : metric(value, "OBSERVED", sourceIo);
  const userMs = ticks === null ? null : (stat.userTicks * 1000) / ticks;
  const systemMs = ticks === null ? null : (stat.systemTicks * 1000) / ticks;
  const cpuTimeMs = userMs === null || systemMs === null ? null : userMs + systemMs;
  const cpuTickSource = `${source} ticks converted with _SC_CLK_TCK`;

  return {
    timestamp,
    pid: metric(stat.pid, "OBSERVED", source),
    capsEnginePid: missing(sourceEngine),
    command: metric(stat.command, "OBSERVED", source),
    ppid: statusPid === null || statusPpid === null ? metric(stat.ppid, "OBSERVED", source) : metric(statusPpid, "OBSERVED", sourceStatus),
    processGroupId: metric(stat.processGroupId, "OBSERVED", source),
    sessionId: metric(stat.sessionId, "OBSERVED", source),
    state: metric(stat.state, "OBSERVED", source),
    startTime: startMs === null ? unavailable("DERIVED", timeReason) : metric(new Date(startMs).toISOString(), "DERIVED", startSource),
    elapsedMs: elapsedMs === null ? unavailable("DERIVED", timeReason) : metric(elapsedMs, "DERIVED", sourceDerived),
    cpuUserMs: userMs === null ? unavailable("DERIVED", "Kernel clock tick rate unavailable") : metric(userMs, "DERIVED", `${cpuTickSource} (utime)`),
    cpuSystemMs: systemMs === null ? unavailable("DERIVED", "Kernel clock tick rate unavailable") : metric(systemMs, "DERIVED", `${cpuTickSource} (stime)`),
    cpuTimeMs: cpuTimeMs === null ? unavailable("DERIVED", "Kernel clock tick rate unavailable") : metric(cpuTimeMs, "DERIVED", `${cpuTickSource} (utime + stime)`),
    cpuPercent: unavailable("DERIVED", FIRST_SAMPLE_RATE_REASON),
    rssBytes: vmRss === null ? unavailable(sourceStatus) : metric(vmRss, "OBSERVED", sourceStatus),
    virtualMemoryBytes: vmSize === null ? unavailable(sourceStatus) : metric(vmSize, "OBSERVED", sourceStatus),
    threadCount: threads === null ? metric(stat.threadCount, "OBSERVED", source) : metric(threads, "OBSERVED", sourceStatus),
    voluntaryContextSwitches: voluntary === null ? unavailable(sourceStatus) : metric(voluntary, "OBSERVED", sourceStatus),
    nonVoluntaryContextSwitches: involuntary === null ? unavailable(sourceStatus) : metric(involuntary, "OBSERVED", sourceStatus),
    minorFaults: metric(stat.minorFaults, "OBSERVED", `${source} field minflt`),
    majorFaults: metric(stat.majorFaults, "OBSERVED", `${source} field majflt`),
    minorFaultsPerSec: unavailable("DERIVED", FIRST_SAMPLE_RATE_REASON),
    majorFaultsPerSec: unavailable("DERIVED", FIRST_SAMPLE_RATE_REASON),
    readBytes: ioOrUnavailable(io.readBytes),
    writeBytes: ioOrUnavailable(io.writeBytes),
    rcharBytes: ioOrUnavailable(io.rchar),
    wcharBytes: ioOrUnavailable(io.wchar),
    readBytesPerSec: unavailable("DERIVED", FIRST_SAMPLE_RATE_REASON),
    writeBytesPerSec: unavailable("DERIVED", FIRST_SAMPLE_RATE_REASON),
    rcharBytesPerSec: unavailable("DERIVED", FIRST_SAMPLE_RATE_REASON),
    wcharBytesPerSec: unavailable("DERIVED", FIRST_SAMPLE_RATE_REASON),
    identityStartTicks: stat.startTicks,
  };
}

/**
 * Blanket UNAVAILABLE pass used when a sample is rejected (identity mismatch)
 * or when procfs could not be read. Driven by the canonical key list, so a
 * newly added metric can never be silently left claiming to be observed.
 * `identityStartTicks` is left untouched: the kernel value we read is the
 * kernel value we read.
 */
export function markUnavailable(snapshot: ProcessSnapshot, reason: string): ProcessSnapshot {
  const out: Record<string, unknown> = { ...snapshot };
  for (const key of SNAPSHOT_METRIC_KEYS) {
    const current = out[key] as Metric<unknown> | undefined;
    out[key] = { value: null, provenance: "UNAVAILABLE", source: current?.source ?? "unavailable", reason };
  }
  return out as unknown as ProcessSnapshot;
}

function readUptime(procRoot: string): number | null {
  try {
    const value = Number(readFileSync(`${procRoot}/uptime`, "utf8").trim().split(/\s+/)[0]);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Boot wall-clock time in whole seconds, read from `/proc/stat` `btime`.
 *
 * The process start time is an identity value: the frontend uses it to refuse a
 * recycled PID, so it must be the SAME string for every sample of one process.
 * Deriving it as `now - (uptime - startTicks/CLK_TCK)` cannot do that, because
 * `/proc/uptime` only advances once per clock tick while `now` advances
 * continuously; the sub-jiffy lag between the two changes the millisecond
 * field from sample to sample and the identity guard then rejects the process's
 * own samples. `btime` is a fixed anchor, so `btime + startTicks/CLK_TCK` is a
 * pure function of the kernel's own values and is stable for the life of the
 * process.
 */
function readBootTimeSeconds(procRoot: string): number | null {
  try {
    for (const line of readFileSync(`${procRoot}/stat`, "utf8").split("\n")) {
      if (!line.startsWith("btime ")) continue;
      const value = Number(line.slice("btime ".length).trim());
      return Number.isFinite(value) && value > 0 ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}

function integer(value: string): number {
  if (!/^-?\d+$/.test(value)) throw new ProcParseError("Invalid integer in /proc stat");
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new ProcParseError("Unsafe integer in /proc stat");
  return n;
}

function nonNegative(value: string): number {
  const n = integer(value);
  if (n < 0) throw new ProcParseError("Unexpected negative value in /proc stat");
  return n;
}

function parseFirstInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const token = value.trim().split(/\s+/)[0];
  if (!token || !/^\d+$/.test(token)) return null;
  const n = Number(token);
  return Number.isSafeInteger(n) ? n : null;
}

function errorReason(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
  if (code === "ENOENT") return "Process exited or procfs entry disappeared before sampling";
  if (code === "EACCES" || code === "EPERM") return "Permission denied while reading procfs";
  return err instanceof Error ? err.message : "Unable to parse procfs response";
}
