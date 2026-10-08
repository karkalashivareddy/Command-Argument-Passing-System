import type {
  CanonicalEvent,
  ProcessSnapshot,
  ProcessVisualState,
  RawMetric,
  RuntimePeakPoint,
  RuntimePeaks,
  TelemetryMetric,
} from "../types/observability";
import { formatCount, formatKibPerSec, formatMiB, formatPercent } from "./format";

/**
 * Reads a persisted metric while honouring provenance: an UNAVAILABLE metric
 * has no value, no matter what the JSON happens to contain. This is the only
 * place the UI is allowed to turn a metric into a number.
 */
export function metricValue<T = number>(value: unknown): T | null {
  if (typeof value !== "object" || value === null || !("value" in value) || !("provenance" in value)) return null;
  const metric = value as { value?: unknown; provenance?: unknown };
  if (metric.provenance === "UNAVAILABLE") return null;
  return metric.value === null || metric.value === undefined ? null : (metric.value as T);
}

function numeric(value: unknown): number | null {
  const parsed = metricValue<number>(value);
  return parsed !== null && typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

export function asSnapshot(payload: unknown): ProcessSnapshot | null {
  if (typeof payload !== "object" || payload === null) return null;
  const snapshot = payload as unknown as ProcessSnapshot;
  return typeof snapshot.pid === "object" && snapshot.pid !== null ? snapshot : null;
}

export interface TelemetrySample {
  event: CanonicalEvent;
  snapshot: ProcessSnapshot;
  index: number;
  /** Milliseconds since the first event of the session. */
  atMs: number;
  epochMs: number;
  atSec: number;
}

/** Persisted process.snapshot events, in order, with a shared time origin. */
export function collectSamples(events: CanonicalEvent[]): TelemetrySample[] {
  const base = events.length > 0 ? new Date(events[0]!.timestamp).getTime() : 0;
  const samples: TelemetrySample[] = [];
  for (const event of events) {
    if (event.type !== "process.snapshot") continue;
    const snapshot = asSnapshot(event.payload);
    if (snapshot === null) continue;
    const epochMs = new Date(event.timestamp).getTime();
    const atMs = Math.max(0, epochMs - base);
    samples.push({ event, snapshot, index: samples.length, atMs, epochMs, atSec: atMs / 1000 });
  }
  return samples;
}

/** The sample closest to an execution-time cursor. Ties resolve to the later sample. */
export function sampleAt(samples: TelemetrySample[], atMs: number | null | undefined): TelemetrySample | null {
  if (samples.length === 0) return null;
  if (atMs === null || atMs === undefined) return samples[samples.length - 1]!;
  let best = samples[0]!;
  for (const sample of samples) {
    if (Math.abs(sample.atMs - atMs) < Math.abs(best.atMs - atMs)) best = sample;
  }
  return best;
}

export interface TrackRow {
  t: number;
  cpuPercent: number | null;
  rssMiB: number | null;
  rcharKiBps: number | null;
  wcharKiBps: number | null;
  readBlockKiBps: number | null;
  writeBlockKiBps: number | null;
  minorFaultsPerSec: number | null;
  majorFaultsPerSec: number | null;
}

export type TrackKey = Exclude<keyof TrackRow, "t">;

export interface TrackSeriesSpec {
  key: TrackKey;
  label: string;
  color: string;
  provenance: "OBSERVED" | "DERIVED";
  /** What one unit of the plotted number actually is, for tooltips and legends. */
  meaning: string;
}

export interface ResourceTrackSpec {
  id: "cpu" | "memory" | "ioChars" | "ioBlocks" | "faults";
  label: string;
  unit: string;
  /** Honest statement of what this track does and does not measure. */
  caption: string;
  color: string;
  /** Lower bound for the Y domain even when every sample is near zero. */
  floor: number;
  series: TrackSeriesSpec[];
}

/** One row per sample time, so every track shares the same X axis and cursor. */
export function buildRow(sample: TelemetrySample): TrackRow {
  const { snapshot } = sample;
  const bytes = numeric(snapshot.rssBytes);
  return {
    t: sample.atSec,
    cpuPercent: numeric(snapshot.cpuPercent),
    rssMiB: bytes === null ? null : bytes / (1024 * 1024),
    rcharKiBps: perSec(snapshot.rcharBytesPerSec),
    wcharKiBps: perSec(snapshot.wcharBytesPerSec),
    readBlockKiBps: perSec(snapshot.readBytesPerSec),
    writeBlockKiBps: perSec(snapshot.writeBytesPerSec),
    minorFaultsPerSec: numeric(snapshot.minorFaultsPerSec),
    majorFaultsPerSec: numeric(snapshot.majorFaultsPerSec),
  };
}

function perSec(value: unknown): number | null {
  const parsed = numeric(value);
  return parsed === null ? null : parsed / 1024;
}

export const RESOURCE_TRACKS: ResourceTrackSpec[] = [
  {
    id: "cpu",
    label: "CPU",
    unit: "% of one core",
    caption: "Process CPU time delta divided by wall time. 100% is one saturated core; above 100% means multiple threads ran in parallel.",
    color: "var(--green)",
    floor: 100,
    series: [{ key: "cpuPercent", label: "CPU util", color: "var(--green)", provenance: "DERIVED", meaning: "process CPU, never system-wide CPU" }],
  },
  {
    id: "memory",
    label: "Resident memory",
    unit: "MiB",
    caption: "VmRSS from /proc/<pid>/status: pages the process actually holds in RAM. Virtual size is reported separately in the inspector.",
    color: "var(--cyan)",
    floor: 1,
    series: [{ key: "rssMiB", label: "RSS", color: "var(--cyan)", provenance: "OBSERVED", meaning: "resident set size" }],
  },
  {
    id: "ioChars",
    label: "Syscall I/O",
    unit: "KiB/s",
    caption: "rchar/wchar from /proc/<pid>/io: characters passed to read()/write(), including page-cache hits. This is not disk throughput.",
    color: "var(--blue)",
    floor: 8,
    series: [
      { key: "rcharKiBps", label: "read chars", color: "var(--blue)", provenance: "DERIVED", meaning: "characters read via read(), including cache" },
      { key: "wcharKiBps", label: "write chars", color: "var(--violet)", provenance: "DERIVED", meaning: "characters written via write(), including cache" },
    ],
  },
  {
    id: "ioBlocks",
    label: "Block-device I/O",
    unit: "KiB/s",
    caption: "read_bytes/write_bytes from /proc/<pid>/io: bytes actually sent to the block layer. Stays at zero for cached I/O.",
    color: "var(--amber)",
    floor: 8,
    series: [
      { key: "readBlockKiBps", label: "block read", color: "var(--amber)", provenance: "DERIVED", meaning: "bytes sent to the block device" },
      { key: "writeBlockKiBps", label: "block write", color: "var(--fg-2)", provenance: "DERIVED", meaning: "bytes sent to the block device" },
    ],
  },
  {
    id: "faults",
    label: "Page faults",
    unit: "faults/s",
    caption: "Minor faults are page faults served without disk I/O; major faults required real I/O. Both are cumulative counters differenced over the sample interval.",
    color: "var(--accent)",
    floor: 10,
    series: [
      { key: "minorFaultsPerSec", label: "minor", color: "var(--accent)", provenance: "DERIVED", meaning: "non-blocking page faults" },
      { key: "majorFaultsPerSec", label: "major", color: "var(--red)", provenance: "DERIVED", meaning: "page faults that required I/O" },
    ],
  },
];

export interface SeriesPeak {
  key: TrackKey;
  label: string;
  color: string;
  value: number;
  atMs: number;
  atSec: number;
  unit: string;
}

export interface ResourceTrackView {
  spec: ResourceTrackSpec;
  series: TrackSeriesSpec[];
  domain: [number, number];
  observedCount: number;
  peak: SeriesPeak | null;
}

export interface ResourceTracks {
  rows: TrackRow[];
  tracks: ResourceTrackView[];
  spanSeconds: number;
  rawSampleCount: number;
  displayedSampleCount: number;
  thinned: boolean;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  /** True when no rate could be derived: the first sample of a session. */
  ratesUnavailable: boolean;
}

/**
 * Presentation-only thinning for very long sessions: keeps evenly spaced
 * samples plus the first, the last, and every per-series peak. The persisted
 * event stream is never modified and no value is interpolated.
 */
export function thinIndices(count: number, maxPoints: number, mustKeep: number[] = []): number[] {
  if (count <= maxPoints) return Array.from({ length: count }, (_, i) => i);
  const keep = new Set<number>([0, count - 1]);
  for (const index of mustKeep) if (index >= 0 && index < count) keep.add(index);
  const stride = count / maxPoints;
  for (let i = 0; i < maxPoints; i++) keep.add(Math.min(count - 1, Math.floor(i * stride)));
  return [...keep].sort((a, b) => a - b);
}

function trackDomain(rows: TrackRow[], spec: ResourceTrackSpec): { domain: [number, number]; observedCount: number; peak: SeriesPeak | null } {
  let observedCount = 0;
  let max = 0;
  const perSeries = new Map<TrackKey, { value: number; atMs: number; atSec: number }>();
  for (const row of rows) {
    for (const series of spec.series) {
      const value = row[series.key];
      if (value === null) continue;
      observedCount++;
      if (value > max) max = value;
      const current = perSeries.get(series.key);
      if (current === undefined || value > current.value) perSeries.set(series.key, { value, atMs: row.t * 1000, atSec: row.t });
    }
  }
  const domain: [number, number] = [0, Math.max(spec.floor, max > 0 ? max * 1.08 : 0)];
  const peaks = spec.series
    .map((series) => {
      const found = perSeries.get(series.key);
      return found ? { key: series.key, label: series.label, color: series.color, value: found.value, atMs: found.atMs, atSec: found.atSec, unit: spec.unit } satisfies SeriesPeak : null;
    })
    .filter((peak): peak is SeriesPeak => peak !== null);
  const peak = peaks.length === 0 ? null : peaks.reduce((best, current) => (current.value > best.value ? current : best));
  return { domain, observedCount, peak };
}

export function buildResourceTracks(samples: TelemetrySample[], options: { maxPoints?: number } = {}): ResourceTracks {
  const maxPoints = options.maxPoints ?? 400;
  const allRows = samples.map(buildRow);
  const full = buildResourceTrackViews(allRows);

  const peakIndices = new Set<number>();
  allRows.forEach((row, index) => {
    for (const view of full.tracks) {
      for (const series of view.series) {
        const value = row[series.key];
        if (value === null) continue;
        const peak = view.peak;
        if (peak !== null && peak.key === series.key && peak.atSec === row.t && peak.value === value) peakIndices.add(index);
      }
    }
  });

  const keep = thinIndices(allRows.length, maxPoints, [...peakIndices]);
  const thinned = keep.length < allRows.length;
  const rows = thinned ? keep.map((index) => allRows[index]!) : allRows;
  const views = thinned
    ? buildResourceTrackViews(rows)
    : full;

  const last = samples.at(-1);
  return {
    rows,
    tracks: views.tracks,
    spanSeconds: last ? Math.max(0.5, last.atSec) : 0,
    rawSampleCount: samples.length,
    displayedSampleCount: rows.length,
    thinned,
    firstSampleAt: samples[0]?.event.timestamp ?? null,
    lastSampleAt: last?.event.timestamp ?? null,
    ratesUnavailable: samples.length === 1,
  };
}

function buildResourceTrackViews(rows: TrackRow[]): { tracks: ResourceTrackView[] } {
  const tracks = RESOURCE_TRACKS.map((spec) => {
    const { domain, observedCount, peak } = trackDomain(rows, spec);
    return { spec, series: spec.series, domain, observedCount, peak };
  });
  return { tracks };
}

export interface InspectorItem {
  label: string;
  metric: TelemetryMetric<number | string>;
  display: string;
  note?: string;
}

export interface InspectorSection {
  id: string;
  title: string;
  items: InspectorItem[];
}

export interface Inspector {
  sample: TelemetrySample | null;
  atMs: number;
  sections: InspectorSection[];
  unavailable: Array<{ metric: string; reason: string }>;
}

function item<T extends string | number>(label: string, metric: TelemetryMetric<T> | undefined, display: (value: T) => string): InspectorItem {
  if (metric === undefined) {
    return { label, metric: { value: null, provenance: "UNAVAILABLE", source: "not collected", reason: "Metric is absent from the persisted snapshot" }, display: "UNAVAILABLE" };
  }
  return { label, metric, display: metric.value === null ? "UNAVAILABLE" : display(metric.value) };
}

const NOT_COLLECTED: Record<string, string> = {
  systemCpuPercent: "System-wide CPU is not sampled; only this process's own CPU time is read",
  networkBytes: "Network I/O needs socket instrumentation; procfs does not expose it",
  openFileDescriptors: "File-descriptor counts are not collected",
  diskLatency: "Request latency needs block-layer tracing, not available through procfs",
};

/** The inspector is a cursor-driven view of one real sample, never a blend of many. */
export function buildInspector(samples: TelemetrySample[], atMs: number | null | undefined): Inspector {
  const sample = sampleAt(samples, atMs);
  if (sample === null) {
    return { sample: null, atMs: 0, sections: [], unavailable: [] };
  }
  const s = sample.snapshot;
  const sections: InspectorSection[] = [
    {
      id: "identity",
      title: "Identity",
      items: [
        item("Linux PID", s.pid as TelemetryMetric<number>, formatCount),
        item("CAPS engine PID", s.capsEnginePid as TelemetryMetric<number>, formatCount),
        item("Parent PID", s.ppid as TelemetryMetric<number>, formatCount),
        item("Process group", s.processGroupId as TelemetryMetric<number>, formatCount),
        item("Linux session", s.sessionId as TelemetryMetric<number>, formatCount),
        item("State", s.state as TelemetryMetric<string>, (v) => String(v)),
        item("Command", s.command as TelemetryMetric<string>, (v) => String(v)),
        item("Start time", s.startTime as TelemetryMetric<string>, (v) => String(v)),
        item("Elapsed", s.elapsedMs as TelemetryMetric<number>, (v) => `${v.toFixed(0)} ms`),
      ],
    },
    {
      id: "cpu",
      title: "CPU",
      items: [
        item("CPU util", s.cpuPercent as TelemetryMetric<number>, (v) => formatPercent(Number(v))),
        item("Total CPU time", s.cpuTimeMs as TelemetryMetric<number>, (v) => `${(Number(v) / 1000).toFixed(2)} s`),
        item("User CPU time", s.cpuUserMs as TelemetryMetric<number>, (v) => `${(Number(v) / 1000).toFixed(2)} s`),
        item("System CPU time", s.cpuSystemMs as TelemetryMetric<number>, (v) => `${(Number(v) / 1000).toFixed(2)} s`),
        item("Threads", s.threadCount as TelemetryMetric<number>, formatCount),
        item("Voluntary ctx switches", s.voluntaryContextSwitches as TelemetryMetric<number>, formatCount),
        item("Nonvoluntary ctx switches", s.nonVoluntaryContextSwitches as TelemetryMetric<number>, formatCount),
      ],
    },
    {
      id: "memory",
      title: "Memory",
      items: [
        item("RSS", s.rssBytes as TelemetryMetric<number>, formatMiB),
        item("Virtual size", s.virtualMemoryBytes as TelemetryMetric<number>, formatMiB),
      ],
    },
    {
      id: "io",
      title: "I/O",
      items: [
        item("Read chars (total)", s.rcharBytes as TelemetryMetric<number>, formatMiB),
        item("Write chars (total)", s.wcharBytes as TelemetryMetric<number>, formatMiB),
        item("Read rate", s.rcharBytesPerSec as TelemetryMetric<number>, formatKibPerSec),
        item("Write rate", s.wcharBytesPerSec as TelemetryMetric<number>, formatKibPerSec),
        item("Block read (total)", s.readBytes as TelemetryMetric<number>, formatMiB),
        item("Block write (total)", s.writeBytes as TelemetryMetric<number>, formatMiB),
        item("Block read rate", s.readBytesPerSec as TelemetryMetric<number>, formatKibPerSec),
        item("Block write rate", s.writeBytesPerSec as TelemetryMetric<number>, formatKibPerSec),
      ],
    },
    {
      id: "faults",
      title: "Page faults",
      items: [
        item("Minor (total)", s.minorFaults as TelemetryMetric<number>, formatCount),
        item("Major (total)", s.majorFaults as TelemetryMetric<number>, formatCount),
        item("Minor rate", s.minorFaultsPerSec as TelemetryMetric<number>, (v) => `${formatCount(Number(v))}/s`),
        item("Major rate", s.majorFaultsPerSec as TelemetryMetric<number>, (v) => `${formatCount(Number(v))}/s`),
      ],
    },
  ];

  const unavailable: Array<{ metric: string; reason: string }> = [];
  for (const section of sections) {
    for (const entry of section.items) {
      if (entry.metric.provenance === "UNAVAILABLE") unavailable.push({ metric: entry.label, reason: entry.metric.reason ?? "unavailable for this sample" });
    }
  }
  for (const [metric, reason] of Object.entries(NOT_COLLECTED)) unavailable.push({ metric, reason });

  return { sample, atMs: sample.atMs, sections, unavailable };
}

export interface VisualStatePeaks {
  cpuPercent: number | null;
  rssBytes: number | null;
  bytesPerSec: number | null;
  faultsPerSec: number | null;
}

export function visualStatePeaks(samples: TelemetrySample[]): VisualStatePeaks {
  const max = (pick: (s: ProcessSnapshot) => number | null): number | null => {
    let best: number | null = null;
    for (const { snapshot } of samples) {
      const value = pick(snapshot);
      if (value !== null && (best === null || value > best)) best = value;
    }
    return best;
  };
  return {
    cpuPercent: max((s) => numeric(s.cpuPercent)),
    rssBytes: max((s) => numeric(s.rssBytes)),
    bytesPerSec: max((s) => {
      const read = numeric(s.rcharBytesPerSec);
      const write = numeric(s.wcharBytesPerSec);
      const blockRead = numeric(s.readBytesPerSec);
      const blockWrite = numeric(s.writeBytesPerSec);
      const values = [read, write, blockRead, blockWrite].filter((v): v is number => v !== null);
      return values.length > 0 ? Math.max(...values) : null;
    }),
    faultsPerSec: max((s) => {
      const minor = numeric(s.minorFaultsPerSec);
      const major = numeric(s.majorFaultsPerSec);
      return minor === null && major === null ? null : Math.max(minor ?? 0, major ?? 0);
    }),
  };
}

function ratio(value: number | null, peak: number | null): number | null {
  if (value === null || peak === null || peak <= 0) return null;
  return Math.min(1, Math.max(0, value / peak));
}

/**
 * Normalize one recorded metric into a value that still knows what it is.
 *
 * This is the single place a `TelemetryMetric` becomes a `RawMetric`, and it is
 * where provenance used to be thrown away. `numeric()` returns a bare number, so
 * every consumer downstream had no way to distinguish an OBSERVED reading from
 * a DERIVED rate; the HUD, the node table and the tooltip all rendered nine
 * derived rates in the same style as one observed gauge.
 *
 * Two notes on faithfulness:
 *
 *  - An UNAVAILABLE metric keeps `value: null` and its reason. It is never
 *    coerced to 0, because 0 is a legitimate reading of several of these (a
 *    process that never faulted really did record 0 minor faults) and conflating
 *    the two would make the honest reading indistinguishable from the absent one.
 *
 *  - `unitNote` is attached where the name understates what is counted.
 *    `rchar`/`wchar` in /proc/<pid>/io are CHARACTER counters that include page
 *    cache and are NOT storage traffic; `read_bytes`/`write_bytes` are storage
 *    counters. A lens that takes the max of both and labels the result "bytes
 *    per second" is averaging two different physical quantities, so both carry
 *    the note and the lens states which one it picked.
 */
function rawMetric(metric: unknown, unitNote?: string): RawMetric {
  const found = metric as (TelemetryMetric<number> & { source?: string; formula?: string; confidence?: string }) | undefined;
  if (found === undefined || found === null) {
    return { value: null, provenance: "UNAVAILABLE", reason: "metric absent from this snapshot" };
  }
  const extras = {
    ...(found.source === undefined ? {} : { source: found.source }),
    ...(found.formula === undefined ? {} : { formula: found.formula }),
    ...(found.confidence === undefined ? {} : { confidence: found.confidence }),
    ...(unitNote === undefined ? {} : { unitNote }),
  };
  if (found.provenance === "UNAVAILABLE" || found.value === null) {
    return {
      value: null,
      provenance: "UNAVAILABLE",
      reason: found.reason ?? "unavailable for this sample",
      ...extras,
    };
  }
  return { value: found.value, provenance: found.provenance ?? "OBSERVED", ...extras };
}

/** The character-counter note, shared by the two rchar/wchar series. */
const CHARS_NOT_BYTES =
  "counts characters from /proc/<pid>/io, including page cache. Not storage traffic";
/** The storage-counter note. */
const STORAGE_BYTES = "counts bytes actually transferred to or from the storage device";

/**
 * One frozen, serializable description of a process at one instant.
 *
 * This is the contract the 3D scene, the process list, the HUD and the tooltip
 * all read, so no consumer re-parses telemetry or invents its own
 * normalization.
 */
export function buildVisualState(sample: TelemetrySample, peaks: VisualStatePeaks): ProcessVisualState {
  const { snapshot, event } = sample;

  /*
   * Every metric that can be UNAVAILABLE is listed, not just four.
   *
   * This loop used to inspect cpuPercent, rssBytes, minorFaults and threadCount
   * only. The io rates, the fault rates, majorFaults and cpuTimeMs were omitted,
   * so the panel whose entire job is to explain missing telemetry under-reported
   * it -- it would claim a process was fully measured while seven of its metrics
   * were absent. Omission here is a false negative about the product's own
   * completeness, which is the same class of error as rendering 0 for absent.
   */
  const unavailable: Array<{ metric: string; reason: string }> = [];
  const REPORTED = [
    ["cpuPercent", snapshot.cpuPercent],
    ["rssBytes", snapshot.rssBytes],
    ["minorFaults", snapshot.minorFaults],
    ["majorFaults", snapshot.majorFaults],
    ["threadCount", snapshot.threadCount],
    ["cpuTimeMs", snapshot.cpuTimeMs],
    ["rcharBytesPerSec", snapshot.rcharBytesPerSec],
    ["wcharBytesPerSec", snapshot.wcharBytesPerSec],
    ["readBytesPerSec", snapshot.readBytesPerSec],
    ["writeBytesPerSec", snapshot.writeBytesPerSec],
    ["minorFaultsPerSec", snapshot.minorFaultsPerSec],
    ["majorFaultsPerSec", snapshot.majorFaultsPerSec],
  ] as const;
  for (const [metric, value] of REPORTED) {
    const found = value as TelemetryMetric<number> | undefined;
    if (found === undefined || found === null) {
      unavailable.push({ metric, reason: "metric absent from this snapshot" });
    } else if (found.provenance === "UNAVAILABLE" || found.value === null) {
      unavailable.push({ metric, reason: found.reason ?? "unavailable for this sample" });
    }
  }

  const rchar = numeric(snapshot.rcharBytesPerSec);
  const wchar = numeric(snapshot.wcharBytesPerSec);
  const readBlock = numeric(snapshot.readBytesPerSec);
  const writeBlock = numeric(snapshot.writeBytesPerSec);
  const minorRate = numeric(snapshot.minorFaultsPerSec);
  const majorRate = numeric(snapshot.majorFaultsPerSec);
  const ioTotal = [rchar, wchar, readBlock, writeBlock].reduce<number | null>((acc, value) => (value === null ? acc : Math.max(acc ?? 0, value)), null);

  return {
    sessionId: event.sessionId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    atMs: sample.atMs,
    pid: numeric(snapshot.pid),
    capsEnginePid: numeric(snapshot.capsEnginePid),
    command: (snapshot.command?.value as string | null | undefined) ?? null,
    state: (snapshot.state?.value as string | null | undefined) ?? null,
    cpu: ratio(numeric(snapshot.cpuPercent), peaks.cpuPercent),
    memory: ratio(numeric(snapshot.rssBytes), peaks.rssBytes),
    io: ratio(ioTotal, peaks.bytesPerSec),
    faults: ratio(Math.max(minorRate ?? 0, majorRate ?? 0), minorRate === null && majorRate === null ? null : peaks.faultsPerSec),
    raw: {
      cpuPercent: rawMetric(snapshot.cpuPercent),
      rssBytes: rawMetric(snapshot.rssBytes),
      rcharBytesPerSec: rawMetric(snapshot.rcharBytesPerSec, CHARS_NOT_BYTES),
      wcharBytesPerSec: rawMetric(snapshot.wcharBytesPerSec, CHARS_NOT_BYTES),
      readBytesPerSec: rawMetric(snapshot.readBytesPerSec, STORAGE_BYTES),
      writeBytesPerSec: rawMetric(snapshot.writeBytesPerSec, STORAGE_BYTES),
      minorFaults: rawMetric(snapshot.minorFaults),
      majorFaults: rawMetric(snapshot.majorFaults),
      minorFaultsPerSec: rawMetric(snapshot.minorFaultsPerSec),
      majorFaultsPerSec: rawMetric(snapshot.majorFaultsPerSec),
      threadCount: rawMetric(snapshot.threadCount),
    },
    unavailable,
  };
}

export function buildVisualStates(samples: TelemetrySample[]): ProcessVisualState[] {
  const peaks = visualStatePeaks(samples);
  return samples.map((sample) => buildVisualState(sample, peaks));
}

/**
 * The most recent sample's visual state, or null when no sample was recorded.
 *
 * "Most recent" is the last element because `collectSamples` returns them in
 * sequence order, which is the order the gateway persisted them.
 *
 * This exists so that "show me the current telemetry" has exactly one
 * implementation. The live execution panel, the 3D node HUD and the process
 * inspector all want the same answer, and three independent
 * `samples.at(-1)`-plus-rebuild computations would drift -- and a drift there is
 * invisible until two panels on the same screen disagree about the same process,
 * which is the failure this project cares most about.
 */
export function latestVisualState(samples: TelemetrySample[]): ProcessVisualState | null {
  const last = samples.at(-1);
  if (last === undefined) return null;
  return buildVisualState(last, visualStatePeaks(samples));
}

function trackPeak<K extends keyof RuntimePeaks>(out: RuntimePeaks, key: K, value: unknown, atMs: number, timestamp: string): void {
  const parsed = numeric(value);
  if (parsed === null) return;
  const current = out[key] as RuntimePeakPoint | null;
  if (current === null || parsed > current.value) {
    (out as unknown as Record<string, unknown>)[key as string] = { value: parsed, atTimeMs: atMs, atTimestamp: timestamp };
  }
}

/**
 * Per-execution peaks and totals derived strictly from the events the UI
 * already holds. Mirrors the gateway's computeRuntimePeaks so a value shown
 * here matches what an export contains.
 */
export function deriveRuntimePeaks(events: CanonicalEvent[]): RuntimePeaks {
  const out: RuntimePeaks = {
    sampleCount: 0,
    firstSampleAt: null,
    lastSampleAt: null,
    minElapsedMs: null,
    maxElapsedMs: null,
    peakRssBytes: null,
    medianRssBytes: null,
    peakCpuPercent: null,
    cpuTimeMs: null,
    peakMinorFaults: null,
    peakMajorFaults: null,
    peakMinorFaultsPerSec: null,
    peakMajorFaultsPerSec: null,
    totalRcharBytes: null,
    totalWcharBytes: null,
    totalReadBytes: null,
    totalWriteBytes: null,
    peakRcharBytesPerSec: null,
    peakWcharBytesPerSec: null,
  };
  const base = events.length > 0 ? new Date(events[0]!.timestamp).getTime() : 0;
  const rssValues: number[] = [];
  let lastUser: number | null = null;
  let lastSystem: number | null = null;
  let lastCpuTime: number | null = null;

  for (const ev of events) {
    if (ev.type !== "process.snapshot") continue;
    const payload = ev.payload as Record<string, unknown>;
    const ts = ev.timestamp;
    out.sampleCount++;
    const atMs = Math.max(0, new Date(ts).getTime() - base);
    if (out.firstSampleAt === null) out.firstSampleAt = ts;
    out.lastSampleAt = ts;

    const rss = numeric(payload.rssBytes);
    if (rss !== null) {
      rssValues.push(rss);
      if (out.peakRssBytes === null || rss > out.peakRssBytes.value) out.peakRssBytes = { value: rss, atTimeMs: atMs, atTimestamp: ts };
    }

    trackPeak(out, "peakCpuPercent", payload.cpuPercent, atMs, ts);

    const elapsed = numeric(payload.elapsedMs);
    if (elapsed !== null) {
      out.minElapsedMs = out.minElapsedMs === null ? elapsed : Math.min(out.minElapsedMs, elapsed);
      out.maxElapsedMs = out.maxElapsedMs === null ? elapsed : Math.max(out.maxElapsedMs, elapsed);
    }

    const user = numeric(payload.cpuUserMs);
    const system = numeric(payload.cpuSystemMs);
    if (user !== null && system !== null) {
      lastUser = user;
      lastSystem = system;
    }
    const cpuTime = numeric(payload.cpuTimeMs);
    if (cpuTime !== null) lastCpuTime = cpuTime;

    trackPeak(out, "peakMinorFaults", payload.minorFaults, atMs, ts);
    trackPeak(out, "peakMajorFaults", payload.majorFaults, atMs, ts);
    trackPeak(out, "peakMinorFaultsPerSec", payload.minorFaultsPerSec, atMs, ts);
    trackPeak(out, "peakMajorFaultsPerSec", payload.majorFaultsPerSec, atMs, ts);
    trackPeak(out, "peakRcharBytesPerSec", payload.rcharBytesPerSec, atMs, ts);
    trackPeak(out, "peakWcharBytesPerSec", payload.wcharBytesPerSec, atMs, ts);

    // Cumulative counters: the last valid observation is the session total.
    out.totalRcharBytes = latestValue(out.totalRcharBytes, payload.rcharBytes);
    out.totalWcharBytes = latestValue(out.totalWcharBytes, payload.wcharBytes);
    out.totalReadBytes = latestValue(out.totalReadBytes, payload.readBytes);
    out.totalWriteBytes = latestValue(out.totalWriteBytes, payload.writeBytes);
  }

  if (rssValues.length >= 2) {
    const sorted = [...rssValues].sort((a, b) => a - b);
    out.medianRssBytes = sorted[Math.floor(sorted.length / 2)] ?? null;
  }
  if (lastCpuTime !== null) out.cpuTimeMs = lastCpuTime;
  else if (lastUser !== null && lastSystem !== null) out.cpuTimeMs = lastUser + lastSystem;

  return out;
}

function latestValue(current: number | null, metric: unknown): number | null {
  const parsed = numeric(metric);
  return parsed === null ? current : parsed;
}

export interface TimelineAnnotation {
  t: number;
  type: string;
  label: string;
  tone: "start" | "end" | "signal" | "event";
}

/** Annotations worth drawing on the resource timeline (lifecycle, not sampling). */
const ANNOTATION_TYPES = new Set(["process.started", "process.exited", "process.exec_error", "redirection.opened", "redirection.failed", "signal.received", "execution.timeout", "execution.failed"]);

export function buildAnnotations(events: CanonicalEvent[]): TimelineAnnotation[] {
  const base = events.length > 0 ? new Date(events[0]!.timestamp).getTime() : 0;
  const annotations: TimelineAnnotation[] = [];
  for (const ev of events) {
    if (!ANNOTATION_TYPES.has(ev.type)) continue;
    const t = Math.max(0, (new Date(ev.timestamp).getTime() - base) / 1000);
    annotations.push({
      t,
      type: ev.type,
      label: ev.type,
      tone: ev.type === "process.exec_error" || ev.type === "execution.failed" || ev.type === "signal.received" ? "signal"
        : ev.type === "process.started" || ev.type === "redirection.opened" ? "start"
        : ev.type === "process.exited" ? "end"
        : "event",
    });
  }
  return annotations;
}

export interface SequenceIntegrity {
  contiguous: boolean;
  gaps: number;
  missingSequences: number;
}

export function sequenceIntegrity(events: CanonicalEvent[]): SequenceIntegrity {
  let gaps = 0;
  let missing = 0;
  for (let i = 1; i < events.length; i++) {
    const diff = events[i]!.sequence - events[i - 1]!.sequence;
    if (diff > 1) {
      gaps++;
      missing += diff - 1;
    }
  }
  return { contiguous: missing === 0, gaps, missingSequences: missing };
}
