import type { Route } from "./+types/mute";
import { getApiHeaders, jsonResponse } from "~/speechEngine";
import { setConversationMuted } from "~/muteRegistry";

export async function action({ request }: Route.ActionArgs) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: getApiHeaders() });
    }

    if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, { status: 405 });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
    }

    const conversationId = (body as { conversationId?: unknown })?.conversationId;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
        return jsonResponse({ error: "conversationId is required" }, { status: 400 });
    }

    setConversationMuted(conversationId, true);
    return jsonResponse({ ok: true });
}

export function loader() {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
}
