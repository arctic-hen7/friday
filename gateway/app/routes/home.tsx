import { useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "./+types/home";
import { ConversationProvider } from "@elevenlabs/react";
import { useVoiceAgent, type VoiceControlState } from "../voiceAgent";
import { Orb, PALETTES, type OrbRing, type OrbState } from "../orb";

export function meta({ }: Route.MetaArgs) {
    return [
        { title: "Friday — Voice Gateway" },
        { name: "description", content: "Friday voice agent gateway and client" },
    ];
}

const HOLD_MS = 850;
const PALETTE = "spectra";

type StatusDot = "off" | "warn" | "err" | "live" | "muted";

type StatusCopy = {
    label: string;
    hint: string;
    chip: string;
    dot: StatusDot;
};

const STATUS_COPY: Record<VoiceControlState, StatusCopy> = {
    idle:       { label: "Tap to connect",     hint: "Start a voice session with Friday", chip: "Offline",    dot: "off"   },
    connecting: { label: "Connecting",         hint: "Securing a live channel…",          chip: "Connecting", dot: "warn"  },
    error:      { label: "Couldn't connect",   hint: "Tap to try again",                  chip: "No signal",  dot: "err"   },
    listening:  { label: "Listening",          hint: "Hold to end · tap to mute",         chip: "Live",       dot: "live"  },
    processing: { label: "Thinking",           hint: "Hold to end",                       chip: "Live",       dot: "live"  },
    speaking:   { label: "Friday is speaking", hint: "Hold to end · tap to mute",         chip: "Live",       dot: "live"  },
    muted:      { label: "Muted",              hint: "Tap to unmute · hold to end",       chip: "Muted",      dot: "muted" },
};

const ORB_STATE: Record<VoiceControlState, OrbState> = {
    idle:       "idle",
    connecting: "connecting",
    error:      "error",
    listening:  "listening",
    processing: "processing",
    speaking:   "responding",
    muted:      "muted",
};

const LIVE_STATES = new Set<VoiceControlState>(["listening", "processing", "speaking", "muted"]);

function formatStamp(ms: number) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
}

