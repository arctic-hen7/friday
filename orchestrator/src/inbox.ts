import { db, nowIso } from "./db";
import type { InboxRow, InboxSource } from "./types";

export function enqueueInbox(
    source: InboxSource,
    text: string,
    originSessionId: string | null,
): InboxRow {
    const id = crypto.randomUUID();
    const ts = nowIso();
    db.run(
        `INSERT INTO inbox(id, source, origin_session_id, text, created_at) VALUES(?, ?, ?, ?, ?)`,
        [id, source, originSessionId, text, ts],
    );
    return {
        id,
        source,
        originSessionId,
        text,
        createdAt: ts,
        deliveredAt: null,
    };
}

export function listUndelivered(): InboxRow[] {
    return db
        .query<InboxRow, []>(
            `SELECT id, source, origin_session_id AS originSessionId, text,
                    created_at AS createdAt, delivered_at AS deliveredAt
             FROM inbox WHERE delivered_at IS NULL ORDER BY created_at ASC`,
        )
        .all();
}

export function markDelivered(ids: string[]): void {
    if (ids.length === 0) return;
    const ts = nowIso();
    const placeholders = ids.map(() => "?").join(",");
    db.run(
        `UPDATE inbox SET delivered_at = ? WHERE id IN (${placeholders}) AND delivered_at IS NULL`,
        [ts, ...ids],
    );
}
