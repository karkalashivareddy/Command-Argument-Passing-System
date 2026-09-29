import type { DatabaseSync } from "node:sqlite";

import { transact } from "../database.js";
import type { RedirectionSpec, SessionRecord, SessionStatus } from "../../types/observability.js";

export interface SessionRow {
  id: string;
  command: string;
  args: string;
  redirections: string;
  status: SessionStatus;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  signal: number | null;
  is_success: number | null;
  pid: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  timeout_ms: number | null;
  created_at: string;
}

export interface CorruptJsonState {
  corrupt: boolean;
  error: string;
}

/**
 * Parse a persisted JSON column, reporting corruption instead of hiding it.
 *
 * Returning `[]` for unparsable args used to make a session look like a
 * command with no arguments.  The caller now receives an explicit state and
 * the session carries it, so the UI can say "the stored argv is unreadable"
 * rather than quietly showing the wrong thing.
 */
function parseJsonColumn(raw: string, expect: "array" | "object"): { value: unknown; state: CorruptJsonState } {
  try {
    const parsed: unknown = JSON.parse(raw);
    const ok =
      expect === "array"
        ? Array.isArray(parsed)
        : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    if (!ok) {
      return { value: expect === "array" ? [] : {}, state: { corrupt: true, error: `expected a JSON ${expect}` } };
    }
    return { value: parsed, state: { corrupt: false, error: "" } };
  } catch (err) {
    return {
      value: expect === "array" ? [] : {},
      state: { corrupt: true, error: err instanceof Error ? err.message : "unparsable JSON" },
    };
  }
}

function parseRow(r: SessionRow): SessionRecord {
  const argsParsed = parseJsonColumn(r.args, "array");
  const redirsParsed = parseJsonColumn(r.redirections, "object");
  const args = (argsParsed.value as unknown[]).map(String);
  const redirs = redirsParsed.value as RedirectionSpec;

  const record: SessionRecord = {
    id: r.id,
    command: r.command,
    args,
    argv: [r.command, ...args],
    redirections: redirs,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    exitCode: r.exit_code,
    signal: r.signal,
    isSuccess: r.is_success === null ? null : r.is_success === 1,
    pid: r.pid,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error,
    timeoutMs: r.timeout_ms,
    eventCount: 0,
  };

  if (argsParsed.state.corrupt || redirsParsed.state.corrupt) {
    record.storedJsonCorrupt = true;
    record.storedJsonError = [
      argsParsed.state.corrupt ? `args: ${argsParsed.state.error}` : null,
      redirsParsed.state.corrupt ? `redirections: ${redirsParsed.state.error}` : null,
    ]
      .filter(Boolean)
      .join("; ");
  }
  return record;
}

