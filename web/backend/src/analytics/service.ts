import type { EventRepository } from "../db/repositories/events.js";
import type { SessionRepository } from "../db/repositories/sessions.js";
import type {
  AnalyticsOverview,
  CanonicalEvent,
  CommandProfile,
  ComparisonSide,
  RuntimePeaks,
  SessionComparison,
  SessionRecord,
} from "../types/observability.js";

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * Analytics computed exclusively from persisted, terminal sessions.
 * No fabricated values: insufficient data yields null and the UI renders
 * "No executions recorded yet." / "Insufficient data".
 */
export function computeAnalytics(repo: SessionRepository, eventRepo: EventRepository): AnalyticsOverview {
  const rows = repo.listForAnalytics().filter((r) => r.status === "COMPLETED" || r.status === "FAILED" || r.status === "TIMED_OUT" || r.status === "CANCELLED");
  const result: AnalyticsOverview = {
    totalExecutions: rows.length,
    successful: 0,
    failed: 0,
    signalled: 0,
    running: 0,
    avgDurationMs: null,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
    byExitCode: {},
    bySignal: {},
    byCommand: {},
    redirectionUsage: {},
    byDay: [],
    processTelemetry: {
      sampleCount: 0,
      executionsSampled: 0,
      averageRssBytes: null,
      maxRssBytes: null,
      rssSamples: 0,
      averageCpuTimeMs: null,
      cpuTimeExecutions: 0,
      averageCpuPercent: null,
      cpuPercentSamples: 0,
      averageMinorFaults: null,
      averageMajorFaults: null,
      minorFaultSamples: 0,
      majorFaultSamples: 0,
      maxMajorFaults: null,
      averageRcharBytesPerSec: null,
      averageWcharBytesPerSec: null,
      maxRcharBytesPerSec: null,
      maxWcharBytesPerSec: null,
      ioRateSamples: 0,
    },
  };

  const durations: number[] = [];
  const dayMap = new Map<string, { count: number; success: number }>();
  const counts = new Map<string, number>();

  // Redirection usage comes from the redirections table (actual fs ops),
  // not the mirrored JSON on the session row.
  for (const { slot, target } of repo.listRedirections()) {
    if (target && typeof target === "string" && target.length) {
      result.redirectionUsage[slot] = (result.redirectionUsage[slot] ?? 0) + 1;
    }
  }

  for (const row of rows) {
    const ok = row.is_success === 1;
    if (ok) result.successful++;
    if (row.is_success === 0) result.failed++;
    if (row.signal !== null && row.signal > 0) result.signalled++;
    if (row.exit_code !== null) result.byExitCode[String(row.exit_code)] = (result.byExitCode[String(row.exit_code)] ?? 0) + 1;
    if (row.signal !== null && row.signal > 0) result.bySignal[String(row.signal)] = (result.bySignal[String(row.signal)] ?? 0) + 1;
    if (typeof row.duration_ms === "number" && row.duration_ms >= 0) durations.push(row.duration_ms);

    counts.set(row.command, (counts.get(row.command) ?? 0) + 1);

    const day = row.created_at.slice(0, 10);
    const d = dayMap.get(day) ?? { count: 0, success: 0 };
    d.count++;
    if (ok) d.success++;
    dayMap.set(day, d);
  }

  if (durations.length > 0) {
    const sorted = [...durations].sort((a, b) => a - b);
    result.avgDurationMs = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length * 10) / 10;
    result.p50Ms = percentile(sorted, 50);
    result.p95Ms = percentile(sorted, 95);
    result.p99Ms = percentile(sorted, 99);
  }

  result.byCommand = Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1]),
  );

  result.byDay = [...dayMap.entries()]
    .map(([date, v]) => ({ date, count: v.count, success: v.success }))
    .sort((a, b) => a.date.localeCompare(b.date));

  /*
   * Process telemetry is aggregated in SQL rather than by loading and parsing
   * every snapshot in the database on every request.  The numbers come from
   * the same persisted rows, so each one is still traceable to the
   * observations it summarises; only the JavaScript object churn is gone.
   * See EventRepository.aggregateProcessTelemetry() for the exact semantics.
   */
  const agg = eventRepo.aggregateProcessTelemetry();
  result.processTelemetry.sampleCount = agg.sampleCount;
  result.processTelemetry.executionsSampled = agg.executionsSampled;
  result.processTelemetry.rssSamples = agg.rssSamples;
  result.processTelemetry.averageRssBytes = agg.averageRssBytes;
  result.processTelemetry.maxRssBytes = agg.maxRssBytes;
  result.processTelemetry.cpuPercentSamples = agg.cpuPercentSamples;
  result.processTelemetry.averageCpuPercent = agg.averageCpuPercent;
  result.processTelemetry.cpuTimeExecutions = agg.cpuTimeExecutions;
  result.processTelemetry.averageCpuTimeMs = agg.averageCpuTimeMs;
  result.processTelemetry.averageMinorFaults = agg.averageMinorFaults;
  /*
   * The minor-fault sample count belongs here for the same reason the major one
   * does: an average without its denominator is not a measurement, it is a
   * number. The repository has always computed it -- `minorFaultSamples` comes
   * out of the same SQL aggregation as `majorFaultSamples` -- but this assignment
   * was missing, so the field stayed at its initial 0 while the average was
   * filled in.
   *
   * That combination is the worst of both: a real average presented with a
   * fabricated denominator of zero samples, which reads as "no samples" rather
   * than "the count was never copied across". The frontend renders this pair
   * together as "minor from N sample(s), major from M", so it was displaying
   * "minor from 0 sample(s)" beside a non-zero average.
   */
  result.processTelemetry.minorFaultSamples = agg.minorFaultSamples;
  result.processTelemetry.majorFaultSamples = agg.majorFaultSamples;
  result.processTelemetry.averageMajorFaults = agg.averageMajorFaults;
  result.processTelemetry.maxMajorFaults = agg.maxMajorFaults;
  result.processTelemetry.averageRcharBytesPerSec = agg.averageRcharBytesPerSec;
  result.processTelemetry.averageWcharBytesPerSec = agg.averageWcharBytesPerSec;
  result.processTelemetry.maxRcharBytesPerSec = agg.maxRcharBytesPerSec;
  result.processTelemetry.maxWcharBytesPerSec = agg.maxWcharBytesPerSec;
  // A rate needs both directions to be meaningful, so the pair count is the
  // smaller of the two, as before.
  result.processTelemetry.ioRateSamples = Math.min(agg.rcharRateSamples, agg.wcharRateSamples);
  return result;
}

