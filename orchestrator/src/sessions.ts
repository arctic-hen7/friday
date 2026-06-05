import { db, nowIso } from "./db";
import type { LiveSession, Message, SessionRow } from "./types";

// ---------- Persisted session CRUD ----------

export function listSessions(): SessionRow[] {
    return db
        .query<SessionRow, []>(
            `SELECT id, label, created_at AS createdAt, last_active_at AS lastActiveAt
             FROM sessions ORDER BY last_active_at DESC`,
        )
        .all();
}

export function getSession(id: string): SessionRow | null {
    return (
        db
            .query<SessionRow, [string]>(
                `SELECT id, label, created_at AS createdAt, last_active_at AS lastActiveAt
                 FROM sessions WHERE id = ?`,
            )
            .get(id) ?? null
    );
}

export function createSession(label: string): SessionRow {
    const id = crypto.randomUUID();
    const ts = nowIso();
    db.run(
        `INSERT INTO sessions(id, label, created_at, last_active_at) VALUES(?, ?, ?, ?)`,
        [id, label, ts, ts],
    );
    return { id, label, createdAt: ts, lastActiveAt: ts };
}

export function touchSession(id: string): void {
    db.run("UPDATE sessions SET last_active_at = ? WHERE id = ?", [nowIso(), id]);
}

export function deleteSession(id: string): void {
    // messages cascade via FK; jobs.session_id is set NULL by FK rule.
    db.run("DELETE FROM sessions WHERE id = ?", [id]);
}

// ---------- Message history ----------

export function loadHistory(sessionId: string): Message[] {
    return db
        .query<Message, [string]>(
            `SELECT id, session_id AS sessionId, role, text, marker, created_at AS createdAt
             FROM messages WHERE session_id = ? ORDER BY id ASC`,
        )
        .all(sessionId);
}

export function appendMessage(
    sessionId: string,
    role: Message["role"],
    text: string,
    marker: Message["marker"] = null,
): Message {
    const ts = nowIso();
    const info = db.run(
        `INSERT INTO messages(session_id, role, text, marker, created_at) VALUES(?, ?, ?, ?, ?)`,
        [sessionId, role, text, marker, ts],
    );
    touchSession(sessionId);
    return {
        id: Number(info.lastInsertRowid),
        sessionId,
        role,
        text,
        marker,
        createdAt: ts,
    };
}

// ---------- Live attachment registry ----------
// Sessions become "live" only while an IL has them attached. The orchestrator
// holds one entry per session id and refuses attachment when one already exists.

const live = new Map<string, LiveSession>();

export function liveSession(id: string): LiveSession | undefined {
    return live.get(id);
}

export function registerLiveSession(row: SessionRow): LiveSession {
    let entry = live.get(row.id);
    if (!entry) {
        entry = { id: row.id, label: row.label, attached: null };
        live.set(row.id, entry);
    }
    return entry;
}

export function isAttached(id: string): boolean {
    return !!live.get(id)?.attached;
}

// Short-lived reservations: covers the gap between minting a WS token and
// the IL completing the WS upgrade. Without this, two ILs that both call
// /attach in quick succession would both get tokens.
const reservations = new Map<string, number>(); // sessionId -> expiresAt
const RESERVATION_TTL_MS = 60_000;

export function reserveAttachment(id: string): boolean {
    const now = Date.now();
    for (const [k, exp] of reservations) {
        if (exp < now) reservations.delete(k);
    }
    if (isAttached(id) || reservations.has(id)) return false;
    reservations.set(id, now + RESERVATION_TTL_MS);
    return true;
}

export function releaseReservation(id: string): void {
    reservations.delete(id);
}

export function dropLive(id: string): void {
    live.delete(id);
}

export function allLive(): LiveSession[] {
    return [...live.values()];
}