export interface CreateSessionInput {
  id: string;
  command: string;
  args: string[];
  redirections: RedirectionSpec;
  redirectionsDetail: ReadonlyArray<{ slot: string; target: string; flags: string }>;
  timeoutMs: number;
  startedAt: string;
  /** The first canonical event, written in the same transaction as the row. */
  firstEvent: { id: string; sequence: number; type: string; source: string; timestamp: string; payload: Record<string, unknown> } | null;
}

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Create a session, its redirection records, and its first event in one
   * transaction.
   *
   * These three writes belong together: a session with redirection rows but no
   * first event, or an event for a session row that was rolled away, is a
   * state the API cannot describe and the event invariants would reject.
   */
  createWithFirstEvent(input: CreateSessionInput): void {
    transact(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO sessions
           (id, command, args, redirections, status, started_at, timeout_ms, created_at)
           VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?)`,
        )
        .run(input.id, input.command, JSON.stringify(input.args),
          JSON.stringify(input.redirections), input.startedAt, input.timeoutMs, input.startedAt);

      const insertRedir = this.db.prepare(
        "INSERT INTO redirections (session_id, slot, target, flags) VALUES (?, ?, ?, ?)",
      );
      for (const r of input.redirectionsDetail) {
        insertRedir.run(input.id, r.slot, r.target, r.flags);
      }

      if (input.firstEvent !== null) {
        this.db
          .prepare(
            `INSERT INTO events (id, session_id, sequence, type, source, timestamp, monotonic_ms, pid, payload, payload_corrupt, payload_error)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, NULL)`,
          )
          .run(input.firstEvent.id, input.id, input.firstEvent.sequence,
            input.firstEvent.type, input.firstEvent.source, input.firstEvent.timestamp,
            JSON.stringify(input.firstEvent.payload));
      }
    });
  }

  create(input: {
    id: string;
    command: string;
    args: string[];
    redirections: RedirectionSpec;
    timeoutMs: number;
    startedAt: string;
  }): void {
    this.createWithFirstEvent({ ...input, redirectionsDetail: [], firstEvent: null });
  }

  setStatus(id: string, status: SessionStatus, endedAt?: string): void {
    const e = endedAt ?? new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET status=?, ended_at=COALESCE(ended_at, ?) WHERE id=?")
      .run(status, e, id);
  }

  finalize(
    id: string,
    fields: {
      status: SessionStatus;
      exitCode: number | null;
      signal: number | null;
      isSuccess: boolean | null;
      durationMs: number | null;
      pid: number | null;
      error: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET status=?, exit_code=?, signal=?, is_success=?, duration_ms=?,
                 pid=COALESCE(pid, ?), error=?, ended_at=COALESCE(ended_at, ?) WHERE id=?`,
      )
      .run(
        fields.status,
        fields.exitCode,
        fields.signal,
        fields.isSuccess === null ? null : fields.isSuccess ? 1 : 0,
        fields.durationMs,
        fields.pid,
        fields.error,
        new Date().toISOString(),
        id,
      );
  }

  setPid(id: string, pid: number): void {
    this.db.prepare("UPDATE sessions SET pid=? WHERE id=?").run(pid, id);
  }

  appendOutput(id: string, stdout: string, stderr: string): void {
    if (stdout.length === 0 && stderr.length === 0) return;
    this.db
      .prepare("UPDATE sessions SET stdout=stdout || ?, stderr=stderr || ? WHERE id=?")
      .run(stdout, stderr, id);
  }

  recordRedirection(id: string, slot: string, target: string, flags: string): void {
    this.db
      .prepare("INSERT INTO redirections (session_id, slot, target, flags) VALUES (?, ?, ?, ?)")
      .run(id, slot, target, flags);
  }

  findById(id: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionRow | undefined;
    if (row === undefined) return null;
    const rec = parseRow(row);
    rec.eventCount = this.eventCount(id);
    return rec;
  }

  eventCount(id: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id=?").get(id) as { n: number };
    return Number(r.n ?? 0);
  }

  list(limit: number, offset: number, opts?: { status?: string; q?: string }): SessionRecord[] {
    let sql = "SELECT * FROM sessions";
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts?.status && opts.status !== "ALL") {
      where.push("status=?");
      params.push(opts.status);
    }
    if (opts?.q) {
      where.push("(command LIKE ? OR args LIKE ? OR id LIKE ?)");
      const like = `%${opts.q}%`;
      params.push(like, like, like);
    }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params) as unknown as SessionRow[];
    return rows.map(parseRow);
  }

  count(opts?: { status?: string; q?: string }): number {
    let sql = "SELECT COUNT(*) AS n FROM sessions";
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts?.status && opts.status !== "ALL") {
      where.push("status=?");
      params.push(opts.status);
    }
    if (opts?.q) {
      where.push("(command LIKE ? OR args LIKE ? OR id LIKE ?)");
      const like = `%${opts.q}%`;
      params.push(like, like, like);
    }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    const r = this.db.prepare(sql).get(...params) as { n: number } | undefined;
    return Number(r?.n ?? 0);
  }

  deleteById(id: string): { sessions: boolean; events: boolean } {
    return transact(this.db, () => {
      const events = this.db.prepare("DELETE FROM events WHERE session_id=?").run(id).changes > 0;
      // redirections and events cascade from the session row, but are removed
      // explicitly so the behaviour does not depend on the foreign_keys
      // pragma being on in whatever connection the caller holds.
      this.db.prepare("DELETE FROM redirections WHERE session_id=?").run(id);
      const sessions = this.db.prepare("DELETE FROM sessions WHERE id=?").run(id).changes > 0;
      return { sessions, events };
    });
  }

  listForAnalytics(): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE status IN ('COMPLETED','FAILED','TIMED_OUT','CANCELLED')")
      .all() as unknown as SessionRow[];
  }

  listRedirections(): Array<{ slot: string; target: string }> {
    return this.db
      .prepare("SELECT slot, target FROM redirections ORDER BY session_id, id")
      .all() as unknown as Array<{ slot: string; target: string }>;
  }

  /** Sessions that were never finalized, oldest first. Used by boot recovery. */
  listNonTerminal(limit = 500): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE status IN ('CREATED','STARTING','RUNNING')
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as unknown as SessionRow[];
    return rows.map(parseRow);
  }

  /**
   * Delete sessions (and, by cascade, their events and redirections) older
   * than the retention window.
   *
   * Retention is a recorder requirement, not a surprise: it is off unless
   * CAPS_RETENTION_DAYS is set to a positive value, and every sweep logs what
   * it removed so an operator can see the recorder working.
   */
  purgeOlderThan(cutoffIso: string): { sessions: number; events: number } {
    return transact(this.db, () => {
      const events = this.db
        .prepare(
          `DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE created_at < ?)`,
        )
        .run(cutoffIso).changes;
      this.db
        .prepare("DELETE FROM redirections WHERE session_id IN (SELECT id FROM sessions WHERE created_at < ?)")
        .run(cutoffIso);
      const sessions = this.db.prepare("DELETE FROM sessions WHERE created_at < ?").run(cutoffIso).changes;
      return { sessions: Number(sessions), events: Number(events) };
    });
  }

  /** Total stored size, for the readiness payload and retention decisions. */
  storageStats(): { sessions: number; events: number; dbBytes: number | null } {
    const s = this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    const e = this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    let dbBytes: number | null = null;
    try {
      const pageCount = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
      const pageSize = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
      if (Number.isFinite(pageCount.page_count) && Number.isFinite(pageSize.page_size)) {
        dbBytes = pageCount.page_count * pageSize.page_size;
      }
    } catch {
      dbBytes = null;
    }
    return { sessions: Number(s.n ?? 0), events: Number(e.n ?? 0), dbBytes };
  }
}
