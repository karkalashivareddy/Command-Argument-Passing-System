import type { DatabaseSync } from "node:sqlite";

export function dbHasTable(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row !== undefined;
}

export type Row = Record<string, unknown>;

export function rowAs< T extends object>(row: unknown): T | null {
  return row === undefined ? null : (row as T);
}