function metricValue(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("value" in value) || !("provenance" in value)) return null;
  const metric = value as { value?: unknown; provenance?: unknown };
  return metric.provenance !== "UNAVAILABLE" && typeof metric.value === "number" && Number.isFinite(metric.value) ? metric.value : null;
}

/**
 * Groups persisted process.snapshot payloads by terminal session id.
 * Malformed rows are excluded without inventing replacement values.
 */
function collectSnapshots(
  eventRepo: EventRepository,
  terminalIds: Set<string>,
): Map<string, Array<Record<string, unknown>>> {
  const snapshots = new Map<string, Array<Record<string, unknown>>>();
  // Scoped to the terminal sessions actually needed, rather than to every
  // snapshot the database has ever held.
  for (const row of eventRepo.listSnapshotsForSessions([...terminalIds])) {
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const list = snapshots.get(row.session_id) ?? [];
      list.push(payload);
      snapshots.set(row.session_id, list);
    } catch {
      // A malformed persisted snapshot is excluded rather than replaced with
      // an empty object, so it contributes nothing instead of contributing
      // fabricated zeroes.
    }
  }
  return snapshots;
}

/**
 * Per-execution peaks and moments derived strictly from persisted
 * process.snapshot events. No values are synthesized; a missing field or a
 * too-short series leaves the corresponding summary null.
 */
