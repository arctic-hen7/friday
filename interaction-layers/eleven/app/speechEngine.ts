// Eleven IL — bridges ElevenLabs Speech Engine sessions to the orchestrator.
//
// Flow per Eleven conversation:
//   1. onInit:        log session start (we attach to the orchestrator lazily
//                     on the first user transcript so empty connections don't
//                     hold a session slot).
//   2. onTranscript:  open the orchestrator bridge if needed; forward the
//                     latest user turn; build an async iterable that yields
//                     `assistant_chunk` text until `final:true`, hand to
//                     `session.sendResponse`. Also register a ProactivePlayer
//                     for this conversation so subsequent assistant_proactive
//                     messages can stream audio back to the browser.
//   3. on user speech interrupt (Eleven's `signal`): send `abort` to
//                     orchestrator.
//   4. onClose:       close the orchestrator WS (triggers detach on the other
//                     side) and dispose the ProactivePlayer.
//
// Proactive messages: routed to a per-conversation ProactivePlayer which
// drives a side-channel ElevenLabs TTS WebSocket and streams audio to the
// browser via /api/proactive/ws.

import type { Server as HttpServer } from "node:http";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { optionalEnv, requiredEnv } from "./env";
import { isConversationMuted, setConversationMuted } from "./muteRegistry";
import { attachSession, orchestratorWsUrl } from "./orchestrator";
import { getActiveSessionId } from "./activeSession";
import { ProactivePlayer, registerPlayer, unregisterPlayer } from "./proactivePlayer";

export const SPEECH_ENGINE_WS_PATH = "/api/speech-engine/ws";

const ELEVEN_SYSTEM_PROMPT_FRAGMENT = `You are speaking to the user via voice (ElevenLabs TTS).
- Keep responses brief and conversational. One or two sentences is usually enough.
- Do not produce Markdown, lists, tables, code blocks, or links — they cannot be spoken.
- Spell out numbers, abbreviations, and symbols when that helps spoken delivery.
- Never reference visual elements ("click", "see above", etc.).
- When summarising a <note> result, paraphrase rather than reading raw fields verbatim.`;

let elevenlabs: ElevenLabsClient | undefined;

function getElevenLabs(): ElevenLabsClient {
    elevenlabs ??= new ElevenLabsClient({ apiKey: requiredEnv("ELEVENLABS_API_KEY") });
    return elevenlabs;
}

export function getGatewayConfig() {
    return {
        speechEngineId: requiredEnv("ELEVENLABS_SPEECH_ENGINE_ID"),
        debugSpeechEngine: optionalEnv("SPEECH_ENGINE_DEBUG", "false") === "true",
    };
}

export function getApiHeaders(): Headers {
    return new Headers({ "Content-Type": "application/json" });
}

export function jsonResponse(payload: unknown, init?: ResponseInit): Response {
    const headers = getApiHeaders();
    for (const [k, v] of new Headers(init?.headers)) headers.set(k, v);
    return new Response(JSON.stringify(payload), { ...init, headers });
}

export async function createConversationToken() {
    const { speechEngineId } = getGatewayConfig();
    return await getElevenLabs().conversationalAi.conversations.getWebrtcToken({
        agentId: speechEngineId,
    });
}

// ---------- Per-Eleven-conversation orchestrator bridge ----------

type Bridge = {
    ws: WebSocket;
    sessionId: string;
    activeTurn: TurnQueue | null;
    player: ProactivePlayer;          // streams proactive TTS for this conv
    ready: Promise<void>;
};

type TurnQueue = {
    push(text: string): void;
    finish(): void;
    fail(err: Error): void;
    iterator: AsyncIterableIterator<string>;
};

function makeTurnQueue(): TurnQueue {
    const queue: string[] = [];
    let done = false;
    let err: Error | null = null;
    let pending: (() => void) | null = null;

    function wake() {
        const p = pending;
        pending = null;
        p?.();
    }

    const iterator: AsyncIterableIterator<string> = {
        [Symbol.asyncIterator]() { return this; },
        async next(): Promise<IteratorResult<string>> {
            while (queue.length === 0 && !done && !err) {
                await new Promise<void>(r => { pending = r; });
            }
            if (queue.length > 0) return { value: queue.shift()!, done: false };
            if (err) throw err;
            return { value: undefined, done: true };
        },
    };

    return {
        push(text) { queue.push(text); wake(); },
        finish() { done = true; wake(); },
        fail(e) { err = e; wake(); },
        iterator,
    };
}

