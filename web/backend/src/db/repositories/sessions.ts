import type { DatabaseSync } from "node:sqlite";

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

function parseRow(r: SessionRow): SessionRecord {
  const args = safeJsonArray(r.args);
  let redirs: RedirectionSpec = {};
  try {
    redirs = JSON.parse(r.redirections) as RedirectionSpec;
  } catch {
    redirs = {};
  }
  return {
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
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    id: string;
    command: string;
    args: string[];
    redirections: RedirectionSpec;
    timeoutMs: number;
    startedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions
         (id, command, args, redirections, status, started_at, timeout_ms, created_at)
         VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?)`,
      )
      .run(input.id, input.command, JSON.stringify(input.args), JSON.stringify(input.redirections),
        input.startedAt, input.timeoutMs, input.startedAt);
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
    this.db
      .prepare("UPDATE sessions SET stdout=stdout || ?, stderr=stderr || ? WHERE id=?")
      .run(stdout, stderr, id);
  }

  recordRedirection(id: string, slot: keyof RedirectionSpec | "in" | "out" | "append", target: string, flags: string): void {
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
    sql += " LIMIT 1";
    const r = this.db.prepare(sql).get(...params) as { n: number } | undefined;
    return Number(r?.n ?? 0);
  }

  deleteById(id: string): { sessions: boolean; events: boolean } {
    const events = this.db.prepare("DELETE FROM events WHERE session_id=?").run(id).changes > 0;
    const sessions = this.db.prepare("DELETE FROM sessions WHERE id=?").run(id).changes > 0;
    this.db.prepare("DELETE FROM processes WHERE session_id=?").run(id);
    this.db.prepare("DELETE FROM redirections WHERE session_id=?").run(id);
    return { sessions, events };
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
}
