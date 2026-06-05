import { Cron } from "croner";
import { db, getSetting, nowIso } from "./db";
import { spawnJob } from "./jobs";
import type { ScheduleKind, ScheduleRow } from "./types";

// In-memory tracking of croner instances. Recurring schedules each get a
// long-lived Cron; one-shot schedules use a single-shot Cron too (croner's
// `maxRuns: 1`).
const live = new Map<string, Cron>();

function rowFromDb(row: any): ScheduleRow {
    return {
        id: row.id,
        kind: row.kind,
        cron: row.cron,
        fireAt: row.fireAt,
        prompt: row.prompt,
        label: row.label,
        timezone: row.timezone,
        status: row.status,
        lastFiredAt: row.lastFiredAt,
        lastError: row.lastError,
        createdAt: row.createdAt,
    };
}

function loadAll(): ScheduleRow[] {
    return db
        .query<any, []>(
            `SELECT id, kind, cron, fire_at AS fireAt, prompt, label, timezone, status,
                    last_fired_at AS lastFiredAt, last_error AS lastError,
                    created_at AS createdAt
             FROM schedules`,
        )
        .all()
        .map(rowFromDb);
}

export function listSchedules(): ScheduleRow[] {
    return loadAll();
}

function resolveTimezone(row: ScheduleRow): string {
    return row.timezone ?? getSetting("timezone") ?? "Australia/Sydney";
}

async function fire(row: ScheduleRow): Promise<void> {
    try {
        // Scheduled fires have no owning session. Result goes to global inbox.
        await spawnJob(row.prompt, null, { source: "schedule" });
        db.run(
            `UPDATE schedules SET last_fired_at = ?, status = 'active', last_error = NULL WHERE id = ?`,
            [nowIso(), row.id],
        );

        // One-shots auto-delete after a successful spawn.
        if (row.kind === "once") {
            deleteSchedule(row.id);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.run(
            `UPDATE schedules SET status = 'failed', last_error = ?, last_fired_at = ? WHERE id = ?`,
            [msg, nowIso(), row.id],
        );
    }
}

function startCron(row: ScheduleRow): void {
    const tz = resolveTimezone(row);

    if (row.kind === "recurring") {
        if (!row.cron) return;
        // Re-resolve the timezone on every fire so a global timezone change
        // moves all schedules without an explicit override.
        const job = new Cron(
            row.cron,
            { timezone: tz, name: `schedule:${row.id}`, protect: true },
            () => {
                const fresh =
                    loadAll().find(r => r.id === row.id) ?? row;
                void fire(fresh);
            },
        );
        live.set(row.id, job);
    } else {
        if (!row.fireAt) return;
        const fireAt = new Date(row.fireAt);
        if (fireAt.getTime() <= Date.now()) {
            // Past-due one-shot — fire immediately, then delete.
            void fire(row);
            return;
        }
        const job = new Cron(
            fireAt,
            { name: `schedule:${row.id}`, maxRuns: 1, protect: true },
            () => {
                const fresh =
                    loadAll().find(r => r.id === row.id) ?? row;
                void fire(fresh);
            },
        );
        live.set(row.id, job);
    }
}

function stopCron(id: string): void {
    const job = live.get(id);
    if (!job) return;
    job.stop();
    live.delete(id);
}

export function bootScheduler(): void {
    for (const row of loadAll()) startCron(row);
    console.log(`[scheduler] booted with ${live.size} active schedules`);
}

/**
 * If `timezone` is omitted the schedule inherits the global timezone at
 * fire time. There's no agent-facing tool to set per-schedule timezone —
 * it's a power-user-only override edited directly in the DB.
 */
export function createSchedule(input: {
    kind: ScheduleKind;
    cron?: string;
    fireAt?: string;
    prompt: string;
    label?: string;
    timezone?: string;
}): ScheduleRow {
    const id = crypto.randomUUID();
    const ts = nowIso();
    db.run(
        `INSERT INTO schedules(id, kind, cron, fire_at, prompt, label, timezone, status, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [
            id,
            input.kind,
            input.cron ?? null,
            input.fireAt ?? null,
            input.prompt,
            input.label ?? null,
            input.timezone ?? null,
            ts,
        ],
    );
    const row: ScheduleRow = {
        id,
        kind: input.kind,
        cron: input.cron ?? null,
        fireAt: input.fireAt ?? null,
        prompt: input.prompt,
        label: input.label ?? null,
        timezone: input.timezone ?? null,
        status: "active",
        lastFiredAt: null,
        lastError: null,
        createdAt: ts,
    };
    startCron(row);
    return row;
}

export function deleteSchedule(id: string): boolean {
    stopCron(id);
    const info = db.run("DELETE FROM schedules WHERE id = ?", [id]);
    return info.changes > 0;
}
