import type { DatabaseSync } from "node:sqlite";

import type { CanonicalEvent } from "../../types/observability.js";

/**
 * A payload that could not be parsed is *recorded*, never replaced.
 *
 * The previous behaviour caught the JSON error and substituted `{}`, which
 * produced an event that looked structurally valid while every field in it
 * had silently vanished.  A replay consumer would then read "no rssBytes"
 * and could not tell that apart from a metric the kernel never reported.  The
 * corruption is now explicit on the row and in the API surface.
 */
export interface EventRow {
  id: string;
  session_id: string;
  sequence: number;
  type: string;
  source: string;
  timestamp: string;
  monotonic_ms: number | null;
  pid: number | null;
  payload: string;
  payload_corrupt: number | null;
  payload_error: string | null;
}

export function rowToEvent(r: EventRow): CanonicalEvent {
  const corrupt = r.payload_corrupt === 1;
  let payload: Record<string, unknown> = {};
  if (corrupt) {
    // Structurally present but explicitly empty, with the reason attached, so
    // no downstream code can mistake this for an event that had no data.
    return baseEvent(r, payload, {
      payloadCorrupt: true,
      payloadError: r.payload_error ?? "payload could not be parsed",
    });
  }
  try {
    const parsed = JSON.parse(r.payload) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    } else {
      return baseEvent(r, payload, {
        payloadCorrupt: true,
        payloadError: "payload was not a JSON object",
      });
    }
  } catch (err) {
    return baseEvent(r, payload, {
      payloadCorrupt: true,
      payloadError: err instanceof Error ? err.message : "payload could not be parsed",
    });
  }
  return baseEvent(r, payload, {});
}

function baseEvent(
  r: EventRow,
  payload: Record<string, unknown>,
  extra: Record<string, unknown>,
): CanonicalEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    sequence: Number(r.sequence),
    type: r.type as CanonicalEvent["type"],
    source: r.source as CanonicalEvent["source"],
    timestamp: r.timestamp,
    monotonicMs: r.monotonic_ms,
    pid: r.pid,
    payload: { ...payload, ...extra },
  };
}

