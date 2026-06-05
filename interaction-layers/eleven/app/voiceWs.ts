// Push-to-talk voice gateway.
//
// One WS per browser tab. While the user holds the orb, the browser streams
// 16-bit PCM frames (16 kHz mono LE) over this socket; on release we run the
// buffered audio through ElevenLabs STT and forward the transcript to the
// orchestrator. Assistant text — both reply and proactive — is streamed into
// an ElevenLabs TTS stream-input WS and the resulting PCM (22.05 kHz) is
// forwarded back to the client as binary frames.
//
// No persistent Speech Engine. No VAD. The press state of the orb is the only
// input gating signal: if the orb isn't held, the user isn't talking.
//
// Client → Server (text JSON):
//   { type: "start_recording" }
//   { type: "stop_recording" }
//   { type: "end" }
// Client → Server (binary): raw PCM s16le 16 kHz mono.
//
// Server → Client (text JSON):
//   { type: "ready" }
//   { type: "transcript_user", id, text }
//   { type: "transcript_agent", turnId, text, final }   // text is the delta
//   { type: "tts_start", turnId, sampleRate }
//   { type: "tts_end", turnId }
//   { type: "tts_abort", turnId }
//   { type: "error", message }
// Server → Client (binary): raw PCM s16le 22.05 kHz mono.

import type { Server as HttpServer } from "node:http";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { SpeechToTextConvertRequestModelId } from "@elevenlabs/elevenlabs-js/api";
import { WebSocket, WebSocketServer } from "ws";
import { getActiveSessionId } from "./activeSession";
import { optionalEnv, requiredEnv } from "./env";
import { attachSession, orchestratorWsUrl } from "./orchestrator";

export const VOICE_WS_PATH = "/api/voice/ws";

const ELEVEN_SYSTEM_PROMPT_FRAGMENT = `You are speaking to the user via voice (ElevenLabs TTS).
- Keep responses brief and conversational. One or two sentences is usually enough.
- Do not produce Markdown, lists, tables, code blocks, or links — they cannot be spoken.
- Spell out numbers, abbreviations, and symbols when that helps spoken delivery.
- Never reference visual elements ("click", "see above", etc.).
- When summarising a <note> result, paraphrase rather than reading raw fields verbatim.`;

const STT_MODEL = optionalEnv("ELEVEN_STT_MODEL", "scribe_v2") as SpeechToTextConvertRequestModelId;
const TTS_MODEL = optionalEnv("ELEVEN_TTS_MODEL", "eleven_turbo_v2_5");
const TTS_SAMPLE_RATE = 22050;
const TTS_OUTPUT_FORMAT = `pcm_${TTS_SAMPLE_RATE}`;

function getTtsVoiceSettings(): Record<string, unknown> {
    const settings: Record<string, unknown> = { stability: 0.5, similarity_boost: 0.8 };
    const rawSpeed = optionalEnv("ELEVENLABS_VOICE_SPEED");
    if (rawSpeed) {
        const speed = Number.parseFloat(rawSpeed);
        if (Number.isFinite(speed)) settings.speed = speed;
    }
    return settings;
}

let elevenlabs: ElevenLabsClient | undefined;
function getElevenLabs(): ElevenLabsClient {
    elevenlabs ??= new ElevenLabsClient({ apiKey: requiredEnv("ELEVENLABS_API_KEY") });
    return elevenlabs;
}

type Session = {
    client: WebSocket;
    orchestrator: WebSocket | null;
    sessionId: string;
    recording: { chunks: Buffer[]; totalBytes: number } | null;
    tts: TtsTurn | null;
    closed: boolean;
};

type TtsTurn = {
    turnId: string;
    ws: WebSocket;
    opened: boolean;
    finalized: boolean;          // caller has signalled end-of-input
    finished: boolean;           // TTS has reported isFinal
    pendingText: string[];       // text queued before the WS opens
};

export function attachVoiceWs(server: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== VOICE_WS_PATH) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
            void handleConnection(ws);
        });
    });
}

async function handleConnection(client: WebSocket): Promise<void> {
    const sessionId = getActiveSessionId();
    if (!sessionId) {
        sendJson(client, { type: "error", message: "No session selected. Pick one and reconnect." });
        client.close(1008, "no_session");
        return;
    }

    const session: Session = {
        client,
        orchestrator: null,
        sessionId,
        recording: null,
        tts: null,
        closed: false,
    };

    // Wire client handlers before any async work so we don't miss early frames.
    client.on("message", (data, isBinary) => {
        if (session.closed) return;
        if (isBinary) {
            const rec = session.recording;
            if (!rec) return; // ignore stray audio outside a recording window
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
            rec.chunks.push(buf);
            rec.totalBytes += buf.length;
            return;
        }
        const text = data.toString();
        let msg: any;
        try { msg = JSON.parse(text); } catch { return; }
        void handleClientMessage(session, msg);
    });

    client.on("close", () => {
        session.closed = true;
        teardownSession(session);
        console.log(`[voice-ws] client disconnected (session=${sessionId})`);
    });

    client.on("error", (err) => {
        console.error("[voice-ws] client error:", err);
    });

    // Open orchestrator bridge.
    try {
        const token = await attachSession(sessionId, ELEVEN_SYSTEM_PROMPT_FRAGMENT);
        const orchestrator = new WebSocket(orchestratorWsUrl(token));
        session.orchestrator = orchestrator;
        wireOrchestrator(session, orchestrator);
        await waitForOpen(orchestrator);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "session_busy") {
            sendJson(client, { type: "error", message: "That session is already in use." });
        } else {
            console.error("[voice-ws] failed to attach to orchestrator:", err);
            sendJson(client, { type: "error", message: "Could not reach the orchestrator." });
        }
        client.close(1011, "attach_failed");
        return;
    }

    if (session.closed) return; // client gave up before we finished setup
    sendJson(client, { type: "ready" });
    console.log(`[voice-ws] connected (session=${sessionId})`);
}

