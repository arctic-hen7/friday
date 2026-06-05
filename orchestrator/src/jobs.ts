import { spawn, type Subprocess } from "bun";
import { db, nowIso } from "./db";
import type { JobRow, JobStatus, ProactivePayload } from "./types";
import { onProactivePayload } from "./proactive";

const PRIMARY_CONTAINER = process.env.PRIMARY_CONTAINER ?? "friday-primary";
const PODMAN_BIN = process.env.PODMAN_BIN ?? "podman";

// Live process registry so kill_session_job can SIGKILL by job id.
const live = new Map<string, Subprocess>();

function insertJob(id: string, sessionId: string | null, instruction: string): void {
    db.run(
        `INSERT INTO jobs(id, session_id, instruction, status, started_at)
         VALUES(?, ?, ?, 'running', ?)`,
        [id, sessionId, instruction, nowIso()],
    );
}

function updateJob(
    id: string,
    status: JobStatus,
    result: string | null,
    error: string | null,
): void {
    db.run(
        `UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?`,
        [status, result, error, nowIso(), id],
    );
}

export function listSessionJobs(sessionId: string): JobRow[] {
    return db
        .query<JobRow, [string]>(
            `SELECT id, session_id AS sessionId, instruction, status, result, error,
                    started_at AS startedAt, finished_at AS finishedAt
             FROM jobs WHERE session_id = ? ORDER BY started_at DESC`,
        )
        .all(sessionId);
}

export function killJob(id: string): boolean {
    const proc = live.get(id);
    if (!proc) return false;
    proc.kill("SIGKILL");
    return true;
}

/**
 * Spawn a Primary job. Returns immediately after starting the subprocess.
 * Result delivery happens asynchronously via the proactive routing pipeline.
 *
 * `sessionId` may be null for scheduled prompts that have no owning session.
 */
export async function spawnJob(
    instruction: string,
    sessionId: string | null,
    options: { source?: "job" | "schedule" } = {},
): Promise<{ jobId: string }> {
    const jobId = crypto.randomUUID();
    const outFile = `/tmp/codex-out-${jobId}.txt`;
    const source = options.source ?? "job";

    insertJob(jobId, sessionId, instruction);

    // Kick off the subprocess but do NOT await it — we want immediate return.
    const proc = spawn({
        cmd: [PODMAN_BIN, "exec", PRIMARY_CONTAINER, "codex", "exec", "-o", outFile, instruction],
        stdout: "ignore",   // stderr/stdout from codex are noisy; we ignore them
        stderr: "pipe",
    });
    live.set(jobId, proc);

    // Detached completion handler.
    void (async () => {
        try {
            const exitCode = await proc.exited;
            live.delete(jobId);

            if (exitCode === 0) {
                // Read the result file out of the container.
                const cat = spawn({
                    cmd: [PODMAN_BIN, "exec", PRIMARY_CONTAINER, "cat", outFile],
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const text = (await new Response(cat.stdout).text()).trim();
                await cat.exited;

                // Best-effort cleanup; ignore errors.
                spawn({
                    cmd: [PODMAN_BIN, "exec", PRIMARY_CONTAINER, "rm", "-f", outFile],
                    stdout: "ignore",
                    stderr: "ignore",
                });

                updateJob(jobId, "finished", text, null);

                const payload: ProactivePayload = {
                    source,
                    text,
                    finishedAt: nowIso(),
                    originSessionId: sessionId,
                };
                onProactivePayload(payload);
            } else {
                // Capture stderr for diagnostic. Codex puts a lot to stderr;
                // we only want the tail for the failure message.
                const stderrText = await new Response(proc.stderr).text();
                const tail = stderrText.trim().split("\n").slice(-10).join("\n");

                // If the proc was killed by us, mark cancelled, no proactive.
                if (proc.signalCode === "SIGKILL" || proc.killed) {
                    updateJob(jobId, "cancelled", null, "killed");
                    return;
                }

                updateJob(jobId, "failed", null, tail || `exit code ${exitCode}`);

                // Surface failure as a proactive message so it doesn't get lost.
                const failureText =
                    `A background task failed.\n` +
                    `Instruction: ${instruction}\n` +
                    `Error: ${tail || `exit code ${exitCode}`}`;
                const failurePayload: ProactivePayload = {
                    source: "job_failure",
                    text: failureText,
                    finishedAt: nowIso(),
                    originSessionId: sessionId,
                };
                onProactivePayload(failurePayload);
            }
        } catch (err) {
            live.delete(jobId);
            const msg = err instanceof Error ? err.message : String(err);
            updateJob(jobId, "failed", null, msg);
            const failurePayload: ProactivePayload = {
                source: "job_failure",
                text: `Background task failed to start: ${msg}\nInstruction: ${instruction}`,
                finishedAt: nowIso(),
                originSessionId: sessionId,
            };
            onProactivePayload(failurePayload);
        }
    })();

    return { jobId };
}
