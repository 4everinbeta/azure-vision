import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { KeyValueStore } from "./types";
import { config } from "../config";

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS inventory_cache (
  cache_key TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  data TEXT NOT NULL
)`);

const getStmt = db.prepare("SELECT fetched_at, data FROM inventory_cache WHERE cache_key = ?");
const putStmt = db.prepare(
  "INSERT INTO inventory_cache (cache_key, fetched_at, data) VALUES (?, ?, ?) " +
    "ON CONFLICT(cache_key) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data",
);

export const sqliteStore: KeyValueStore = {
  async get<T>(key: string, ttlMs: number) { return getCached<T>(key, ttlMs); },
  async put<T>(key: string, value: T) { putCached(key, value); },
};

function getCached<T>(key: string, ttlMs: number): T | undefined {
  const row = getStmt.get(key) as { fetched_at: number; data: string } | undefined;
  if (!row || Date.now() - row.fetched_at >= ttlMs) return undefined;
  return JSON.parse(row.data) as T;
}

function putCached(key: string, value: unknown) {
  putStmt.run(key, Date.now(), JSON.stringify(value));
}