async function handleClientMessage(session: Session, msg: any): Promise<void> {
    switch (msg?.type) {
        case "start_recording": {
            // User is taking the floor — kill any in-flight TTS and orchestrator turn,
            // and refuse proactives until they finish speaking.
            abortCurrentTts(session, "user_recording");
            sendOrchestrator(session, { type: "abort", turnId: "current", reason: "user_recording" });
            sendOrchestrator(session, { type: "deliverability", deliverable: false, reason: "recording" });
            session.recording = { chunks: [], totalBytes: 0 };
            return;
        }
        case "stop_recording": {
            await finalizeRecording(session);
            return;
        }
        case "end": {
            try { session.client.close(1000, "client_end"); } catch { /* ignore */ }
            return;
        }
        default:
            return;
    }
}

async function finalizeRecording(session: Session): Promise<void> {
    const rec = session.recording;
    session.recording = null;
    if (!rec || rec.totalBytes === 0) {
        sendOrchestrator(session, { type: "deliverability", deliverable: true });
        return;
    }

    const audio = Buffer.concat(rec.chunks, rec.totalBytes);

    // ElevenLabs needs ≥100ms of audio — ignore taps shorter than that.
    // 16 kHz mono s16le → 32 000 bytes/sec → 3 200 bytes per 100 ms.
    if (audio.length < 3200) {
        sendOrchestrator(session, { type: "deliverability", deliverable: true });
        return;
    }

    let transcript = "";
    try {
        const res = await getElevenLabs().speechToText.convert({
            modelId: STT_MODEL,
            fileFormat: "pcm_s16le_16",
            languageCode: "en",
            file: audio,
        });
        transcript = ((res as { text?: string }).text ?? "").trim();
    } catch (err) {
        console.error("[voice-ws] STT failed:", err);
        sendJson(session.client, { type: "error", message: "Transcription failed." });
        sendOrchestrator(session, { type: "deliverability", deliverable: true });
        return;
    }

    if (!transcript) {
        sendOrchestrator(session, { type: "deliverability", deliverable: true });
        return;
    }

    sendJson(session.client, {
        type: "transcript_user",
        id: `u-${Date.now()}`,
        text: transcript,
    });

    sendOrchestrator(session, { type: "user_message", text: transcript });
    sendOrchestrator(session, { type: "deliverability", deliverable: true });
}

// ---------- orchestrator bridge ----------

function wireOrchestrator(session: Session, ws: WebSocket): void {
    ws.on("message", (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === "assistant_chunk" || msg.type === "assistant_proactive") {
            const turnId: string = String(msg.turnId);
            const text: string = msg.text ?? "";
            const final: boolean = !!msg.final;

            if (text) {
                ensureTtsTurn(session, turnId);
                sendTtsText(session, text);
            }
            if (final) {
                if (session.tts?.turnId === turnId) {
                    finishTtsTurn(session);
                } else {
                    // Turn had no text — never opened TTS. Tell the client
                    // anyway so it doesn't stay in `speaking`.
                    sendJson(session.client, { type: "tts_end", turnId });
                }
            }

            sendJson(session.client, {
                type: "transcript_agent",
                turnId,
                text,
                final,
            });
            return;
        }
        if (msg.type === "session_info") {
            console.log(`[voice-ws] orchestrator session ${msg.sessionId} (${msg.label})`);
            return;
        }
        if (msg.type === "error") {
            console.error("[voice-ws] orchestrator error:", msg.message);
            sendJson(session.client, { type: "error", message: String(msg.message) });
            return;
        }
    });

    ws.on("close", () => {
        if (session.closed) return;
        sendJson(session.client, { type: "error", message: "Orchestrator disconnected." });
        try { session.client.close(1011, "orchestrator_closed"); } catch { /* ignore */ }
    });

    ws.on("error", (err) => {
        console.error("[voice-ws] orchestrator socket error:", err);
    });
}

// ---------- TTS streaming ----------

function ensureTtsTurn(session: Session, turnId: string): void {
    const cur = session.tts;
    if (cur && cur.turnId === turnId && cur.ws.readyState !== WebSocket.CLOSED) return;
    if (cur) abortTtsLocal(cur);
    openTtsTurn(session, turnId);
}

