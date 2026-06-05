// Tool catalogue exposed to the Lite Gateway Agent (Gemini Flash Lite).
//
// All tools resolve synchronously / immediately. `spawn_job` returns
// `{status:"started"}` only — no job id surfaced to the agent.

import { Type, type FunctionDeclaration } from "@google/genai";
import { setSetting, getSetting } from "./db";
import { spawnJob, listSessionJobs, killJob } from "./jobs";
import { createSchedule, listSchedules, deleteSchedule } from "./schedules";

export const liteToolDeclarations: FunctionDeclaration[] = [
    {
        name: "spawn_job",
        description:
            "Delegate a piece of substantive work to a more capable model. " +
            "Returns immediately while the work happens in the background. " +
            "You will receive the result later as a <note>...</note> in the " +
            "conversation history. Use this for web lookups, research, " +
            "summarisation, drafting, calculation — anything beyond simple " +
            "conversation. Acknowledge to the user that you're on it after calling.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                instruction: {
                    type: Type.STRING,
                    description:
                        "Natural-language instruction for the background model. " +
                        "Be specific. Include enough context that the instruction " +
                        "stands alone — the background model has no access to the " +
                        "conversation.",
                },
            },
            required: ["instruction"],
        },
    },
    {
        name: "list_session_jobs",
        description: "List all background jobs spawned in the current session, with status and results.",
        parameters: { type: Type.OBJECT, properties: {} },
    },
    {
        name: "kill_session_job",
        description:
            "Cancel a running background job by id. Use ONLY when the user explicitly " +
            "asks to cancel or stop a task.",
        parameters: {
            type: Type.OBJECT,
            properties: { id: { type: Type.STRING } },
            required: ["id"],
        },
    },
    {
        name: "schedule_create",
        description:
            "Create a recurring or one-shot schedule. The prompt fires against the " +
            "background model. Use ONLY when the user explicitly asks to schedule " +
            "something. For recurring schedules, `cron` must be a 5-field cron " +
            "expression (minute hour day-of-month month day-of-week). Example: " +
            "`0 8 * * *` for 8am daily. For one-shot schedules, supply `fire_at` " +
            "as an ISO 8601 timestamp.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                kind: { type: Type.STRING, enum: ["once", "recurring"] },
                cron: { type: Type.STRING, description: "5-field cron expression (recurring only)" },
                fire_at: { type: Type.STRING, description: "ISO 8601 timestamp (once only)" },
                prompt: { type: Type.STRING, description: "Instruction to fire against the background model" },
                label: { type: Type.STRING, description: "Optional human-readable label" },
            },
            required: ["kind", "prompt"],
        },
    },
    {
        name: "schedule_list",
        description: "List all active schedules.",
        parameters: { type: Type.OBJECT, properties: {} },
    },
    {
        name: "schedule_delete",
        description: "Delete a schedule by id. Use ONLY when the user explicitly asks to remove a schedule.",
        parameters: {
            type: Type.OBJECT,
            properties: { id: { type: Type.STRING } },
            required: ["id"],
        },
    },
    {
        name: "set_timezone",
        description:
            "Set the global timezone (IANA name, e.g. 'Australia/Sydney', 'Europe/London'). " +
            "Affects current-time display and the default for all schedules that " +
            "don't specify their own timezone.",
        parameters: {
            type: Type.OBJECT,
            properties: { timezone: { type: Type.STRING } },
            required: ["timezone"],
        },
    },
    {
        name: "get_timezone",
        description: "Get the current global timezone.",
        parameters: { type: Type.OBJECT, properties: {} },
    },
];

export type ToolCallContext = { sessionId: string };
export type ToolResult = Record<string, unknown>;

export async function dispatchTool(
    ctx: ToolCallContext,
    name: string,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    switch (name) {
        case "spawn_job": {
            const instruction = String(args.instruction ?? "");
            if (!instruction) return { error: "instruction is required" };
            await spawnJob(instruction, ctx.sessionId);
            return { status: "started" };
        }
        case "list_session_jobs": {
            const rows = listSessionJobs(ctx.sessionId);
            return {
                jobs: rows.map(r => ({
                    id: r.id,
                    instruction: r.instruction,
                    status: r.status,
                    result: r.result,
                    error: r.error,
                    startedAt: r.startedAt,
                    finishedAt: r.finishedAt,
                })),
            };
        }
        case "kill_session_job": {
            const id = String(args.id ?? "");
            const ok = killJob(id);
            return { ok };
        }
        case "schedule_create": {
            const kind = String(args.kind ?? "") as "once" | "recurring";
            const cron = args.cron ? String(args.cron) : undefined;
            const fireAt = args.fire_at ? String(args.fire_at) : undefined;
            const prompt = String(args.prompt ?? "");
            const label = args.label ? String(args.label) : undefined;
            if (kind === "recurring" && !cron) return { error: "cron is required for recurring schedules" };
            if (kind === "once" && !fireAt) return { error: "fire_at is required for once schedules" };
            if (!prompt) return { error: "prompt is required" };
            const row = createSchedule({ kind, cron, fireAt, prompt, label });
            return { id: row.id };
        }
        case "schedule_list": {
            const rows = listSchedules();
            return {
                schedules: rows.map(r => ({
                    id: r.id,
                    kind: r.kind,
                    cron: r.cron,
                    fireAt: r.fireAt,
                    prompt: r.prompt,
                    label: r.label,
                    timezone: r.timezone,
                    status: r.status,
                    lastFiredAt: r.lastFiredAt,
                    lastError: r.lastError,
                })),
            };
        }
        case "schedule_delete": {
            const id = String(args.id ?? "");
            const ok = deleteSchedule(id);
            return { ok };
        }
        case "set_timezone": {
            const tz = String(args.timezone ?? "");
            if (!tz) return { error: "timezone is required" };
            setSetting("timezone", tz);
            return { ok: true, timezone: tz };
        }
        case "get_timezone": {
            return { timezone: getSetting("timezone") };
        }
        default:
            return { error: `unknown tool: ${name}` };
    }
}
