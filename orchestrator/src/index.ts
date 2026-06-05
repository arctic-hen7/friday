// Friday orchestrator entry point.
//
// One Bun HTTP server exposes:
//   - REST control plane for session list/create/attach/detach
//   - WebSocket data plane for the IL <-> orchestrator conversation
//
// All routes are local-only (Docker network). No auth.

import "./db"; // initialises DB on import
import {
    createSession,
    dropLive,
    getSession,
    listSessions,
    liveSession,
    registerLiveSession,
    releaseReservation,
    reserveAttachment,
} from "./sessions";
import {
    abortCurrentTurn,
    handleUserMessage,
    onDeliverabilityChanged,
    onIlDisconnect,
    trySchedule,
} from "./turnLoop";
import { bootScheduler } from "./schedules";
import { getSetting } from "./db";
import type { ClientToServer, ServerToClient } from "./types";

const PORT = Number(process.env.ORCHESTRATOR_PORT ?? "6000");

// ---------- WS attach tokens ----------
// Short-lived tokens minted by POST /sessions/:id/attach. The IL must present
// the token on WS upgrade. Tokens are single-use and expire after 60 seconds.

type AttachToken = {
    token: string;
    sessionId: string;
    systemPromptFragment: string;
    expiresAt: number;
};
const attachTokens = new Map<string, AttachToken>();

function mintAttachToken(sessionId: string, fragment: string): string {
    const token = crypto.randomUUID();
    attachTokens.set(token, {
        token,
        sessionId,
        systemPromptFragment: fragment,
        expiresAt: Date.now() + 60_000,
    });
    return token;
}

function consumeAttachToken(token: string): AttachToken | null {
    const t = attachTokens.get(token);
    if (!t) return null;
    attachTokens.delete(token);
    if (t.expiresAt < Date.now()) return null;
    return t;
}

// ---------- REST ----------

function json(data: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(data), {
        ...init,
        headers: {
            "Content-Type": "application/json",
            ...(init.headers ?? {}),
        },
    });
}

async function readJson(req: Request): Promise<any> {
    try {
        return await req.json();
    } catch {
        return {};
    }
}

async function handleRest(req: Request, url: URL): Promise<Response | null> {
    const { pathname } = url;

    if (pathname === "/sessions" && req.method === "GET") {
        const rows = listSessions();
        return json(
            rows.map(r => ({
                id: r.id,
                label: r.label,
                createdAt: r.createdAt,
                lastActiveAt: r.lastActiveAt,
                attached: !!liveSession(r.id)?.attached,
            })),
        );
    }

    if (pathname === "/sessions" && req.method === "POST") {
        const body = await readJson(req);
        const label = String(body.label ?? "Untitled session");
        const row = createSession(label);
        return json(row, { status: 201 });
    }

    const attachMatch = pathname.match(/^\/sessions\/([^/]+)\/attach$/);
    if (attachMatch && req.method === "POST") {
        const id = attachMatch[1]!;
        const row = getSession(id);
        if (!row) return json({ error: "not_found" }, { status: 404 });
        registerLiveSession(row);
        if (!reserveAttachment(id)) {
            return json({ error: "busy" }, { status: 409 });
        }
        const body = await readJson(req);
        const fragment = String(body.systemPromptFragment ?? "");
        const token = mintAttachToken(id, fragment);
        return json({ wsToken: token });
    }

    const detachMatch = pathname.match(/^\/sessions\/([^/]+)\/detach$/);
    if (detachMatch && req.method === "POST") {
        const id = detachMatch[1]!;
        const live = liveSession(id);
        if (live?.attached) {
            try { live.attached.ws.close(1000, "detach"); } catch { /* ignore */ }
            onIlDisconnect(live);
            dropLive(id);
        }
        // Also release any standing reservation (mint-without-upgrade).
        releaseReservation(id);
        return json({ ok: true });
    }

    if (pathname === "/health") return json({ ok: true });

    return null;
}

