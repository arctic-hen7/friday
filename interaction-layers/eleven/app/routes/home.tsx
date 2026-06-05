import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "./+types/home";
import { useVoiceAgent, type VoiceControlState } from "../voiceAgent";
import { Orb, PALETTES, type OrbState } from "../orb";
import { SessionPicker, useActiveSession } from "../sessionPicker";

export function meta({ }: Route.MetaArgs) {
    return [
        { title: "Friday — Voice Gateway" },
        { name: "description", content: "Friday voice agent gateway and client" },
    ];
}

const PALETTE = "spectra";

type StatusDot = "off" | "warn" | "err" | "live" | "muted";

type StatusCopy = {
    label: string;
    hint: string;
    chip: string;
    dot: StatusDot;
};

const STATUS_COPY: Record<VoiceControlState, StatusCopy> = {
    idle:       { label: "Tap to connect",     hint: "Tap the orb to start a session",            chip: "Offline",    dot: "off"  },
    connecting: { label: "Connecting",          hint: "Securing a live channel…",                  chip: "Connecting", dot: "warn" },
    error:      { label: "Couldn't connect",    hint: "Tap the orb to reconnect",                  chip: "No signal",  dot: "err"  },
    listening:  { label: "Hold to talk",        hint: "Press and hold the orb to speak",           chip: "Ready",      dot: "live" },
    recording:  { label: "Listening",           hint: "Release the orb when you're done",          chip: "Live",       dot: "live" },
    processing: { label: "Thinking",            hint: "Friday is working on it",                   chip: "Live",       dot: "live" },
    speaking:   { label: "Friday is speaking",  hint: "Hold the orb to interrupt",                 chip: "Live",       dot: "live" },
};

const ORB_STATE: Record<VoiceControlState, OrbState> = {
    idle:       "idle",
    connecting: "connecting",
    error:      "error",
    listening:  "listening",
    recording:  "userSpeaking",
    processing: "processing",
    speaking:   "responding",
};

const LIVE_STATES = new Set<VoiceControlState>(["listening", "recording", "processing", "speaking"]);

function formatStamp(ms: number) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
}

type VoiceAgentProps = {
    onEnd: (opts: { deleteSession: boolean }) => Promise<void>;
    ensureSession: () => Promise<void>;
};

