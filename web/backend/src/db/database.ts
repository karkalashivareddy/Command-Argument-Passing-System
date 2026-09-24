import { DatabaseSync } from "node:sqlite";

import { logger } from "../utils/logger.js";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
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

    CREATE TABLE IF NOT EXISTS events (
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

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_events_session_asc ON events(id);

    CREATE TABLE IF NOT EXISTS processes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      pid          INTEGER,
      command      TEXT NOT NULL,
      args         TEXT NOT NULL DEFAULT '[]',
      state        TEXT NOT NULL,
      started_at   TEXT NOT NULL,
      ended_at     TEXT,
      duration_ms  INTEGER,
      exit_code    INTEGER,
      signal       INTEGER
    );

    CREATE TABLE IF NOT EXISTS redirections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      slot        TEXT NOT NULL,
      target      TEXT NOT NULL,
      flags       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  `);
  logger.info("STORAGE", "schema ready");
}