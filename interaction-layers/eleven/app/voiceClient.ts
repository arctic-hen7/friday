// Browser-side voice client for push-to-talk.
//
// Owns a single WebSocket to the gateway, the mic AudioContext + worklet that
// produces PCM frames while recording, and a Web-Audio playback queue for the
// PCM frames the gateway streams back from TTS.
//
// Press-to-talk lifecycle:
//   connect()         opens the WS, primes the mic
//   startRecording()  starts the worklet and tells the server we're talking
//   stopRecording()   stops the worklet and tells the server to transcribe
//   disconnect()      tears the whole session down (end-conversation button)
//
// The audio path on the way in is mic → AudioContext@16k → AudioWorklet →
// Int16 PCM → WS binary. On the way out it's WS binary → Int16 PCM @ 22.05k
// → AudioBuffer → scheduled at the running playback cursor.

export type VoicePhase =
    | "idle"
    | "connecting"
    | "ready"
    | "recording"
    | "processing"
    | "speaking"
    | "error";

export type VoiceTranscriptMessage = {
    id: string;
    role: "user" | "agent";
    message: string;
};

type Listeners = {
    onPhase: (phase: VoicePhase) => void;
    onError: (message: string) => void;
    onTranscript: (messages: VoiceTranscriptMessage[]) => void;
    onMicLevel?: (level: number) => void;     // 0..1
    onOutputLevel?: (level: number) => void;  // 0..1
};

const CAPTURE_SAMPLE_RATE = 16000;
const CAPTURE_WORKLET_NAME = "friday-pcm-capture";
const CAPTURE_WORKLET_SRC = `
class PCMCapture extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        const channel = input[0];
        if (!channel || channel.length === 0) return true;
        const out = new Int16Array(channel.length);
        let peak = 0;
        for (let i = 0; i < channel.length; i++) {
            const s = Math.max(-1, Math.min(1, channel[i]));
            if (s > peak) peak = s;
            else if (-s > peak) peak = -s;
            out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        this.port.postMessage({ buffer: out.buffer, peak }, [out.buffer]);
        return true;
    }
}
registerProcessor(${JSON.stringify(CAPTURE_WORKLET_NAME)}, PCMCapture);
`;

export class VoiceClient {
    private ws: WebSocket | null = null;
    private phase: VoicePhase = "idle";

    private micStream: MediaStream | null = null;
    private captureCtx: AudioContext | null = null;
    private captureNode: AudioWorkletNode | null = null;
    private captureSource: MediaStreamAudioSourceNode | null = null;
    private workletReady: Promise<void> | null = null;

    private playbackCtx: AudioContext | null = null;
    private playbackDest: MediaStreamAudioDestinationNode | null = null;
    private playbackEl: HTMLAudioElement | null = null;
    private playbackRate = 22050;
    private playbackCursor = 0;
    private activeSources: AudioBufferSourceNode[] = [];

    private pendingAgentTurns = new Map<string, string>();
    private messages: VoiceTranscriptMessage[] = [];
    private agentTurnOrder: string[] = [];

    constructor(private readonly listeners: Listeners) {}

    getPhase(): VoicePhase { return this.phase; }

    // Unlock the playback AudioContext from inside a synchronous user gesture.
    // Must be invoked from the pointer handler *before* any await — Chrome
    // (incl. Brave) on Android only honours its autoplay policy if `resume()`
    // runs while a sticky user activation is on the stack, and desktop MEI
    // hides the bug. Once unlocked, the context is reused for every TTS frame
    // and survives disconnect/reconnect, so this only needs to fire on the
    // first tap.
    primePlayback(): void {
        this.ensurePlaybackCtx();
        void this.resumePlayback();
        // Kick the sink <audio> element under the same user gesture so its
        // autoplay promise resolves now instead of being blocked later.
        const el = this.playbackEl;
        if (el && el.paused) {
            void el.play().catch(() => { /* ignore */ });
        }
    }

    async connect(): Promise<void> {
        if (this.ws) return;
        this.setPhase("connecting");

        // Safety net in case connect() is reached without a prior primePlayback
        // — the canonical unlock happens synchronously in the pointer handler.
        this.ensurePlaybackCtx();
        void this.resumePlayback();

        // Request mic permission early so we can fail fast if denied.
        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            this.setPhase("error");
            this.listeners.onError(micErrorMessage(err));
            return;
        }

