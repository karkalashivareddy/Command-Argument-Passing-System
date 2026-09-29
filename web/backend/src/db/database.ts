import { DatabaseSync } from "node:sqlite";

import { logger } from "../utils/logger.js";

/**
 * Schema management.
 *
 * The previous design created every table with `CREATE TABLE IF NOT EXISTS`,
 * which means the shape of an existing database is whatever it was the first
 * time it was opened.  A column added later is simply absent, and nothing
 * reports that.  This is a versioned, forward-only migration runner instead:
 *
 *   - `schema_version` records the highest applied migration;
 *   - migrations are an ordered, append-only list, applied inside one
 *     transaction each, so a failure leaves the previous version intact;
 *   - applying an already-applied migration is a no-op, which makes
 *     `migrate()` safe to call on every open and makes the tests
 *     order-independent;
 *   - a database whose version is *newer* than this build is refused rather
 *     than downgraded, because a newer writer may have stored data an older
 *     reader would misinterpret.
 */

export const SCHEMA_VERSION = 3;

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly up: (db: DatabaseSync) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "initial-schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE sessions (
          id            TEXT PRIMARY KEY,
          command       TEXT NOT NULL,
          args          TEXT NOT NULL DEFAULT '[]',
          redirections  TEXT NOT NULL DEFAULT '{}',
          status        TEXT NOT NULL,
          started_at    TEXT NOT NULL,
          ended_at      TEXT,
          duration_ms   INTEGER,
          exit_code     INTEGER,
          signal        INTEGER,
          is_success    INTEGER,
          pid           INTEGER,
          stdout        TEXT NOT NULL DEFAULT '',
          stderr        TEXT NOT NULL DEFAULT '',
          error         TEXT,
          timeout_ms    INTEGER,
          created_at    TEXT NOT NULL
        );

        CREATE TABLE events (
          id           TEXT PRIMARY KEY,
          session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          sequence     INTEGER NOT NULL,
          type         TEXT NOT NULL,
          source       TEXT NOT NULL,
          timestamp    TEXT NOT NULL,
          monotonic_ms INTEGER,
          pid          INTEGER,
          payload      TEXT NOT NULL DEFAULT '{}',
          UNIQUE (session_id, sequence)
        );

        CREATE TABLE redirections (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          slot        TEXT NOT NULL,
          target      TEXT NOT NULL,
          flags       TEXT NOT NULL
        );

        CREATE INDEX idx_events_session ON events(session_id, sequence);
        CREATE INDEX idx_events_type_session ON events(type, session_id, sequence);
        CREATE INDEX idx_sessions_created ON sessions(created_at DESC);
        CREATE INDEX idx_sessions_status ON sessions(status);
      `);
    },
  },
  {
    id: 2,
    name: "drop-unused-processes-table",
    up: (db) => {
      /*
       * `processes` was created and deleted from but never written to, which
       * made it look like a second source of truth for process state next to
       * the event store.  The event store is canonical, so the unused table is
       * removed rather than left to mislead.  See docs/architecture.md.
       */
      db.exec(`DROP TABLE IF EXISTS processes;`);
    },
  },
  {
    id: 3,
    name: "event-corrupt-marker-and-retention-index",
    up: (db) => {
      /*
       * A payload that no longer parses used to be silently replaced with {},
       * which turned a corrupt event into a valid-looking one with no fields.
       * The corruption is now recorded on the row itself so every reader can
       * see it and refuse to invent values.
       */
      db.exec(`
        ALTER TABLE events ADD COLUMN payload_corrupt INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE events ADD COLUMN payload_error TEXT;

        -- Retention sweeps order by creation time; without this every sweep
        -- is a full scan of the sessions table.
        CREATE INDEX IF NOT EXISTS idx_sessions_created_sweep ON sessions(created_at);
      `);
    },
  },
];

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== undefined;
}

function readVersion(db: DatabaseSync): number {
  if (!tableExists(db, "schema_version")) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  return Number(row?.v ?? 0);
}

function recordVersion(db: DatabaseSync, version: number, name: string, at: string): void {
  db.prepare("INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)").run(version, name, at);
}

/**
 * Bring the database up to SCHEMA_VERSION.
 *
 * Idempotent: calling it twice applies nothing the second time.  Each
 * migration runs in its own transaction, so a migration that throws leaves
 * the database at the last version that fully succeeded rather than half
 * migrated.
 */
export function migrate(db: DatabaseSync): { from: number; to: number; applied: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const from = readVersion(db);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${from} is newer than this build supports (${SCHEMA_VERSION}). ` +
        "Refusing to open it: a newer writer may have stored data this build would misinterpret. " +
        "Upgrade the gateway or point CAPS_DATABASE_PATH at a different file.",
    );
  }

  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (m.id <= from) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      m.up(db);
      recordVersion(db, m.id, m.name, new Date().toISOString());
      db.exec("COMMIT");
      applied.push(`${m.id}:${m.name}`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration ${m.id} (${m.name}) failed and was rolled back; the database is still at version ${from}. Cause: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (applied.length > 0) {
    logger.info("STORAGE", "schema migrated", { from, to: SCHEMA_VERSION, applied });
  }
  return { from, to: SCHEMA_VERSION, applied };
}

export interface OpenDatabaseOptions {
  /** How long SQLite waits on a locked database before failing. */
  busyTimeoutMs?: number;
}

/**
 * Open (creating if needed) the gateway database with production pragmas.
 *
 * `busy_timeout` matters because the gateway is not the only possible writer
 * of this file: an operator inspecting the database with the sqlite3 CLI
 * will hold a lock, and without a timeout that turns into an immediate
 * `SQLITE_BUSY` on the next request. `foreign_keys` is what makes the
 * `ON DELETE CASCADE` from events and redirections to sessions real, so a
 * session delete cannot leave orphan events behind.
 */
export type Database = DatabaseSync;

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000))};`);
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

/**
 * Run `fn` inside one transaction.
 *
 * Session creation spans three writes (the session row, its redirection
 * rows, and the first event).  Without a transaction a failure between them
 * leaves a session that exists with no event, or events that reference
 * nothing -- the exact "database says one thing, the event stream says
 * another" state the event invariants exist to prevent.
 */
export function transact<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction was already gone; the original error is the useful one */
    }
    throw err;
  }
}