function VoiceAgent({ onEnd, ensureSession }: VoiceAgentProps) {
    const { control, sessionActive, error, transcript, getInputVolume, getOutputVolume, endConversation } = useVoiceAgent({ ensureSession });
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const orbRef = useRef<Orb | null>(null);
    const railBodyRef = useRef<HTMLDivElement | null>(null);

    const status = STATUS_COPY[control.state];
    const live = LIVE_STATES.has(control.state);

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
            else if (control.state === "recording") v = getInputVolume();
            orb.setAmplitude(Number.isFinite(v) ? v : 0);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [live, control.state, getInputVolume, getOutputVolume]);

    useEffect(() => {
        const orb = orbRef.current;
        if (!orb) return;
        if (control.state === "connecting") orb.setRing({ mode: "sweep" });
        else orb.setRing(null);
    }, [control.state]);

    const [elapsed, setElapsed] = useState(0);
    const startRef = useRef<number | null>(null);
    useEffect(() => {
        if (!sessionActive) {
            startRef.current = null;
            setElapsed(0);
            return;
        }
        if (startRef.current === null) startRef.current = Date.now();
        const id = setInterval(() => {
            if (startRef.current !== null) setElapsed(Date.now() - startRef.current);
        }, 500);
        return () => clearInterval(id);
    }, [sessionActive]);

    const stampsRef = useRef<Map<string, string>>(new Map());
    useEffect(() => {
        if (!sessionActive) stampsRef.current.clear();
    }, [sessionActive]);

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
        control.state === "recording"
            ? "Microphone live"
            : sessionActive
                ? "Microphone armed"
                : "Microphone idle";

    const handlers = control.buttonHandlers;

    const handleEnd = useCallback(
        (deleteSession: boolean) => {
            endConversation();
            void onEnd({ deleteSession });
        },
        [endConversation, onEnd],
    );

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
                            aria-label="Voice control — press and hold to talk"
                            aria-busy={control.isConnecting}
                            onPointerDown={handlers.onPointerDown}
                            onPointerUp={handlers.onPointerUp}
                            onPointerCancel={handlers.onPointerCancel}
                            onPointerLeave={handlers.onPointerLeave}
                        />
                    </div>

                    <div className="readout">
                        <div className="status-label">{status.label}</div>
                        <div className="status-hint">{status.hint}</div>
                    </div>

                    {error ? <div className="error-panel">{error}</div> : null}

                    {sessionActive ? <EndConversationSplit onEnd={handleEnd} /> : null}
                </main>

                <aside className="rail">
                    <div className="rail-head">
                        <span className="rail-title">Transcript</span>
                        <span className="rail-timer">{formatStamp(elapsed)}</span>
                    </div>
                    <div className="rail-body" ref={railBodyRef}>
                        {transcriptWithStamps.length === 0 ? (
                            <div className="rail-empty">
                                No session yet. Press and hold the orb to start talking with Friday.
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

type EndConversationSplitProps = {
    onEnd: (deleteSession: boolean) => void;
};

function EndConversationSplit({ onEnd }: EndConversationSplitProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!menuOpen) return;
        function onDown(ev: PointerEvent) {
            if (!wrapRef.current) return;
            if (!wrapRef.current.contains(ev.target as Node)) setMenuOpen(false);
        }
        function onKey(ev: KeyboardEvent) {
            if (ev.key === "Escape") setMenuOpen(false);
        }
        window.addEventListener("pointerdown", onDown);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("pointerdown", onDown);
            window.removeEventListener("keydown", onKey);
        };
    }, [menuOpen]);

    return (
        <div className="end-split" ref={wrapRef}>
            <button
                type="button"
                className="end-split-main"
                onClick={() => onEnd(true)}
            >
                <span className="end-split-glyph" aria-hidden="true" />
                End conversation
            </button>
            <button
                type="button"
                className="end-split-toggle"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More end-conversation options"
                onClick={() => setMenuOpen(open => !open)}
            >
                <svg
                    className="end-split-chevron"
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                >
                    <path d="M1.5 3.5 L5 7 L8.5 3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
            {menuOpen ? (
                <div className="end-split-menu" role="menu">
                    <button
                        type="button"
                        role="menuitem"
                        className="end-split-menu-item"
                        onClick={() => { setMenuOpen(false); onEnd(false); }}
                    >
                        End but keep session
                        <span className="end-split-menu-hint">
                            Leaves the session in history so you can return to it
                        </span>
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function HomeInner() {
    const { active, resolved, set } = useActiveSession();
    const [picking, setPicking] = useState(false);
    const activeRef = useRef<string | null>(null);
    activeRef.current = active;

    // When the tab is being closed, fire-and-forget a delete request for the
    // current session. `pagehide` is more reliable than `beforeunload` and
    // fires on Safari iOS too. Network drops don't trigger pagehide, so true
    // disconnects still leave the session intact (per user preference).
    useEffect(() => {
        function onPageHide() {
            const id = activeRef.current;
            if (!id) return;
            try {
                const body = new Blob(
                    [JSON.stringify({ delete: true, sessionId: id })],
                    { type: "application/json" },
                );
                navigator.sendBeacon("/api/end-session", body);
            } catch { /* ignore */ }
        }
        window.addEventListener("pagehide", onPageHide);
        return () => window.removeEventListener("pagehide", onPageHide);
    }, []);

    // End the current conversation. We don't create a successor up-front —
    // the next press of the orb will lazily provision one via ensureSession.
    const endConversation = useCallback(
        async ({ deleteSession }: { deleteSession: boolean }) => {
            const previousId = activeRef.current;
            try {
                await fetch("/api/end-session", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ delete: deleteSession, sessionId: previousId }),
                });
            } catch (err) {
                console.warn("[home] end-session failed:", err);
            }
            await set(null);
        },
        [set],
    );

    // Provision a session on demand. The orb's first press calls this before
    // opening the gateway WS so the orchestrator has a session to attach to.
    const ensureSession = useCallback(async () => {
        if (activeRef.current) return;
        const res = await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label: `Voice ${new Date().toLocaleString()}` }),
        });
        if (!res.ok) throw new Error(`Couldn't create a session (HTTP ${res.status})`);
        const row = (await res.json()) as { id: string };
        await set(row.id);
    }, [set]);

    if (!resolved) return null;

    if (picking) {
        return (
            <SessionPicker
                onPicked={(id) => { setPicking(false); void set(id); }}
            />
        );
    }

    return (
        <>
            <VoiceAgent onEnd={endConversation} ensureSession={ensureSession} />
            <button
                className="session-switch"
                onClick={() => setPicking(true)}
                title="Switch to a different session"
            >
                Switch session
            </button>
        </>
    );
}

export default function Home() {
    return <HomeInner />;
}