export function computeRuntimePeaks(events: CanonicalEvent[]): RuntimePeaks {
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
  const base = new Date(events[0]?.timestamp ?? 0).getTime();
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

    const rss = metricValue(payload.rssBytes);
    if (rss !== null) {
      rssValues.push(rss);
      if (out.peakRssBytes === null || rss > out.peakRssBytes.value) {
        out.peakRssBytes = { value: rss, atTimeMs: atMs, atTimestamp: ts };
      }
    }

    const cpu = metricValue(payload.cpuPercent);
    if (cpu !== null && (out.peakCpuPercent === null || cpu > out.peakCpuPercent.value)) {
      out.peakCpuPercent = { value: cpu, atTimeMs: atMs, atTimestamp: ts };
    }

    const elapsed = metricValue(payload.elapsedMs);
    if (elapsed !== null) {
      out.minElapsedMs = out.minElapsedMs === null ? elapsed : Math.min(out.minElapsedMs, elapsed);
      out.maxElapsedMs = out.maxElapsedMs === null ? elapsed : Math.max(out.maxElapsedMs, elapsed);
    }

    const user = metricValue(payload.cpuUserMs);
    const system = metricValue(payload.cpuSystemMs);
    if (user !== null && system !== null) {
      lastUser = user;
      lastSystem = system;
    }
    const cpuTime = metricValue(payload.cpuTimeMs);
    if (cpuTime !== null) lastCpuTime = cpuTime;

    track(out, "peakMinorFaults", payload.minorFaults, atMs, ts);
    track(out, "peakMajorFaults", payload.majorFaults, atMs, ts);
    track(out, "peakMinorFaultsPerSec", payload.minorFaultsPerSec, atMs, ts);
    track(out, "peakMajorFaultsPerSec", payload.majorFaultsPerSec, atMs, ts);
    track(out, "peakRcharBytesPerSec", payload.rcharBytesPerSec, atMs, ts);
    track(out, "peakWcharBytesPerSec", payload.wcharBytesPerSec, atMs, ts);

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

/** Keep the highest observed value of a metric together with where it happened. */
function track(
  out: RuntimePeaks,
  key: "peakMinorFaults" | "peakMajorFaults" | "peakMinorFaultsPerSec" | "peakMajorFaultsPerSec" | "peakRcharBytesPerSec" | "peakWcharBytesPerSec",
  metric: unknown,
  atMs: number,
  ts: string,
): void {
  const value = metricValue(metric);
  if (value === null) return;
  if (out[key] === null || value > out[key]!.value) out[key] = { value, atTimeMs: atMs, atTimestamp: ts };
}

function latestValue(current: number | null, metric: unknown): number | null {
  const value = metricValue(metric);
  return value === null ? current : value;
}

/**
 * Command profiles over terminal sessions: duration distribution plus
 * telemetry aggregates from the same persisted snapshot series.
 */
export function computeCommandProfiles(repo: SessionRepository, eventRepo: EventRepository): CommandProfile[] {
  const rows = repo.listForAnalytics();
  const byCommand = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byCommand.get(row.command) ?? [];
    list.push(row);
    byCommand.set(row.command, list);
  }

  const terminalIds = new Set(rows.map((row) => row.id));
  const snapshots = collectSnapshots(eventRepo, terminalIds);
  const sessionsByCommand = new Map<string, string[]>();
  for (const row of rows) {
    const list = sessionsByCommand.get(row.command) ?? [];
    list.push(row.id);
    sessionsByCommand.set(row.command, list);
  }

  const profiles: CommandProfile[] = [];
  for (const [command, runs] of byCommand) {
    const durations = runs
      .map((r) => r.duration_ms)
      .filter((d): d is number => typeof d === "number" && d >= 0);
    const sorted = [...durations].sort((a, b) => a - b);
    const successful = runs.filter((r) => r.is_success === 1).length;
    const failed = runs.filter((r) => r.is_success === 0).length;
    const signalled = runs.filter((r) => typeof r.signal === "number" && r.signal > 0).length;

    const rssValues: number[] = [];
    for (const sessionId of sessionsByCommand.get(command) ?? []) {
      for (const sample of snapshots.get(sessionId) ?? []) {
        const rss = metricValue(sample.rssBytes);
        if (rss !== null) rssValues.push(rss);
      }
    }
    const rssSorted = [...rssValues].sort((a, b) => a - b);
    const lastRunAt = runs.reduce<string | null>((latest, r) => (latest === null || r.created_at > latest ? r.created_at : latest), null);

    profiles.push({
      command,
      runs: runs.length,
      successful,
      failed,
      signalled,
      successRate: runs.length > 0 ? (successful / runs.length) * 100 : null,
      avgDurationMs: sorted.length > 0 ? Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 10) / 10 : null,
      medianDurationMs: percentile(sorted, 50),
      p95DurationMs: percentile(sorted, 95),
      minDurationMs: sorted[0] ?? null,
      maxDurationMs: sorted.at(-1) ?? null,
      rssSamples: rssValues.length,
      medianRssBytes: rssSorted.length >= 2 ? rssSorted[Math.floor(rssSorted.length / 2)] ?? null : null,
      peakRssBytes: rssSorted.length > 0 ? rssSorted.at(-1) ?? null : null,
      lastRunAt,
    });
  }

  return profiles.sort((a, b) => b.runs - a.runs);
}