// ---------- WS ----------

type WsData = {
    sessionId: string;
};

// Holds attach fragments between mintAttachToken and the WS open event.
// Declared before Bun.serve so the fetch handler can reference it safely.
const pendingFragments = new Map<string, string>();

const server = Bun.serve<WsData, never>({
    port: PORT,
    async fetch(req, srv) {
        const url = new URL(req.url);

        // WS upgrade — /ws?token=<attachToken>
        if (url.pathname === "/ws") {
            const token = url.searchParams.get("token");
            if (!token) return new Response("missing token", { status: 400 });
            const t = consumeAttachToken(token);
            if (!t) return new Response("invalid or expired token", { status: 401 });

            const row = getSession(t.sessionId);
            if (!row) {
                releaseReservation(t.sessionId);
                return new Response("session gone", { status: 404 });
            }
            const live = registerLiveSession(row);
            if (live.attached) {
                releaseReservation(t.sessionId);
                return new Response("busy", { status: 409 });
            }

            pendingFragments.set(t.sessionId, t.systemPromptFragment);
            const ok = srv.upgrade(req, {
                data: { sessionId: t.sessionId },
            });
            if (!ok) {
                pendingFragments.delete(t.sessionId);
                releaseReservation(t.sessionId);
                return new Response("upgrade failed", { status: 500 });
            }
            return undefined as unknown as Response;
        }

        const restRes = await handleRest(req, url);
        if (restRes) return restRes;

        return new Response("not found", { status: 404 });
    },
    websocket: {
        open(ws) {
            const sessionId = ws.data.sessionId;
            const row = getSession(sessionId);
            if (!row) {
                ws.close(1011, "session gone");
                return;
            }
            const live = registerLiveSession(row);
            const fragment = pendingFragments.get(sessionId) ?? "";
            pendingFragments.delete(sessionId);

            live.attached = {
                systemPromptFragment: fragment,
                ws,
                deliverability: { deliverable: true }, // ILs default to deliverable
                mode: "idle",
                currentTurn: null,
                pendingProactive: [],
                firstReplyOfAttachmentSent: false,
                inboxLeadInIds: [],
            };
            // Clear the pre-attach reservation now that the WS is live.
            releaseReservation(sessionId);

            const info: ServerToClient = {
                type: "session_info",
                sessionId: row.id,
                label: row.label,
                timezone: getSetting("timezone") ?? "Australia/Sydney",
            };
            ws.send(JSON.stringify(info));

            // On attach, if there are pending proactive items (none yet at
            // open time, but undelivered inbox), the first reply turn will
            // handle the lead-in. Nothing else to do here.
            console.log(`[ws] attached: ${sessionId}`);
        },

        message(ws, raw) {
            const sessionId = ws.data.sessionId;
            const live = liveSession(sessionId);
            if (!live?.attached) return;

            let msg: ClientToServer;
            try {
                msg = JSON.parse(String(raw));
            } catch {
                return;
            }

            switch (msg.type) {
                case "user_message":
                    void handleUserMessage(live, msg.text);
                    break;
                case "deliverability":
                    onDeliverabilityChanged(live, {
                        deliverable: msg.deliverable,
                        reason: msg.reason,
                    });
                    break;
                case "abort":
                    abortCurrentTurn(live, msg.reason ?? "il_abort");
                    // After an abort the IL may want to retry queued proactive
                    // (in case deliverability has returned).
                    trySchedule(live);
                    break;
            }
        },

        close(ws) {
            const sessionId = ws.data.sessionId;
            const live = liveSession(sessionId);
            if (!live) return;
            onIlDisconnect(live);
            dropLive(sessionId);
            console.log(`[ws] detached: ${sessionId}`);
        },
    },
});

bootScheduler();
console.log(`[orchestrator] listening on http://0.0.0.0:${server.port}`);