function openTtsTurn(session: Session, turnId: string): void {
    const apiKey = requiredEnv("ELEVENLABS_API_KEY");
    const voiceId = requiredEnv("ELEVENLABS_VOICE_ID");

    const url =
        `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input` +
        `?model_id=${encodeURIComponent(TTS_MODEL)}` +
        `&output_format=${encodeURIComponent(TTS_OUTPUT_FORMAT)}`;

    const ws = new WebSocket(url, { headers: { "xi-api-key": apiKey } });
    const turn: TtsTurn = {
        turnId,
        ws,
        opened: false,
        finalized: false,
        finished: false,
        pendingText: [],
    };
    session.tts = turn;

    ws.on("open", () => {
        try {
            ws.send(JSON.stringify({
                text: " ",
                voice_settings: getTtsVoiceSettings(),
                generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
                xi_api_key: apiKey,
            }));
        } catch (err) {
            console.warn("[voice-ws] tts BOS failed:", err);
        }
        turn.opened = true;
        sendJson(session.client, {
            type: "tts_start",
            turnId,
            sampleRate: TTS_SAMPLE_RATE,
        });
        // Drain anything that arrived while the WS was still CONNECTING.
        for (const text of turn.pendingText) {
            try {
                ws.send(JSON.stringify({ text, try_trigger_generation: true }));
            } catch (err) {
                console.warn("[voice-ws] tts drain text failed:", err);
            }
        }
        turn.pendingText = [];
        if (turn.finalized) {
            try { ws.send(JSON.stringify({ text: "" })); }
            catch (err) { console.warn("[voice-ws] tts drain finalize failed:", err); }
        }
    });

    ws.on("message", (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.audio) {
            const audio = Buffer.from(msg.audio, "base64");
            if (session.client.readyState === WebSocket.OPEN) {
                try { session.client.send(audio, { binary: true }); }
                catch (err) { console.warn("[voice-ws] forward audio failed:", err); }
            }
        }
        if (msg.isFinal) {
            sendJson(session.client, { type: "tts_end", turnId });
            turn.finished = true;
            try { ws.close(1000, "drained"); } catch { /* ignore */ }
            if (session.tts === turn) session.tts = null;
        }
    });

    ws.on("error", (err) => {
        console.error("[voice-ws] tts ws error:", err);
    });

    ws.on("close", () => {
        if (session.tts === turn) session.tts = null;
    });
}

function sendTtsText(session: Session, text: string): void {
    const turn = session.tts;
    if (!turn) return;
    if (!turn.opened) {
        // Queue until the WS opens — short replies frequently arrive in full
        // while the TTS WS is still CONNECTING.
        turn.pendingText.push(text);
        return;
    }
    if (turn.ws.readyState !== WebSocket.OPEN) return;
    try {
        turn.ws.send(JSON.stringify({ text, try_trigger_generation: true }));
    } catch (err) {
        console.warn("[voice-ws] tts text send failed:", err);
    }
}

function finishTtsTurn(session: Session): void {
    const turn = session.tts;
    if (!turn) return;
    turn.finalized = true;
    if (!turn.opened) return; // open handler will flush the EOS
    if (turn.ws.readyState !== WebSocket.OPEN) return;
    try {
        // Empty string signals end-of-input to ElevenLabs; remaining audio
        // continues to stream down before the TTS WS closes itself.
        turn.ws.send(JSON.stringify({ text: "" }));
    } catch (err) {
        console.warn("[voice-ws] tts finalize failed:", err);
    }
}

function abortCurrentTts(session: Session, reason: string): void {
    const turn = session.tts;
    if (!turn) return;
    abortTtsLocal(turn);
    session.tts = null;
    sendJson(session.client, { type: "tts_abort", turnId: turn.turnId, reason });
}

function abortTtsLocal(turn: TtsTurn): void {
    try { turn.ws.close(1000, "aborted"); } catch { /* ignore */ }
}

// ---------- utilities ----------

function waitForOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.OPEN) return resolve();
        const onOpen = () => { cleanup(); resolve(); };
        const onError = (err: Error) => { cleanup(); reject(err); };
        const onClose = () => { cleanup(); reject(new Error("orchestrator ws closed before open")); };
        function cleanup() {
            ws.off("open", onOpen);
            ws.off("error", onError);
            ws.off("close", onClose);
        }
        ws.once("open", onOpen);
        ws.once("error", onError);
        ws.once("close", onClose);
    });
}

function sendJson(ws: WebSocket, msg: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); }
    catch (err) { console.warn("[voice-ws] send failed:", err); }
}

function sendOrchestrator(session: Session, msg: unknown): void {
    const ws = session.orchestrator;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); }
    catch (err) { console.warn("[voice-ws] orchestrator send failed:", err); }
}

function teardownSession(session: Session): void {
    if (session.tts) {
        try { session.tts.ws.close(1000, "client_closed"); } catch { /* ignore */ }
        session.tts = null;
    }
    if (session.orchestrator) {
        try { session.orchestrator.close(1000, "client_closed"); } catch { /* ignore */ }
        session.orchestrator = null;
    }
}
