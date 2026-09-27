import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

let cachedClockTicks: number | null | undefined;

export type Provenance = "OBSERVED" | "DERIVED" | "UNAVAILABLE";

export interface Metric<T> {
  value: T | null;
  provenance: Provenance;
  source: string;
  reason?: string;
}

export interface ProcessSnapshot {
  timestamp: string;
  capsEnginePid: Metric<number>;
  pid: Metric<number>;
  command: Metric<string>;
  ppid: Metric<number>;
  processGroupId: Metric<number>;
  sessionId: Metric<number>;
  state: Metric<string>;
  startTime: Metric<string>;
  elapsedMs: Metric<number>;
  cpuUserMs: Metric<number>;
  cpuSystemMs: Metric<number>;
  cpuPercent: Metric<number>;
  rssBytes: Metric<number>;
  virtualMemoryBytes: Metric<number>;
  threadCount: Metric<number>;
  voluntaryContextSwitches: Metric<number>;
  nonVoluntaryContextSwitches: Metric<number>;
  /**
   * Page-fault counters from /proc/<pid>/stat fields 10 and 12 (minflt,
   * majflt). A CPU-only run stays near zero; a memory workload that
   * touches a fresh anonymous mapping produces a visible minor-fault ramp.
   */
  minorFaults: Metric<number>;
  majorFaults: Metric<number>;
  /**
   * /proc/<pid>/io counters. Character counters (readChars/writeChars)
   * count bytes moved through the syscall layer and are always non-zero
   * for a real read/write loop. Block counters (readBytes/writeBytes)
   * count bytes that actually reached a block device, so they legitimately
   * stay 0 while the page cache absorbs writes. Both are reported; neither
   * is synthesised.
   */
  readBytes: Metric<number>;
  writeBytes: Metric<number>;
  readChars: Metric<number>;
  writeChars: Metric<number>;
  /** Internal identity token used to reject a recycled PID during one execution. */
  identityStartTicks: number | null;
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
 * The exact metric keys a snapshot carries. Exported so the capabilities
 * endpoint cannot drift away from what the collector actually produces.
 * `identityStartTicks` is internal and deliberately excluded.
 */
export const SNAPSHOT_METRIC_KEYS = [
  "pid",
  "command",
  "ppid",
  "processGroupId",
  "sessionId",
  "state",
  "startTime",
  "elapsedMs",
  "cpuUserMs",
  "cpuSystemMs",
  "cpuPercent",
  "rssBytes",
  "virtualMemoryBytes",
  "threadCount",
  "voluntaryContextSwitches",
  "nonVoluntaryContextSwitches",
  "minorFaults",
  "majorFaults",
  "readBytes",
  "writeBytes",
  "readChars",
  "writeChars",
] as const;

/**
 * /proc/<pid>/io fields this gateway understands. Anything else in the
 * file is ignored rather than guessed.
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

export function readClockTicksPerSecond(): number | null {
  if (cachedClockTicks !== undefined) return cachedClockTicks;
  if (process.platform !== "linux") return null;
  for (const executable of ["/usr/bin/getconf", "/bin/getconf"]) {
    if (!existsSync(executable)) continue;
    const result = spawnSync(executable, ["CLK_TCK"], { encoding: "utf8", timeout: 250, shell: false });
    const hz = Number(result.stdout.trim());
    if (result.status === 0 && Number.isFinite(hz) && hz > 0) {
      cachedClockTicks = hz;
      return hz;
    }
  }
  cachedClockTicks = null;
  return cachedClockTicks;
}

export interface ProcReadOptions {
  procRoot?: string;
  nowMs?: number;
  clockTicksPerSecond?: number | null;
}

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
    // so an EACCES here is normal and must not be reported as a failure.
    try {
      io = parseProcIo(readFileSync(`${root}/io`, "utf8"));
      if (Object.keys(io).length === 0) {
        ioUnavailableReason = "/proc/<pid>/io contained no recognised counters";
      }
    } catch (err) {
      ioUnavailableReason = errorReason(err);
    }
  }

  const ticks = options.clockTicksPerSecond === undefined ? readClockTicksPerSecond() : options.clockTicksPerSecond;
  const uptimeSeconds = readUptime(procRoot);
  const source = `/proc/${pid}/stat`;
  const sourceStatus = `/proc/${pid}/status`;
  const sourceIo = `/proc/${pid}/io`;
  const metric = <T>(value: T, provenance: Provenance, fieldSource: string): Metric<T> => ({ value, provenance, source: fieldSource });
  const unavailable = <T>(fieldSource: string, reason = unavailableReason ?? "Field is absent from this kernel procfs response"): Metric<T> => ({
    value: null,
    provenance: "UNAVAILABLE",
    source: fieldSource,
    reason,
  });

  if (stat === null) {
    const missing = <T>() => unavailable<T>(source);
    return {
      timestamp,
      capsEnginePid: unavailable("gateway child_process.spawn", "CAPS process identity is not available"),
      pid: metric(pid, "OBSERVED", "CAPS PROCESS_STARTED"), command: missing(), ppid: missing(), processGroupId: missing(), sessionId: missing(), state: missing(),
      startTime: missing(), elapsedMs: missing(), cpuUserMs: missing(), cpuSystemMs: missing(), cpuPercent: unavailable("DERIVED"),
      rssBytes: unavailable(sourceStatus), virtualMemoryBytes: unavailable(sourceStatus), threadCount: unavailable(sourceStatus),
      voluntaryContextSwitches: unavailable(sourceStatus), nonVoluntaryContextSwitches: unavailable(sourceStatus),
      minorFaults: unavailable(source), majorFaults: unavailable(source),
      readBytes: unavailable(sourceIo), writeBytes: unavailable(sourceIo), readChars: unavailable(sourceIo), writeChars: unavailable(sourceIo),
      identityStartTicks: null,
    };
  }

  const elapsedMs = uptimeSeconds === null || ticks === null ? null : Math.max(0, (uptimeSeconds - stat.startTicks / ticks) * 1000);
  const startMs = elapsedMs === null ? null : nowMs - elapsedMs;
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

  return {
    timestamp,
    capsEnginePid: unavailable("gateway child_process.spawn", "CAPS process identity is not available"),
    pid: metric(stat.pid, "OBSERVED", source),
    command: metric(stat.command, "OBSERVED", source),
    ppid: statusPid === null || statusPpid === null ? metric(stat.ppid, "OBSERVED", source) : metric(statusPpid, "OBSERVED", sourceStatus),
    processGroupId: metric(stat.processGroupId, "OBSERVED", source),
    sessionId: metric(stat.sessionId, "OBSERVED", source),
    state: metric(stat.state, "OBSERVED", source),
    startTime: startMs === null ? unavailable("DERIVED", uptimeSeconds === null ? "Cannot read /proc/uptime" : "Kernel clock tick rate unavailable") : metric(new Date(startMs).toISOString(), "DERIVED", `${source} + ${procRoot}/uptime`),
    elapsedMs: elapsedMs === null ? unavailable("DERIVED", uptimeSeconds === null ? "Cannot read /proc/uptime" : "Kernel clock tick rate unavailable") : metric(elapsedMs, "DERIVED", `${source} + ${procRoot}/uptime`),
    cpuUserMs: ticks === null ? unavailable("DERIVED", "Kernel clock tick rate unavailable") : metric(stat.userTicks * 1000 / ticks, "DERIVED", `${source} field utime converted with _SC_CLK_TCK`),
    cpuSystemMs: ticks === null ? unavailable("DERIVED", "Kernel clock tick rate unavailable") : metric(stat.systemTicks * 1000 / ticks, "DERIVED", `${source} field stime converted with _SC_CLK_TCK`),
    cpuPercent: unavailable("DERIVED", "Requires at least two valid samples"),
    rssBytes: vmRss === null ? unavailable(sourceStatus) : metric(vmRss, "OBSERVED", sourceStatus),
    virtualMemoryBytes: vmSize === null ? unavailable(sourceStatus) : metric(vmSize, "OBSERVED", sourceStatus),
    threadCount: threads === null ? metric(stat.threadCount, "OBSERVED", source) : metric(threads, "OBSERVED", sourceStatus),
    voluntaryContextSwitches: voluntary === null ? unavailable(sourceStatus) : metric(voluntary, "OBSERVED", sourceStatus),
    nonVoluntaryContextSwitches: involuntary === null ? unavailable(sourceStatus) : metric(involuntary, "OBSERVED", sourceStatus),
    minorFaults: metric(stat.minorFaults, "OBSERVED", `${source} field minflt`),
    majorFaults: metric(stat.majorFaults, "OBSERVED", `${source} field majflt`),
    readBytes: ioOrUnavailable(io.readBytes),
    writeBytes: ioOrUnavailable(io.writeBytes),
    readChars: ioOrUnavailable(io.rchar),
    writeChars: ioOrUnavailable(io.wchar),
    identityStartTicks: stat.startTicks,
  };
}

function readUptime(procRoot: string): number | null {
  try {
    const value = Number(readFileSync(`${procRoot}/uptime`, "utf8").trim().split(/\s+/)[0]);
    return Number.isFinite(value) && value >= 0 ? value : null;
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