export class EventRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(ev: CanonicalEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (id, session_id, sequence, type, source, timestamp, monotonic_ms, pid, payload, payload_corrupt, payload_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      )
      .run(ev.id, ev.sessionId, ev.sequence, ev.type, ev.source, ev.timestamp,
        ev.monotonicMs, ev.pid, JSON.stringify(ev.payload));
  }

  maxSequence(sessionId: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(sequence), -1) AS n FROM events WHERE session_id=?").get(sessionId) as { n: number };
    return Number(r.n);
  }

  listForSession(sessionId: string, afterSeq = -1): CanonicalEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE session_id=? AND sequence>? ORDER BY sequence ASC")
      .all(sessionId, afterSeq) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  listAllForSession(sessionId: string): CanonicalEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE session_id=? ORDER BY sequence ASC")
      .all(sessionId) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  latestForSessionByType(sessionId: string, type: string): CanonicalEvent | null {
    const row = this.db
      .prepare("SELECT * FROM events WHERE session_id=? AND type=? ORDER BY sequence DESC LIMIT 1")
      .get(sessionId, type) as EventRow | undefined;
    return row === undefined ? null : rowToEvent(row);
  }

  /**
   * The most recent events across every session, oldest first.
   *
   * `recent` was previously filtered with `recent.some(...)` on every
   * delivered event, which is O(recent) per frame.  Callers now get the ids
   * alongside the rows so the duplicate filter is a Set lookup.
   */
  listRecentGlobal(limit: number): { events: CanonicalEvent[]; ids: Set<string> } {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY rowid DESC LIMIT ?")
      .all(limit) as unknown as EventRow[];
    const events = rows.reverse().map(rowToEvent);
    return { events, ids: new Set(events.map((e) => e.id)) };
  }

  /**
   * Aggregate process.telemetry directly in SQL.
   *
   * Analytics used to load every `process.snapshot` payload in the database
   * and `JSON.parse` each one on every request.  Each snapshot is a wide object
   * with ~30 metric fields, so the cost grew with total history rather than
   * with the window requested.  These aggregates are computed from the same
   * persisted rows with `json_extract`, so every number is still traceable to
   * evidence; only the JavaScript object materialisation is avoided.
   *
   * Semantics are preserved exactly, including the "last sample per
   * execution" rule for CPU totals (a window function selects the newest
   * snapshot per session) and the "needs at least two observations" rule that
   * stops a mean of one sample being presented as a trend.
   */
  aggregateProcessTelemetry(): {
    sampleCount: number;
    executionsSampled: number;
    rssSamples: number;
    averageRssBytes: number | null;
    maxRssBytes: number | null;
    cpuPercentSamples: number;
    averageCpuPercent: number | null;
    cpuTimeExecutions: number;
    averageCpuTimeMs: number | null;
    minorFaultSamples: number;
    averageMinorFaults: number | null;
    majorFaultSamples: number;
    averageMajorFaults: number | null;
    maxMajorFaults: number | null;
    rcharRateSamples: number;
    averageRcharBytesPerSec: number | null;
    maxRcharBytesPerSec: number | null;
    wcharRateSamples: number;
    averageWcharBytesPerSec: number | null;
    maxWcharBytesPerSec: number | null;
  } {
    const rss = "json_extract(payload,'$.rssBytes.value')";
    const cpuPercent = "json_extract(payload,'$.cpuPercent.value')";
    const cpuTime = "json_extract(payload,'$.cpuTimeMs.value')";
    const cpuUser = "json_extract(payload,'$.cpuUserMs.value')";
    const cpuSystem = "json_extract(payload,'$.cpuSystemMs.value')";
    const minorFaults = "json_extract(payload,'$.minorFaults.value')";
    const majorFaults = "json_extract(payload,'$.majorFaults.value')";
    const rcharRate = "json_extract(payload,'$.rcharBytesPerSec.value')";
    const wcharRate = "json_extract(payload,'$.wcharBytesPerSec.value')";

    const base = this.db
      .prepare(`
        WITH samples AS (
          SELECT session_id, sequence, payload FROM events WHERE type = 'process.snapshot'
        ),
        ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY sequence DESC) AS rn FROM samples
        )
        SELECT
          (SELECT COUNT(*) FROM samples)                                            AS sampleCount,
          (SELECT COUNT(DISTINCT session_id) FROM samples)                         AS executionsSampled,
          SUM(CASE WHEN ${rss} IS NOT NULL THEN 1 ELSE 0 END)                       AS rssSamples,
          AVG(${rss})                                                              AS avgRss,
          MAX(${rss})                                                              AS maxRss,
          SUM(CASE WHEN ${cpuPercent} IS NOT NULL THEN 1 ELSE 0 END)                AS cpuPercentSamples,
          AVG(${cpuPercent})                                                       AS avgCpuPercent,
          SUM(CASE WHEN ${minorFaults} IS NOT NULL THEN 1 ELSE 0 END)              AS minorFaultSamples,
          AVG(${minorFaults})                                                      AS avgMinorFaults,
          SUM(CASE WHEN ${majorFaults} IS NOT NULL THEN 1 ELSE 0 END)              AS majorFaultSamples,
          AVG(${majorFaults})                                                      AS avgMajorFaults,
          MAX(${majorFaults})                                                      AS maxMajorFaults,
          SUM(CASE WHEN ${rcharRate} IS NOT NULL THEN 1 ELSE 0 END)                AS rcharRateSamples,
          AVG(${rcharRate})                                                       AS avgRcharRate,
          MAX(${rcharRate})                                                       AS maxRcharRate,
          SUM(CASE WHEN ${wcharRate} IS NOT NULL THEN 1 ELSE 0 END)                AS wcharRateSamples,
          AVG(${wcharRate})                                                       AS avgWcharRate,
          MAX(${wcharRate})                                                       AS maxWcharRate
        FROM samples
      `)
      .get() as Record<string, number | null>;

    // CPU total per execution: the newest sample of that session, with a
    // fallback to the two tick counters for rows written before cpuTimeMs
    // existed.  This is the same rule the previous in-JavaScript pass used.
    const cpuRow = this.db
      .prepare(`
        WITH ranked AS (
          SELECT session_id, sequence, payload,
                 ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY sequence DESC) AS rn
          FROM events WHERE type = 'process.snapshot'
        )
        SELECT
          COUNT(cpu) AS cpuExecutions,
          AVG(cpu)  AS avgCpuTime
        FROM (
          SELECT
            COALESCE(
              json_extract(payload,'$.cpuTimeMs.value'),
              CASE WHEN json_extract(payload,'$.cpuUserMs.value') IS NOT NULL
                    AND json_extract(payload,'$.cpuSystemMs.value') IS NOT NULL
                   THEN json_extract(payload,'$.cpuUserMs.value')
                      + json_extract(payload,'$.cpuSystemMs.value')
              END
            ) AS cpu
          FROM ranked WHERE rn = 1
        ) WHERE cpu IS NOT NULL
      `)
      .get() as { cpuExecutions: number | null; avgCpuTime: number | null };

    const n = (v: number | null | undefined): number | null =>
      v === null || v === undefined || !Number.isFinite(v) ? null : Number(v);
    const c = (v: number | null | undefined): number => Number(v ?? 0);

    const rssSamples = c(base.rssSamples);
    const cpuPercentSamples = c(base.cpuPercentSamples);
    const minorFaultSamples = c(base.minorFaultSamples);
    const majorFaultSamples = c(base.majorFaultSamples);
    const rcharRateSamples = c(base.rcharRateSamples);
    const wcharRateSamples = c(base.wcharRateSamples);
    const cpuTimeExecutions = c(cpuRow.cpuExecutions);

    return {
      sampleCount: c(base.sampleCount),
      executionsSampled: c(base.executionsSampled),
      rssSamples,
      // A mean over a single observation is a fact, not a trend; the previous
      // implementation refused to report it, and so does this.
      averageRssBytes: rssSamples >= 2 ? n(base.avgRss) : null,
      maxRssBytes: n(base.maxRss),
      cpuPercentSamples,
      averageCpuPercent: cpuPercentSamples >= 2 ? n(base.avgCpuPercent) : null,
      cpuTimeExecutions,
      averageCpuTimeMs: cpuTimeExecutions >= 2 ? n(cpuRow.avgCpuTime) : null,
      minorFaultSamples,
      averageMinorFaults: minorFaultSamples >= 2 ? n(base.avgMinorFaults) : null,
      majorFaultSamples,
      averageMajorFaults: majorFaultSamples >= 2 ? n(base.avgMajorFaults) : null,
      maxMajorFaults: n(base.maxMajorFaults),
      rcharRateSamples,
      averageRcharBytesPerSec: rcharRateSamples >= 2 ? n(base.avgRcharRate) : null,
      maxRcharBytesPerSec: n(base.maxRcharRate),
      wcharRateSamples,
      averageWcharBytesPerSec: wcharRateSamples >= 2 ? n(base.avgWcharRate) : null,
      maxWcharBytesPerSec: n(base.maxWcharRate),
    };
  }

  /**
   * Snapshot payloads for an explicit, bounded set of sessions.
   *
   * Used by the command-profile aggregation, which needs per-execution peaks
   * and so cannot be reduced in SQL.  The session set is chunked because
   * SQLite caps the number of bound parameters, and the result is scoped to
   * those sessions rather than to the whole table.
   */
  listSnapshotsForSessions(sessionIds: readonly string[]): Array<{ session_id: string; payload: string; sequence: number }> {
    const out: Array<{ session_id: string; payload: string; sequence: number }> = [];
    const CHUNK = 400;
    for (let i = 0; i < sessionIds.length; i += CHUNK) {
      const chunk = sessionIds.slice(i, i + CHUNK);
      if (chunk.length === 0) continue;
      const marks = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT session_id, sequence, payload FROM events
           WHERE type='process.snapshot' AND session_id IN (${marks})
           ORDER BY session_id, sequence`,
        )
        .all(...chunk) as unknown as Array<{ session_id: string; sequence: number; payload: string }>;
      out.push(...rows);
    }
    return out;
  }

  /** How many events in a session have an unparsable payload. */
  countCorruptPayloads(sessionId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id=? AND payload_corrupt=1")
      .get(sessionId) as { n: number };
    return Number(r.n ?? 0);
  }

  /** Mark rows whose payload is no longer valid JSON, and record the reason. */
  markCorruptPayloads(): number {
    const rows = this.db
      .prepare("SELECT id, session_id, sequence, type, source, timestamp, monotonic_ms, pid, payload FROM events WHERE payload_corrupt = 0")
      .all() as unknown as EventRow[];
    let marked = 0;
    const update = this.db.prepare("UPDATE events SET payload_corrupt = 1, payload_error = ? WHERE id = ?");
    for (const row of rows) {
      try {
        const parsed: unknown = JSON.parse(row.payload);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          update.run("payload was not a JSON object", row.id);
          marked++;
        }
      } catch (err) {
        update.run(err instanceof Error ? err.message : "payload could not be parsed", row.id);
        marked++;
      }
    }
    return marked;
  }
}
