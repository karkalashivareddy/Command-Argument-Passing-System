import type { SessionRepository } from "../db/repositories/sessions.js";
import type { AnalyticsOverview } from "../types/observability.js";

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

  return result;
}
