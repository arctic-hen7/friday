// Browser-side proactive audio player.
//
// One ProactiveListener per active Eleven conversation. It opens a WS to
// /api/proactive/ws?conversationId=..., receives interleaved control JSON
// messages and binary PCM frames, and plays the audio via the Web Audio API.
//
// PCM @ 22050 Hz mono signed 16-bit little-endian. Each binary frame is
// converted to an AudioBuffer and scheduled at the running playback cursor
// so successive frames concatenate seamlessly.
//
// Calling `abort()` (typically because VAD detected user speech) stops every
// scheduled BufferSource immediately and notifies the server, which kills its
// upstream Eleven TTS WS and forwards an abort to the orchestrator.

type Status = "idle" | "playing" | "ended";

type Events = {
    onPlayingChange?: (playing: boolean) => void;
};

export class ProactiveListener {
    private ws: WebSocket | null = null;
    private audioCtx: AudioContext | null = null;
    private sampleRate = 22050;
    private nextStart = 0;          // when the next buffered chunk should start
    private activeSources: AudioBufferSourceNode[] = [];
    private status: Status = "idle";
    private currentTurnId: string | null = null;
    private events: Events;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly conversationId: string, events: Events = {}) {
        this.events = events;
    }

    start(): void {
        this.connect();
    }

    stop(): void {
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        this.cancelAllSources();
        if (this.ws) {
            try { this.ws.close(1000, "stop"); } catch { /* ignore */ }
            this.ws = null;
        }
        if (this.audioCtx) {
            void this.audioCtx.close().catch(() => { /* ignore */ });
            this.audioCtx = null;
        }
        this.setPlaying(false);
    }

    /**
     * Stop playback immediately and tell the server to kill upstream TTS.
     * Safe to call when nothing is playing — becomes a no-op.
     */
    abort(): void {
        if (this.status !== "playing") return;
        this.cancelAllSources();
        if (this.ws?.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify({ type: "abort_proactive" })); } catch { /* ignore */ }
        }
        this.setPlaying(false);
    }

    isPlaying(): boolean {
        return this.status === "playing";
    }

    // ---------- internals ----------

    private connect(): void {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}/api/proactive/ws?conversationId=${encodeURIComponent(this.conversationId)}`;
        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        this.ws = ws;

        ws.addEventListener("open", () => {
            console.log("[proactive] ws open");
        });

        ws.addEventListener("message", (ev) => {
            if (typeof ev.data === "string") {
                this.handleControl(ev.data);
            } else if (ev.data instanceof ArrayBuffer) {
                this.handleAudio(ev.data);
            }
        });

        ws.addEventListener("close", (ev) => {
            console.log(`[proactive] ws closed (code=${ev.code})`);
            this.ws = null;
            // 404 = no player registered yet (user hasn't spoken). Retry
            // periodically while the conversation is alive.
            if (!this.retryTimer) {
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = null;
                    if (!this.audioCtx /* not stopped */ || true) this.connect();
                }, 2000);
            }
        });

        ws.addEventListener("error", () => {
            // Errors fire just before close — let close handle reconnect.
        });
    }

    private handleControl(raw: string): void {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === "start") {
            this.currentTurnId = msg.turnId;
            this.sampleRate = msg.sampleRate ?? 22050;
            this.ensureAudioCtx();
            this.nextStart = (this.audioCtx?.currentTime ?? 0);
            this.status = "playing";
            this.setPlaying(true);
            console.log(`[proactive] playback starting (turn=${msg.turnId} sr=${this.sampleRate})`);
        } else if (msg.type === "end") {
            console.log(`[proactive] playback drained (turn=${msg.turnId})`);
            // Wait for queued sources to finish, then flip state.
            const finishAt = this.nextStart;
            const ctx = this.audioCtx;
            if (ctx) {
                const wait = Math.max(0, finishAt - ctx.currentTime);
                setTimeout(() => {
                    if (this.activeSources.length === 0) {
                        this.status = "idle";
                        this.setPlaying(false);
                    }
                }, wait * 1000 + 50);
            } else {
                this.status = "idle";
                this.setPlaying(false);
            }
        } else if (msg.type === "aborted") {
            console.log(`[proactive] server aborted turn ${msg.turnId}`);
            this.cancelAllSources();
            this.setPlaying(false);
        }
    }

    private handleAudio(buf: ArrayBuffer): void {
        const ctx = this.ensureAudioCtx();
        // PCM 16-bit signed little-endian → Float32 [-1, 1]
        const pcm = new Int16Array(buf);
        if (pcm.length === 0) return;
        const float = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) float[i] = pcm[i]! / 32768;

        const audioBuffer = ctx.createBuffer(1, float.length, this.sampleRate);
        audioBuffer.copyToChannel(float, 0);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        const startAt = Math.max(ctx.currentTime, this.nextStart);
        source.start(startAt);
        this.nextStart = startAt + audioBuffer.duration;

        this.activeSources.push(source);
        source.onended = () => {
            this.activeSources = this.activeSources.filter(s => s !== source);
        };
    }

    private ensureAudioCtx(): AudioContext {
        if (!this.audioCtx) {
            this.audioCtx = new AudioContext();
        }
        return this.audioCtx;
    }

    private cancelAllSources(): void {
        for (const s of this.activeSources) {
            try { s.stop(0); } catch { /* ignore */ }
            try { s.disconnect(); } catch { /* ignore */ }
        }
        this.activeSources = [];
        this.nextStart = this.audioCtx?.currentTime ?? 0;
    }

    private setPlaying(playing: boolean): void {
        this.events.onPlayingChange?.(playing);
    }
}