function comparisonSide(session: SessionRecord, peaks: RuntimePeaks, eventCount: number): ComparisonSide {
  return {
    sessionId: session.id,
    command: session.command,
    args: session.args,
    status: session.status,
    exitCode: session.exitCode,
    signal: session.signal,
    durationMs: session.durationMs,
    eventCount,
    snapshotCount: peaks.sampleCount,
    peakRssBytes: peaks.peakRssBytes?.value ?? null,
    medianRssBytes: peaks.medianRssBytes,
    peakCpuPercent: peaks.peakCpuPercent?.value ?? null,
    cpuTimeMs: peaks.cpuTimeMs,
    peakMinorFaults: peaks.peakMinorFaults?.value ?? null,
    peakMajorFaults: peaks.peakMajorFaults?.value ?? null,
    totalRcharBytes: peaks.totalRcharBytes,
    totalWcharBytes: peaks.totalWcharBytes,
    /*
     * Block-layer bytes, carried for the same reason as rchar/wchar and computed
     * from the same persisted snapshots.
     *
     * The comparison view already has "Block read" and "Block write" rows, and
     * the totals it needs exist here in RuntimePeaks. They were simply not
     * projected onto the comparison side, so the rows rendered
     * `fmtBytes(undefined)`, which passes the helper's `null` guard and prints
     * "NaN MiB", and a delta computed as `undefined - undefined`, printed as
     * "−NaN MiB". A NaN in a comparison table is not a cosmetic defect: it is the
     * one value in the table that cannot have been measured.
     *
     * `null` still means "no block I/O was observed", which is different from
     * zero and is rendered as UNAVAILABLE rather than as 0 B.
     */
    totalReadBytes: peaks.totalReadBytes,
    totalWriteBytes: peaks.totalWriteBytes,
  };
}

function delta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return b - a;
}

/** Side-by-side comparison of two completed executions, persisted data only. */
export function compareSessions(
  a: SessionRecord,
  b: SessionRecord,
  aEvents: CanonicalEvent[],
  bEvents: CanonicalEvent[],
): SessionComparison {
  const left = comparisonSide(a, computeRuntimePeaks(aEvents), aEvents.length);
  const right = comparisonSide(b, computeRuntimePeaks(bEvents), bEvents.length);
  return {
    left,
    right,
    shared: {
      sameCommand: a.command === b.command,
      command: a.command === b.command ? a.command : null,
      sameExit: a.exitCode !== null && a.exitCode === b.exitCode,
      sameSignal: a.signal !== null && a.signal === b.signal,
      sameStatus: a.status === b.status,
    },
    deltas: {
      durationMs: delta(left.durationMs, right.durationMs),
      eventDelta: right.eventCount - left.eventCount,
      snapshotDelta: right.snapshotCount - left.snapshotCount,
      peakRssDeltaBytes: delta(left.peakRssBytes, right.peakRssBytes),
      cpuTimeDeltaMs: delta(left.cpuTimeMs, right.cpuTimeMs),
      minorFaultsDelta: delta(left.peakMinorFaults, right.peakMinorFaults),
      majorFaultsDelta: delta(left.peakMajorFaults, right.peakMajorFaults),
      rcharDeltaBytes: delta(left.totalRcharBytes, right.totalRcharBytes),
      wcharDeltaBytes: delta(left.totalWcharBytes, right.totalWcharBytes),
      readBytesDelta: delta(left.totalReadBytes, right.totalReadBytes),
      writeBytesDelta: delta(left.totalWriteBytes, right.totalWriteBytes),
    },
  };
}
