import type { Route } from "./+types/sessions";
import { getApiHeaders, jsonResponse } from "~/http";
import { createSession, listSessions } from "~/orchestrator";

export async function loader() {
    try {
        return jsonResponse(await listSessions());
    } catch (err) {
        return jsonResponse({ error: String(err) }, { status: 502 });
    }
}

export async function action({ request }: Route.ActionArgs) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: getApiHeaders() });
    }
    if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, { status: 405 });
    }
    let body: { label?: string } = {};
    try { body = await request.json(); } catch { /* empty */ }
    try {
        const row = await createSession(body.label ?? "Untitled");
        return jsonResponse(row, { status: 201 });
    } catch (err) {
        return jsonResponse({ error: String(err) }, { status: 502 });
    }
}
