import type { Route } from "./+types/select-session";
import { jsonResponse, getApiHeaders } from "~/speechEngine";
import { setActiveSessionId, getActiveSessionId } from "~/activeSession";

export async function loader() {
    return jsonResponse({ sessionId: getActiveSessionId() });
}

export async function action({ request }: Route.ActionArgs) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: getApiHeaders() });
    }
    if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, { status: 405 });
    }
    let body: { sessionId?: string | null } = {};
    try { body = await request.json(); } catch { /* empty */ }
    setActiveSessionId(body.sessionId ?? null);
    return jsonResponse({ ok: true, sessionId: body.sessionId ?? null });
}