async function openBridge(sessionId: string, conversationId: string): Promise<Bridge> {
    const token = await attachSession(sessionId, ELEVEN_SYSTEM_PROMPT_FRAGMENT);
    const ws = new WebSocket(orchestratorWsUrl(token));
    const player = new ProactivePlayer(conversationId);
    registerPlayer(conversationId, player);

    const bridge: Bridge = {
        ws,
        sessionId,
        activeTurn: null,
        player,
        ready: new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", (e) => reject(new Error(`orchestrator ws error: ${String(e)}`)), { once: true });
        }),
    };

    // When the client tells us the user has spoken during proactive playback,
    // mirror that as a real abort to the orchestrator + flip deliverability.
    player.onClientAbort = () => {
        sendBridge(bridge, { type: "abort", turnId: "current", reason: "proactive_user_interrupt" });
        sendBridge(bridge, { type: "deliverability", deliverable: false, reason: "user_speaking" });
    };

    ws.addEventListener("message", (ev) => {
        let msg: any;
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); }
        catch { return; }

        if (msg.type === "assistant_chunk") {
            if (bridge.activeTurn) {
                if (msg.text) bridge.activeTurn.push(msg.text);
                if (msg.final) {
                    bridge.activeTurn.finish();
                    bridge.activeTurn = null;
                }
            }
            return;
        }
        if (msg.type === "assistant_proactive") {
            const preview = (msg.text ?? "").slice(0, 80).replace(/\s+/g, " ");
            console.log(
                `[eleven] proactive chunk (turn=${msg.turnId} final=${msg.final} len=${(msg.text ?? "").length})` +
                (preview ? ` "${preview}${preview.length >= 80 ? "…" : ""}"` : ""),
            );
            bridge.player.pushChunk(msg.turnId, msg.text ?? "", !!msg.final);
            return;
        }
        if (msg.type === "session_info") {
            console.log(`[eleven] attached to orchestrator session ${msg.sessionId} (${msg.label})`);
            return;
        }
        if (msg.type === "error") {
            console.error(`[eleven] orchestrator reported error: ${msg.message}`);
            bridge.activeTurn?.fail(new Error(msg.message));
            return;
        }
    });

    ws.addEventListener("close", () => {
        bridge.activeTurn?.fail(new Error("orchestrator ws closed"));
        bridge.activeTurn = null;
    });

    return bridge;
}

function sendBridge(bridge: Bridge, msg: unknown): void {
    if (bridge.ws.readyState === WebSocket.OPEN) {
        bridge.ws.send(JSON.stringify(msg));
    }
}

// ---------- Speech Engine attachment ----------

export function attachSpeechEngine(server: HttpServer): void {
    const { debugSpeechEngine, speechEngineId } = getGatewayConfig();

    // The Eleven SDK gives a `session` object per Speech Engine WS connection.
    // We key per-conversation orchestrator bridges off the session reference.
    const bridges = new WeakMap<object, Bridge>();

    getElevenLabs().speechEngine.attach(speechEngineId, server, SPEECH_ENGINE_WS_PATH, {
        debug: debugSpeechEngine,

        async onInit(conversationId) {
            console.log(`[eleven] speech-engine session started: ${conversationId}`);
        },

        async onTranscript(transcript, signal, session) {
            // Phantom "..." turns from a muted-but-streaming mic — short-circuit.
            if (session.conversationId && isConversationMuted(session.conversationId)) {
                await session.sendResponse("");
                return;
            }

            const sessionId = getActiveSessionId();
            if (!sessionId) {
                await session.sendResponse(
                    "No session is selected. Please pick or create one in the Friday interface and try again.",
                );
                return;
            }

            const conversationId = session.conversationId;
            if (!conversationId) {
                console.warn("[eleven] onTranscript without conversationId; cannot register proactive player");
                await session.sendResponse("");
                return;
            }

            // Lazy bridge open so empty Eleven connections don't hold a slot.
            let bridge = bridges.get(session as unknown as object);
            if (!bridge) {
                try {
                    bridge = await openBridge(sessionId, conversationId);
                    await bridge.ready;
                    bridges.set(session as unknown as object, bridge);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (msg === "session_busy") {
                        await session.sendResponse(
                            "That session is already in use by another connection. Pick a different one.",
                        );
                    } else {
                        console.error("[eleven] failed to open orchestrator bridge:", err);
                        await session.sendResponse("I couldn't reach the orchestrator. Please try again in a moment.");
                    }
                    return;
                }
            }

            const lastUser = [...transcript].reverse().find(m => m.role !== "agent");
            if (!lastUser) {
                await session.sendResponse("");
                return;
            }

            // Any in-flight proactive must be killed when a new user transcript
            // lands — the user has just spoken, so deliverability is false until
            // the reply turn completes.
            bridge.player.abort();
            sendBridge(bridge, { type: "deliverability", deliverable: false, reason: "user_turn" });

            const turn = makeTurnQueue();
            bridge.activeTurn = turn;

            const bridgeRef = bridge;
            const onAbort = () => {
                if (bridgeRef.activeTurn === turn) {
                    sendBridge(bridgeRef, {
                        type: "abort",
                        turnId: "current",
                        reason: "eleven_signal",
                    });
                }
            };
            signal.addEventListener("abort", onAbort, { once: true });

            sendBridge(bridge, { type: "user_message", text: lastUser.content });

            try {
                await session.sendResponse(turn.iterator);
            } finally {
                signal.removeEventListener("abort", onAbort);
                if (bridge.activeTurn === turn) bridge.activeTurn = null;
                // Reply finished (or was aborted) — deliverable again.
                sendBridge(bridge, { type: "deliverability", deliverable: true });
            }
        },

        onClose(session) {
            if (session.conversationId) setConversationMuted(session.conversationId, false);
            const b = bridges.get(session as unknown as object);
            if (b) {
                try { b.ws.close(1000, "eleven_close"); } catch { /* ignore */ }
                bridges.delete(session as unknown as object);
            }
            if (session.conversationId) unregisterPlayer(session.conversationId);
            console.log(`[eleven] speech-engine session ended: ${session.conversationId}`);
        },

        onDisconnect(session) {
            if (session.conversationId) setConversationMuted(session.conversationId, false);
            const b = bridges.get(session as unknown as object);
            if (b) {
                try { b.ws.close(1006, "eleven_disconnect"); } catch { /* ignore */ }
                bridges.delete(session as unknown as object);
            }
            if (session.conversationId) unregisterPlayer(session.conversationId);
            console.log(`[eleven] speech-engine session disconnected: ${session.conversationId}`);
        },

        onError(error) {
            console.error("[eleven] speech-engine error:", error);
        },
    });
}
