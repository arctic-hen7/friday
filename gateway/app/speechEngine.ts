import type { Server as HttpServer } from "node:http";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import OpenAI from "openai";
import { optionalEnv, requiredEnv } from "./env";

const SPEECH_ENGINE_WS_PATH = "/api/speech-engine/ws";

let elevenlabs: ElevenLabsClient | undefined;
let openai: OpenAI | undefined;

function getElevenLabs() {
    elevenlabs ??= new ElevenLabsClient({
        apiKey: requiredEnv("ELEVENLABS_API_KEY"),
    });

    return elevenlabs;
}

function getOpenAI() {
    openai ??= new OpenAI({
        apiKey: requiredEnv("OPENAI_API_KEY"),
    });

    return openai;
}

export function getGatewayConfig() {
    return {
        speechEngineId: requiredEnv("ELEVENLABS_SPEECH_ENGINE_ID"),
        llmModel: optionalEnv("OPENAI_MODEL", "gpt-5.4-mini"),
        instructions: optionalEnv(
            "AGENT_INSTRUCTIONS",
            "You are a concise, helpful voice agent. Keep answers conversational and short unless the user asks for detail.",
        ),
        debugSpeechEngine: optionalEnv("SPEECH_ENGINE_DEBUG", "false") === "true",
    };
}

export function getApiHeaders() {
    const headers = new Headers({
        "Content-Type": "application/json",
    });

    return headers;
}

export function jsonResponse(payload: unknown, init?: ResponseInit) {
    const headers = getApiHeaders();

    for (const [key, value] of new Headers(init?.headers)) {
        headers.set(key, value);
    }

    return new Response(JSON.stringify(payload), {
        ...init,
        headers,
    });
}

export async function createConversationToken() {
    const { speechEngineId } = getGatewayConfig();

    return await getElevenLabs().conversationalAi.conversations.getWebrtcToken({
        agentId: speechEngineId,
    });
}

export function attachSpeechEngine(server: HttpServer) {
    const { debugSpeechEngine, instructions, llmModel, speechEngineId } = getGatewayConfig();

    getElevenLabs().speechEngine.attach(speechEngineId, server, SPEECH_ENGINE_WS_PATH, {
        debug: debugSpeechEngine,

        onInit(conversationId) {
            console.log(`Speech Engine session started: ${conversationId}`);
        },

        async onTranscript(transcript, signal, session) {
            const response = await getOpenAI().responses.create(
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

            await session.sendResponse(response);
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
}

export { SPEECH_ENGINE_WS_PATH };
