// HTTP + WebSocket client for the orchestrator. The Eleven IL maintains at
// most one active orchestrator WS at a time, since a single Eleven Speech
// Engine WS handles one conversation.

import { optionalEnv } from "./env";

let logged = false;

export function orchestratorBaseUrl(): string {
    // Smart default: in production we're inside compose, so reach the
    // orchestrator container by its service hostname. Locally we always
    // want localhost.
    const fallback =
        process.env.NODE_ENV === "production"
            ? "http://orchestrator:6000"
            : "http://localhost:6000";
    const url = optionalEnv("ORCHESTRATOR_URL", fallback).replace(/\/$/, "");
    if (!logged) {
        console.log(`[eleven] orchestrator URL: ${url}`);
        logged = true;
    }
    return url;
}

function wsBase(): string {
    return orchestratorBaseUrl().replace(/^http/, "ws");
}

export type SessionSummary = {
    id: string;
    label: string;
    createdAt: string;
    lastActiveAt: string;
    attached: boolean;
};

export async function listSessions(): Promise<SessionSummary[]> {
    const res = await fetch(`${orchestratorBaseUrl()}/sessions`);
    if (!res.ok) throw new Error(`orchestrator /sessions returned ${res.status}`);
    return await res.json();
}

export async function createSession(label: string): Promise<SessionSummary> {
    const res = await fetch(`${orchestratorBaseUrl()}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
    });
    if (!res.ok) throw new Error(`orchestrator create session returned ${res.status}`);
    return { ...(await res.json()), attached: false };
}

export async function attachSession(
    sessionId: string,
    systemPromptFragment: string,
): Promise<string> {
    const res = await fetch(
        `${orchestratorBaseUrl()}/sessions/${encodeURIComponent(sessionId)}/attach`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ systemPromptFragment }),
        },
    );
    if (res.status === 409) throw new Error("session_busy");
    if (res.status === 404) throw new Error("session_not_found");
    if (!res.ok) throw new Error(`orchestrator attach returned ${res.status}`);
    const data = (await res.json()) as { wsToken: string };
    return data.wsToken;
}

export function orchestratorWsUrl(token: string): string {
    return `${wsBase()}/ws?token=${encodeURIComponent(token)}`;
}
