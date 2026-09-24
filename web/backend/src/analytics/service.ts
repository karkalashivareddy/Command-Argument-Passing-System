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
export function computeAnalytics(repo: SessionRepository): AnalyticsOverview {
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

  const terminalIds = new Set(rows.map((row) => row.id));
  const snapshots = collectSnapshots(repo, terminalIds);
  for (const records of snapshots.values()) result.processTelemetry.sampleCount += records.length;

  const rssSamples: number[] = [];
  const cpuPercentSamples: number[] = [];
  const terminalCpuTotals: number[] = [];
  for (const records of snapshots.values()) {
    for (const sample of records) {
      const rss = metricValue(sample.rssBytes);
      const cpuPercent = metricValue(sample.cpuPercent);
      if (rss !== null) rssSamples.push(rss);
      if (cpuPercent !== null) cpuPercentSamples.push(cpuPercent);
    }
    const latest = records.at(-1)!;
    const user = metricValue(latest.cpuUserMs);
    const system = metricValue(latest.cpuSystemMs);
    if (user !== null && system !== null) terminalCpuTotals.push(user + system);
  }
  result.processTelemetry.executionsSampled = snapshots.size;
  result.processTelemetry.rssSamples = rssSamples.length;
  result.processTelemetry.cpuPercentSamples = cpuPercentSamples.length;
  result.processTelemetry.cpuTimeExecutions = terminalCpuTotals.length;
  if (rssSamples.length >= 2) {
    result.processTelemetry.averageRssBytes = rssSamples.reduce((sum, value) => sum + value, 0) / rssSamples.length;
    result.processTelemetry.maxRssBytes = Math.max(...rssSamples);
  }
  if (terminalCpuTotals.length >= 2) {
    result.processTelemetry.averageCpuTimeMs = terminalCpuTotals.reduce((sum, value) => sum + value, 0) / terminalCpuTotals.length;
  }
  if (cpuPercentSamples.length >= 2) result.processTelemetry.averageCpuPercent = cpuPercentSamples.reduce((sum, value) => sum + value, 0) / cpuPercentSamples.length;

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
  repo: SessionRepository,
  terminalIds: Set<string>,
): Map<string, Array<Record<string, unknown>>> {
  const snapshots = new Map<string, Array<Record<string, unknown>>>();
  for (const row of repo.listProcessSnapshots()) {
    if (!terminalIds.has(row.session_id)) continue;
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const list = snapshots.get(row.session_id) ?? [];
      list.push(payload);
      snapshots.set(row.session_id, list);
    } catch {
      // skip malformed persisted snapshot
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
  };
  const base = new Date(events[0]?.timestamp ?? 0).getTime();
  const rssValues: number[] = [];
  let lastUser: number | null = null;
  let lastSystem: number | null = null;

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
  }

  if (rssValues.length >= 2) {
    const sorted = [...rssValues].sort((a, b) => a - b);
    out.medianRssBytes = sorted[Math.floor(sorted.length / 2)] ?? null;
  }
  if (lastUser !== null && lastSystem !== null) out.cpuTimeMs = lastUser + lastSystem;

  return out;
}

/**
 * Command profiles over terminal sessions: duration distribution plus
 * telemetry aggregates from the same persisted snapshot series.
 */
export function computeCommandProfiles(repo: SessionRepository): CommandProfile[] {
  const rows = repo.listForAnalytics();
  const byCommand = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byCommand.get(row.command) ?? [];
    list.push(row);
    byCommand.set(row.command, list);
  }

  const terminalIds = new Set(rows.map((row) => row.id));
  const snapshots = collectSnapshots(repo, terminalIds);
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
    },
  };
}
