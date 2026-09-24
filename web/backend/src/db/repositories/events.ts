import type { DatabaseSync } from "node:sqlite";

import type { CanonicalEvent } from "../../types/observability.js";

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
}

export function rowToEvent(r: EventRow): CanonicalEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    sequence: Number(r.sequence),
    type: r.type as CanonicalEvent["type"],
    source: r.source as CanonicalEvent["source"],
    timestamp: r.timestamp,
    monotonicMs: r.monotonic_ms,
    pid: r.pid,
    payload,
  };
}

export class EventRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(ev: CanonicalEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (id, session_id, sequence, type, source, timestamp, monotonic_ms, pid, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  listRecentGlobal(limit: number, excludeSessionIds: string[] = []): CanonicalEvent[] {
    let sql = "SELECT * FROM events";
    if (excludeSessionIds.length) {
      const marks = excludeSessionIds.map(() => "?").join(",");
      sql += ` WHERE session_id NOT IN (${marks})`;
    }
    sql += " ORDER BY rowid DESC LIMIT ?";
    const rows = (excludeSessionIds.length
      ? this.db.prepare(sql).all(...excludeSessionIds, limit)
      : this.db.prepare(sql).all(limit)) as unknown as EventRow[];
    return rows.reverse().map(rowToEvent);
  }
}