        // Open the gateway WS.
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}/api/voice/ws`;
        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        this.ws = ws;

        ws.addEventListener("message", (ev) => {
            if (typeof ev.data === "string") this.handleControl(ev.data);
            else if (ev.data instanceof ArrayBuffer) this.handleAudio(ev.data);
        });

        ws.addEventListener("close", () => {
            this.ws = null;
            this.teardownAudio();
            if (this.phase !== "error") this.setPhase("idle");
        });

        ws.addEventListener("error", () => {
            // close will fire right after; let it handle phase.
        });
    }

    async startRecording(): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.phase === "recording") return;

        // User is taking the floor — stop any playback locally too so we don't
        // overhear ourselves through the speakers.
        this.cancelPlayback();

        try {
            await this.ensureCapture();
        } catch (err) {
            this.setPhase("error");
            this.listeners.onError(micErrorMessage(err));
            return;
        }

        this.sendControl({ type: "start_recording" });
        this.setPhase("recording");
    }

    stopRecording(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.phase !== "recording") return;

        this.stopCapture();
        this.sendControl({ type: "stop_recording" });
        this.setPhase("processing");
    }

    disconnect(): void {
        const ws = this.ws;
        this.ws = null;
        if (ws) {
            try { ws.send(JSON.stringify({ type: "end" })); } catch { /* ignore */ }
            try { ws.close(1000, "client_end"); } catch { /* ignore */ }
        }
        this.teardownAudio();
        this.setPhase("idle");
        this.messages = [];
        this.pendingAgentTurns.clear();
        this.agentTurnOrder = [];
        this.emitTranscript();
    }

    // Full teardown including the playback AudioContext. Use this on component
    // unmount; regular session end should go through disconnect() so the
    // unlocked context survives for the next conversation.
    dispose(): void {
        this.disconnect();
        if (this.playbackEl) {
            try { this.playbackEl.pause(); } catch { /* ignore */ }
            this.playbackEl.srcObject = null;
            this.playbackEl.remove();
            this.playbackEl = null;
        }
        this.playbackDest = null;
        if (this.playbackCtx) {
            void this.playbackCtx.close().catch(() => { /* ignore */ });
            this.playbackCtx = null;
        }
    }

    // ---------- internals ----------

    private setPhase(next: VoicePhase): void {
        if (this.phase === next) return;
        this.phase = next;
        this.listeners.onPhase(next);
    }

    private sendControl(msg: unknown): void {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }

    private handleControl(raw: string): void {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case "ready":
                this.setPhase("ready");
                return;
            case "transcript_user":
                this.pushMessage({ id: msg.id, role: "user", message: msg.text });
                return;
            case "transcript_agent": {
                const turnId = String(msg.turnId);
                const delta = String(msg.text ?? "");
                const final = !!msg.final;
                const existing = this.pendingAgentTurns.get(turnId) ?? "";
                const next = existing + delta;
                this.pendingAgentTurns.set(turnId, next);
                if (!this.agentTurnOrder.includes(turnId)) this.agentTurnOrder.push(turnId);
                this.upsertAgentMessage(turnId, next);
                if (final) {
                    this.pendingAgentTurns.delete(turnId);
                    this.agentTurnOrder = this.agentTurnOrder.filter(t => t !== turnId);
                }
                return;
            }
            case "tts_start":
                this.playbackRate = msg.sampleRate ?? 22050;
                this.ensurePlaybackCtx();
                void this.resumePlayback();
                this.playbackCursor = this.playbackCtx?.currentTime ?? 0;
                if (this.phase !== "recording") this.setPhase("speaking");
                return;
            case "tts_end":
                this.scheduleSpeakingEnd(String(msg.turnId ?? ""));
                return;
            case "tts_abort":
                this.cancelPlayback();
                if (this.phase === "speaking") this.setPhase("ready");
                return;
            case "error":
                this.listeners.onError(String(msg.message ?? "Voice gateway error."));
                this.setPhase("error");
                return;
        }
    }

    private pushMessage(m: VoiceTranscriptMessage): void {
        this.messages.push(m);
        this.emitTranscript();
    }

    private upsertAgentMessage(turnId: string, fullText: string): void {
        const id = `a-${turnId}`;
        const existing = this.messages.find(m => m.id === id);
        if (existing) {
            existing.message = fullText;
        } else {
            this.messages.push({ id, role: "agent", message: fullText });
        }
        this.emitTranscript();
    }

    private emitTranscript(): void {
        this.listeners.onTranscript(this.messages.slice());
    }

    private async ensureCapture(): Promise<void> {
        if (!this.micStream) {
            this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        if (!this.captureCtx) {
            this.captureCtx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
        }
        if (this.captureCtx.state === "suspended") {
            await this.captureCtx.resume();
        }
        if (!this.workletReady) {
            const blob = new Blob([CAPTURE_WORKLET_SRC], { type: "application/javascript" });
            const url = URL.createObjectURL(blob);
            this.workletReady = this.captureCtx.audioWorklet.addModule(url)
                .finally(() => URL.revokeObjectURL(url));
        }
        await this.workletReady;

        if (this.captureNode) return; // already wired

        const node = new AudioWorkletNode(this.captureCtx, CAPTURE_WORKLET_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: 1,
            channelCountMode: "explicit",
        });
        node.port.onmessage = (ev) => {
            const { buffer, peak } = ev.data as { buffer: ArrayBuffer; peak: number };
            if (this.ws?.readyState === WebSocket.OPEN) {
                try { this.ws.send(buffer); } catch { /* ignore */ }
            }
            this.listeners.onMicLevel?.(peak ?? 0);
        };

        const source = this.captureCtx.createMediaStreamSource(this.micStream);
        source.connect(node);
        this.captureSource = source;
        this.captureNode = node;
    }

    private stopCapture(): void {
        if (this.captureSource) {
            try { this.captureSource.disconnect(); } catch { /* ignore */ }
            this.captureSource = null;
        }
        if (this.captureNode) {
            try { this.captureNode.port.close(); } catch { /* ignore */ }
            try { this.captureNode.disconnect(); } catch { /* ignore */ }
            this.captureNode = null;
        }
        this.listeners.onMicLevel?.(0);
    }

    private teardownAudio(): void {
        this.stopCapture();
        this.workletReady = null;

        if (this.captureCtx) {
            void this.captureCtx.close().catch(() => { /* ignore */ });
            this.captureCtx = null;
        }
        if (this.micStream) {
            for (const t of this.micStream.getTracks()) {
                try { t.stop(); } catch { /* ignore */ }
            }
            this.micStream = null;
        }
        this.cancelPlayback();
        // Deliberately keep playbackCtx alive — it was unlocked under a user
        // gesture and we want to reuse it across disconnect/reconnect.
    }

    private ensurePlaybackCtx(): AudioContext {
        if (this.playbackCtx) return this.playbackCtx;
        const ctx = new AudioContext();
        this.playbackCtx = ctx;

        // Route output through a MediaStreamDestination piped into an <audio>
        // element. While a mic stream is held, Android/iOS put the OS audio
        // session into "communication" mode and ctx.destination plays through
        // the earpiece (or whatever the call output is). Sending the WebAudio
        // graph into a MediaStream that an HTMLAudioElement consumes forces
        // the output back onto the media stream type, which uses the regular
        // loudspeaker.
        const dest = ctx.createMediaStreamDestination();
        const el = document.createElement("audio");
        el.autoplay = true;
        el.playsInline = true;
        el.srcObject = dest.stream;
        el.style.display = "none";
        // Some mobile browsers refuse to start a MediaStream-backed element
        // unless it's actually in the document.
        document.body.appendChild(el);
        this.playbackDest = dest;
        this.playbackEl = el;

        return ctx;
    }

    private async resumePlayback(): Promise<void> {
        const ctx = this.playbackCtx;
        if (!ctx) return;
        if (ctx.state === "suspended") {
            try { await ctx.resume(); } catch { /* ignore */ }
        }
    }

    private handleAudio(buf: ArrayBuffer): void {
        const ctx = this.ensurePlaybackCtx();
        const pcm = new Int16Array(buf);
        if (pcm.length === 0) return;

        const float = new Float32Array(pcm.length);
        let peak = 0;
        for (let i = 0; i < pcm.length; i++) {
            const v = pcm[i]! / 32768;
            float[i] = v;
            const a = v < 0 ? -v : v;
            if (a > peak) peak = a;
        }
        this.listeners.onOutputLevel?.(peak);

        const audioBuffer = ctx.createBuffer(1, float.length, this.playbackRate);
        audioBuffer.copyToChannel(float, 0);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.playbackDest ?? ctx.destination);
        const startAt = Math.max(ctx.currentTime, this.playbackCursor);
        source.start(startAt);
        this.playbackCursor = startAt + audioBuffer.duration;

        this.activeSources.push(source);
        source.onended = () => {
            this.activeSources = this.activeSources.filter(s => s !== source);
            this.listeners.onOutputLevel?.(0);
        };
    }

    private cancelPlayback(): void {
        for (const s of this.activeSources) {
            try { s.stop(0); } catch { /* ignore */ }
            try { s.disconnect(); } catch { /* ignore */ }
        }
        this.activeSources = [];
        this.playbackCursor = this.playbackCtx?.currentTime ?? 0;
        this.listeners.onOutputLevel?.(0);
    }

    private scheduleSpeakingEnd(_turnId: string): void {
        const ctx = this.playbackCtx;
        if (!ctx) {
            if (this.phase === "speaking") this.setPhase("ready");
            return;
        }
        // The TTS is done streaming — flip back to ready once the scheduled
        // audio has had time to drain. Don't gate on activeSources, because if
        // the AudioContext was suspended the sources will never end on their
        // own and we'd be stuck in `speaking` forever.
        const wait = Math.max(0, this.playbackCursor - ctx.currentTime);
        setTimeout(() => {
            if (this.phase === "speaking") this.setPhase("ready");
        }, wait * 1000 + 80);
    }
}

function micErrorMessage(err: unknown): string {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
        return "Microphone permission was denied. Allow microphone access in your browser settings and try again.";
    }
    if (err instanceof DOMException && err.name === "NotFoundError") {
        return "No microphone was found. Connect a microphone and try again.";
    }
    if (err instanceof Error) return err.message;
    return String(err);
}
