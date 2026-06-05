// Server-side proactive playback bridge.
//
// One ProactivePlayer per Eleven Speech Engine conversation. It receives
// `assistant_proactive` text chunks from the orchestrator, feeds them to an
// ElevenLabs TTS WebSocket, and forwards the resulting PCM audio frames to
// the client browser over a dedicated /api/proactive/ws connection.
//
// Lifecycle:
//   - Constructed when the SE conversation's orchestrator bridge opens.
//   - `attachClient(ws)` is called when the browser opens its proactive WS.
//   - `pushChunk({text, final})` is called by the orchestrator bridge for
//     each assistant_proactive message. The first non-empty chunk opens
//     the TTS WS; subsequent chunks stream text into it; `final:true`
//     closes the input side and lets remaining audio drain.
//   - `abort()` (triggered by the client's `abort_proactive` message or
//     the IL itself) immediately kills the TTS WS and tells the client
//     to drop any queued audio.
//   - `dispose()` is called when the SE conversation ends.
//
// We use PCM @ 22050 Hz mono so the client can decode each chunk into a
// Web Audio AudioBuffer without worrying about MP3 frame alignment.

import WebSocket from "ws";
import { requiredEnv, optionalEnv } from "./env";

const TTS_MODEL = optionalEnv("ELEVEN_TTS_MODEL", "eleven_turbo_v2_5");
const TTS_SAMPLE_RATE = 22050;
const TTS_OUTPUT_FORMAT = `pcm_${TTS_SAMPLE_RATE}`;

// Wire-level messages we exchange with the client browser over the
// per-conversation proactive WebSocket.
type ServerMessage =
    | { type: "start"; turnId: string; sampleRate: number }
    | { type: "end"; turnId: string }
    | { type: "aborted"; turnId: string };

export class ProactivePlayer {
    private client: WebSocket | null = null;
    private tts: WebSocket | null = null;
    private currentTurnId: string | null = null;
    private disposed = false;

    // Notifies the IL that the user has aborted (so it can fire `abort` +
    // `deliverability:false` to the orchestrator). Wired in by the caller.
    onClientAbort: (() => void) | null = null;

    constructor(private readonly conversationId: string) { }

    attachClient(ws: WebSocket): void {
        // Replace any prior client (e.g. browser reload during conversation).
        if (this.client && this.client.readyState === WebSocket.OPEN) {
            try { this.client.close(1000, "replaced"); } catch { /* ignore */ }
        }
        this.client = ws;

        ws.on("message", (raw) => {
            let msg: any;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg?.type === "abort_proactive") {
                console.log(`[proactive] client requested abort (conv=${this.conversationId})`);
                this.abort();
                this.onClientAbort?.();
            }
        });

        ws.on("close", () => {
            if (this.client === ws) this.client = null;
        });
    }

    /**
     * Push a text chunk from the orchestrator. The first non-empty chunk in a
     * turn opens the TTS WS; subsequent chunks within the same `turnId` are
     * appended; a chunk with `final:true` signals end-of-utterance.
     */
    pushChunk(turnId: string, text: string, final: boolean): void {
        if (this.disposed) return;

        // New turn — open TTS WS and tell the client to begin a new utterance.
        if (this.currentTurnId !== turnId) {
            this.currentTurnId = turnId;
            this.openTts(turnId);
        }

        if (text) this.sendTtsText(text);
        if (final) {
            // Empty string signals end-of-input to ElevenLabs; remaining audio
            // streams down before the TTS WS closes.
            this.sendTtsText("");
        }
    }

    /**
     * Immediately stop synthesis and tell the client to drop queued audio.
     * Idempotent and safe to call from anywhere.
     */
    abort(): void {
        const turnId = this.currentTurnId;
        if (this.tts) {
            try { this.tts.close(1000, "aborted"); } catch { /* ignore */ }
            this.tts = null;
        }
        this.currentTurnId = null;
        if (turnId) this.sendClient({ type: "aborted", turnId });
    }

    dispose(): void {
        this.disposed = true;
        this.abort();
        if (this.client && this.client.readyState === WebSocket.OPEN) {
            try { this.client.close(1000, "dispose"); } catch { /* ignore */ }
        }
        this.client = null;
    }

    // ---------- internals ----------

    private sendClient(msg: ServerMessage): void {
        if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
        try { this.client.send(JSON.stringify(msg)); } catch (err) {
            console.warn(`[proactive] send to client failed: ${err}`);
        }
    }

    private sendClientBinary(buf: Buffer): void {
        if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
        try { this.client.send(buf); } catch (err) {
            console.warn(`[proactive] send audio to client failed: ${err}`);
        }
    }

    private openTts(turnId: string): void {
        const apiKey = requiredEnv("ELEVENLABS_API_KEY");
        const voiceId = optionalEnv("ELEVENLABS_VOICE_ID");
        if (!voiceId) {
            console.error("[proactive] ELEVENLABS_VOICE_ID not set; cannot synthesise");
            return;
        }

        const url =
            `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input` +
            `?model_id=${encodeURIComponent(TTS_MODEL)}` +
            `&output_format=${encodeURIComponent(TTS_OUTPUT_FORMAT)}`;

        const ws = new WebSocket(url, { headers: { "xi-api-key": apiKey } });
        this.tts = ws;

        ws.on("open", () => {
            // BOS — voice settings + a leading blank to prime the stream.
            // ElevenLabs requires the first message to set voice config.
            try {
                ws.send(JSON.stringify({
                    text: " ",
                    voice_settings: { stability: 0.5, similarity_boost: 0.8 },
                    generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
                    xi_api_key: apiKey,
                }));
            } catch (err) {
                console.warn(`[proactive] tts BOS failed: ${err}`);
            }
            this.sendClient({ type: "start", turnId, sampleRate: TTS_SAMPLE_RATE });
        });

        ws.on("message", (raw) => {
            let msg: any;
            try { msg = JSON.parse(raw.toString()); } catch { return; }

            if (msg.audio) {
                // Base64 PCM. Decode and forward as binary to the client.
                const audio = Buffer.from(msg.audio, "base64");
                this.sendClientBinary(audio);
            }
            if (msg.isFinal) {
                this.sendClient({ type: "end", turnId });
                if (this.tts === ws) this.tts = null;
                if (this.currentTurnId === turnId) this.currentTurnId = null;
                try { ws.close(1000, "drained"); } catch { /* ignore */ }
            }
        });

        ws.on("error", (err) => {
            console.error(`[proactive] tts ws error: ${err.message}`);
        });

        ws.on("close", () => {
            if (this.tts === ws) this.tts = null;
        });
    }

    private sendTtsText(text: string): void {
        const ws = this.tts;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
            // try_trigger_generation gives lower latency; ElevenLabs tries to
            // start synthesising as soon as it has enough text.
            ws.send(JSON.stringify({ text, try_trigger_generation: true }));
        } catch (err) {
            console.warn(`[proactive] tts text send failed: ${err}`);
        }
    }
}

// ---------- conversation registry ----------
//
// Conversations are keyed by Eleven SE conversation id so the WS upgrade
// handler can hand a freshly-attached client to the right player.

const players = new Map<string, ProactivePlayer>();

export function registerPlayer(conversationId: string, player: ProactivePlayer): void {
    players.set(conversationId, player);
}

export function unregisterPlayer(conversationId: string): void {
    const p = players.get(conversationId);
    if (p) p.dispose();
    players.delete(conversationId);
}

export function lookupPlayer(conversationId: string): ProactivePlayer | undefined {
    return players.get(conversationId);
}
