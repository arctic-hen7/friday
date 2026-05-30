import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import OpenAI from "openai";
import { loadRootEnv, optionalEnv, requiredEnv } from "./env";

loadRootEnv();

const port = Number(optionalEnv("GATEWAY_PORT", "5000"));
const speechEngineId = requiredEnv("ELEVENLABS_SPEECH_ENGINE_ID");
const allowedOrigin = optionalEnv("CLIENT_ORIGIN", "*");
const llmModel = optionalEnv("OPENAI_MODEL", "gpt-5.4-mini");
const instructions = optionalEnv(
    "AGENT_INSTRUCTIONS",
    "You are a concise, helpful voice agent. Keep answers conversational and short unless the user asks for detail.",
);

const elevenlabs = new ElevenLabsClient({
    apiKey: requiredEnv("ELEVENLABS_API_KEY"),
});

const openai = new OpenAI({
    apiKey: requiredEnv("OPENAI_API_KEY"),
});

function setCorsHeaders(res: ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
    setCorsHeaders(res);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, payload: string) {
    setCorsHeaders(res);
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(payload);
}

function getPath(req: IncomingMessage) {
    return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "OPTIONS") {
        setCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
    }

    const path = getPath(req);

    if (req.method === "GET" && path === "/api/status") {
        sendJson(res, 200, {
            ok: true,
            speechEngineId,
            model: llmModel,
        });
        return;
    }

    if (req.method === "POST" && path === "/api/conversation-token") {
        try {
            const token = await elevenlabs.conversationalAi.conversations.getWebrtcToken({
                agentId: speechEngineId,
            });

            sendJson(res, 200, token);
        } catch (error) {
            console.error("Failed to create ElevenLabs WebRTC token:", error);
            sendJson(res, 500, {
                error: "Failed to create ElevenLabs WebRTC token",
            });
        }

        return;
    }

    sendText(res, 404, "Not Found");
}

const server = createServer((req, res) => {
    handleRequest(req, res).catch(error => {
        console.error("Unhandled gateway error:", error);
        sendJson(res, 500, { error: "Internal server error" });
    });
});

elevenlabs.speechEngine.attach(speechEngineId, server, "/api/speech-engine/ws", {
    debug: optionalEnv("SPEECH_ENGINE_DEBUG", "false") === "true",

    onInit(conversationId) {
        console.log(`Speech Engine session started: ${conversationId}`);
    },

    async onTranscript(transcript, signal, session) {
        const response = await openai.responses.create(
            {
                model: llmModel,
                instructions,
                input: transcript.map(message => ({
                    role: message.role === "agent" ? "assistant" : "user",
                    content: message.content,
                })),
                stream: true,
            },
            { signal },
        );

        session.sendResponse(response);
    },

    onClose(session) {
        console.log(`Speech Engine session ended: ${session.conversationId}`);
    },

    onDisconnect(session) {
        console.log(`Speech Engine session disconnected: ${session.conversationId}`);
    },

    onError(error) {
        console.error("Speech Engine error:", error);
    },
});

server.listen(port, () => {
    console.log(`Gateway listening on http://localhost:${port}`);
    console.log(`Speech Engine WebSocket path: /api/speech-engine/ws`);
});
