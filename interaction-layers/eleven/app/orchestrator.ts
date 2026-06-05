// HTTP + WebSocket client for the orchestrator. The Eleven IL maintains at
// most one active orchestrator WS at a time, since a single Eleven Speech
// Engine WS handles one conversation.

import { optionalEnv } from "./env";

export function orchestratorBaseUrl(): string {
    return optionalEnv("ORCHESTRATOR_URL", "http://orchestrator:6000").replace(/\/$/, "");
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