function VoiceAgent() {
    const { control, error, transcript, getInputVolume, getOutputVolume } = useVoiceAgent();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const orbRef = useRef<Orb | null>(null);
    const railBodyRef = useRef<HTMLDivElement | null>(null);

    const status = STATUS_COPY[control.state];
    const live = LIVE_STATES.has(control.state);

    // boot the orb once, drive it from React state thereafter
    useEffect(() => {
        if (!canvasRef.current || orbRef.current) return;
        const orb = new Orb(canvasRef.current, {
            palette: PALETTE,
            count: 880,
            seed: 7.7,
            motion: { spin: 1.8, flow: 0.65, wander: 1.2 },
        });
        orb.setState("idle");
        orb.start();
        orbRef.current = orb;

        const glow = PALETTES[PALETTE]?.glow;
        if (glow) document.documentElement.style.setProperty("--accent", glow);

        return () => {
            orb.destroy();
            orbRef.current = null;
        };
    }, []);

    useEffect(() => {
        orbRef.current?.setState(ORB_STATE[control.state]);
    }, [control.state]);

    // feed mic / agent volume into the orb so particles bounce with the audio.
    // input volume drives the orb while the user is talking; output volume while Friday is.
    useEffect(() => {
        const orb = orbRef.current;
        if (!orb || !live) {
            orb?.setAmplitude(0);
            return;
        }
        let raf = 0;
        const tick = () => {
            let v = 0;
            if (control.state === "speaking") v = getOutputVolume();
            else if (control.state === "listening") v = getInputVolume();
            // muted / processing leave amplitude at 0 — state's base energy still animates the orb
            orb.setAmplitude(Number.isFinite(v) ? v : 0);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [live, control.state, getInputVolume, getOutputVolume]);

    // visual hold-to-end progress — voiceAgent.ts owns the actual end timer,
    // we just mirror the press window onto the ring for feedback.
    const [holdProgress, setHoldProgress] = useState<number | null>(null);
    const holdRafRef = useRef<number | null>(null);

    function clearHoldRaf() {
        if (holdRafRef.current !== null) {
            cancelAnimationFrame(holdRafRef.current);
            holdRafRef.current = null;
        }
    }

    function beginHoldRing() {
        // only show ring while a session is in progress (matches voiceAgent's long-press scope)
        if (!live) return;
        const started = performance.now();
        const step = () => {
            const p = Math.min(1, (performance.now() - started) / HOLD_MS);
            setHoldProgress(p);
            if (p < 1) holdRafRef.current = requestAnimationFrame(step);
        };
        holdRafRef.current = requestAnimationFrame(step);
    }

    function endHoldRing() {
        clearHoldRaf();
        setHoldProgress(null);
    }

    useEffect(() => () => clearHoldRaf(), []);

    useEffect(() => {
        const orb = orbRef.current;
        if (!orb) return;
        let ring: OrbRing | null;
        if (holdProgress !== null) ring = { mode: "progress", p: holdProgress };
        else if (control.state === "connecting") ring = { mode: "sweep" };
        else ring = null;
        orb.setRing(ring);
    }, [holdProgress, control.state]);

    // session timer — runs while in any live state
    const [elapsed, setElapsed] = useState(0);
    const startRef = useRef<number | null>(null);
    useEffect(() => {
        if (!live) {
            startRef.current = null;
            setElapsed(0);
            return;
        }
        if (startRef.current === null) startRef.current = Date.now();
        const id = setInterval(() => {
            if (startRef.current !== null) setElapsed(Date.now() - startRef.current);
        }, 500);
        return () => clearInterval(id);
    }, [live]);

    // stable per-message timestamp, relative to session start
    const stampsRef = useRef<Map<string, string>>(new Map());
    useEffect(() => {
        if (!live) stampsRef.current.clear();
    }, [live]);

    const transcriptWithStamps = useMemo(() => {
        const stamps = stampsRef.current;
        const sessionStart = startRef.current;
        return transcript.map(m => {
            let stamp = stamps.get(m.id);
            if (!stamp) {
                stamp = formatStamp(sessionStart ? Date.now() - sessionStart : 0);
                stamps.set(m.id, stamp);
            }
            return { ...m, stamp };
        });
    }, [transcript]);

    useEffect(() => {
        const el = railBodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [transcriptWithStamps.length]);

    const micNote =
        control.state === "muted"
            ? "Microphone muted"
            : live
                ? "Microphone live"
                : "Microphone idle";

    const handlers = control.buttonHandlers;

    return (
        <div className="app">
            <header className="topbar">
                <div className="brand">
                    <img className="brand-mark" src="/icon-48.png" alt="" aria-hidden="true" />
                    FRIDAY
                </div>
                <div className={`status-chip dot-${status.dot}`}>
                    <span className="chip-text">{status.chip}</span>
                </div>
            </header>

            <div className="row">
                <main className="stage">
                    <div className="orb-wrap">
                        <canvas ref={canvasRef} className="orb-canvas" />
                        <button
                            type="button"
                            className="orb-hit"
                            aria-label="Voice control — tap to connect or mute; hold to end"
                            aria-busy={control.isConnecting}
                            onClick={handlers.onClick}
                            onPointerDown={e => { handlers.onPointerDown?.(e); beginHoldRing(); }}
                            onPointerUp={e => { handlers.onPointerUp?.(e); endHoldRing(); }}
                            onPointerCancel={e => { handlers.onPointerCancel?.(e); endHoldRing(); }}
                            onPointerLeave={e => { handlers.onPointerLeave?.(e); endHoldRing(); }}
                        />
                    </div>

                    <div className="readout">
                        <div className="status-label">{status.label}</div>
                        <div className="status-hint">{status.hint}</div>
                    </div>

                    {error ? <div className="error-panel">{error}</div> : null}
                </main>

                <aside className="rail">
                    <div className="rail-head">
                        <span className="rail-title">Transcript</span>
                        <span className="rail-timer">{formatStamp(elapsed)}</span>
                    </div>
                    <div className="rail-body" ref={railBodyRef}>
                        {transcriptWithStamps.length === 0 ? (
                            <div className="rail-empty">
                                No session yet. Tap the orb to connect and start talking with Friday.
                            </div>
                        ) : (
                            transcriptWithStamps.map(m => (
                                <div
                                    key={m.id}
                                    className={`line ${m.role === "agent" ? "line-friday" : "line-you"}`}
                                >
                                    <span className="line-time">{m.stamp}</span>
                                    <div className="line-body">
                                        <span className="line-who">{m.role === "agent" ? "Friday" : "You"}</span>
                                        <p className="line-text">{m.message}</p>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                    <div className="rail-foot">
                        <span className="mic-i" />
                        <span>{micNote}</span>
                    </div>
                </aside>
            </div>
        </div>
    );
}

export default function Home() {
    return (
        <ConversationProvider>
            <VoiceAgent />
        </ConversationProvider>
    );
}
