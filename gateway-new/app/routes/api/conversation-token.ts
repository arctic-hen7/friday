import type { Route } from "./+types/conversation-token";
import { createConversationToken, getApiHeaders, jsonResponse } from "~/speechEngine";

export async function action({ request }: Route.ActionArgs) {
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: getApiHeaders(),
        });
    }

    if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, { status: 405 });
    }

    try {
        return jsonResponse(await createConversationToken());
    } catch (error) {
        console.error("Failed to create ElevenLabs WebRTC token:", error);

        return jsonResponse(
            {
                error: "Failed to create ElevenLabs WebRTC token",
            },
            { status: 500 },
        );
    }
}

export function loader() {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
}
