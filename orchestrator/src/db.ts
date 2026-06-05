import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DB_PATH = process.env.FRIDAY_DB_PATH ?? "/data/friday.db";
const SCHEMA_PATH = resolve(import.meta.dir, "./schema.sql");

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(readFileSync(SCHEMA_PATH, "utf8"));

export function nowIso(): string {
    return new Date().toISOString();
}

// Settings helpers — small key/value store.
export function getSetting(key: string): string | null {
    const row = db
        .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
        .get(key);
    return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
    db.run(
        "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    );
}

// Default settings on first boot.
const DEFAULT_TIMEZONE = "Australia/Sydney";
if (getSetting("timezone") === null) setSetting("timezone", DEFAULT_TIMEZONE);
