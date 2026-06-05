import type { Route } from "./+types/end-session";
import { getApiHeaders, jsonResponse } from "~/http";
import { getActiveSessionId, setActiveSessionId } from "~/activeSession";
import { deleteSession } from "~/orchestrator";

// POST /api/end-session
// Body: { delete: boolean, sessionId?: string }
//
// Always clears the gateway's active-session singleton. If `delete: true`,
// also tells the orchestrator to remove the session entirely (the orchestrator
// will force-detach any live WS first). Callable via fetch or
// navigator.sendBeacon — the latter is how the page-unload path deletes the
// session when the user closes the tab.

export async function action({ request }: Route.ActionArgs) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: getApiHeaders() });
    }
    if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, { status: 405 });
    }

    let body: { delete?: unknown; sessionId?: unknown } = {};
    try { body = await request.json(); } catch { /* empty */ }

    const shouldDelete = body.delete === true;
    // Prefer the caller's session id (covers the unload-beacon case, where the
    // singleton may have been cleared by an interleaving request). Fall back
    // to the singleton otherwise.
    const sessionId =
        (typeof body.sessionId === "string" && body.sessionId) || getActiveSessionId();

    setActiveSessionId(null);

    if (shouldDelete && sessionId) {
        try {
            await deleteSession(sessionId);
        } catch (err) {
            console.error("[end-session] orchestrator delete failed:", err);
            return jsonResponse({ ok: false, error: String(err) }, { status: 502 });
        }
    }

    return jsonResponse({ ok: true });
}

export function loader() {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
}
