// Upgrade handler for the per-conversation proactive audio WebSocket.
//
// Path: /api/proactive/ws?conversationId=<eleven SE conversation id>
//
// The browser opens this once an Eleven SE conversation is connected. The IL
// matches the conversation id to a ProactivePlayer (registered by the Speech
// Engine handler when the orchestrator bridge for that SE session opens) and
// hands the WS to the player.

import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { lookupPlayer } from "./proactivePlayer";

export const PROACTIVE_WS_PATH = "/api/proactive/ws";

export function attachProactiveWs(server: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== PROACTIVE_WS_PATH) return; // not for us

        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) {
            socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            socket.destroy();
            return;
        }

        const player = lookupPlayer(conversationId);
        if (!player) {
            // The SE handler hasn't registered a player for this conversation
            // yet (the user hasn't spoken). Refuse — the client will retry.
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            player.attachClient(ws);
            console.log(`[proactive] client attached for conversation ${conversationId}`);
        });
    });
}
