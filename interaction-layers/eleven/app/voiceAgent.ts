import { useCallback, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes } from "react";
import { VoiceClient, type VoicePhase, type VoiceTranscriptMessage } from "./voiceClient";

export type TranscriptMessage = VoiceTranscriptMessage;

export type VoiceControlState =
    | "idle"
    | "connecting"
    | "listening"   // ready, mic open but not currently transmitting
    | "recording"   // user holding the orb
    | "processing"  // waiting for STT + first response chunks
    | "speaking"
    | "error";

export type VoiceControlCopy = {
    title: string;
    detail: string;
};

export type VoiceControl = {
    state: VoiceControlState;
    copy: VoiceControlCopy;
    buttonHandlers: Pick<
        ButtonHTMLAttributes<HTMLButtonElement>,
        "onPointerCancel" | "onPointerDown" | "onPointerLeave" | "onPointerUp"
    >;
    isConnecting: boolean;
    showWave: boolean;
};

export type VoiceAgentState = {
    control: VoiceControl;
    sessionActive: boolean;
    error?: string;
    transcript: TranscriptMessage[];
    getInputVolume: () => number;
    getOutputVolume: () => number;
    endConversation: () => void;
};

const TRANSCRIPT_LIMIT = 18;

function phaseToControlState(phase: VoicePhase): VoiceControlState {
    switch (phase) {
        case "idle":       return "idle";
        case "connecting": return "connecting";
        case "ready":      return "listening";
        case "recording":  return "recording";
        case "processing": return "processing";
        case "speaking":   return "speaking";
        case "error":      return "error";
    }
}

function getControlCopy(state: VoiceControlState): VoiceControlCopy {
    switch (state) {
        case "connecting":
            return { title: "Connecting", detail: "Opening the microphone and joining" };
        case "listening":
            return { title: "Hold to talk", detail: "Press and hold the orb to speak" };
        case "recording":
            return { title: "Listening", detail: "Release when you're done" };
        case "processing":
            return { title: "Thinking", detail: "Friday is working on it" };
        case "speaking":
            return { title: "Speaking", detail: "Hold the orb to interrupt" };
        case "error":
            return { title: "Try again", detail: "Tap and hold to retry" };
        default:
            return { title: "Hold to talk", detail: "Press and hold to start a session" };
    }
}

export function useVoiceAgent(): VoiceAgentState {
    const [phase, setPhase] = useState<VoicePhase>("idle");
    const [error, setError] = useState<string>();
    const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
    const clientRef = useRef<VoiceClient | null>(null);
    const micLevelRef = useRef(0);
    const outputLevelRef = useRef(0);
    const pendingStartRef = useRef(false);

    // Lazily create the client. Listener handles are stable through refs so we
    // don't need to recreate it on rerender.
    useEffect(() => {
        const client = new VoiceClient({
            onPhase: (p) => setPhase(p),
            onError: (m) => setError(m),
            onTranscript: (messages) => setTranscript(messages),
            onMicLevel: (l) => { micLevelRef.current = l; },
            onOutputLevel: (l) => { outputLevelRef.current = l; },
        });
        clientRef.current = client;
        return () => {
            client.disconnect();
            clientRef.current = null;
        };
    }, []);

    const ensureConnected = useCallback(async () => {
        const client = clientRef.current;
        if (!client) return;
        if (phase === "connecting") return;
        if (phase === "idle" || phase === "error") {
            setError(undefined);
            await client.connect();
        }
    }, [phase]);

    const handlePointerDown = useCallback(() => {
        const client = clientRef.current;
        if (!client) return;
        setError(undefined);

        if (phase === "ready" || phase === "speaking" || phase === "processing") {
            void client.startRecording();
            return;
        }
        if (phase === "idle" || phase === "error") {
            pendingStartRef.current = true;
            void ensureConnected();
        }
    }, [phase, ensureConnected]);

    const handlePointerRelease = useCallback(() => {
        const client = clientRef.current;
        if (!client) return;

        // If the press happened before the WS was ready, drop the queued start.
        if (pendingStartRef.current) {
            pendingStartRef.current = false;
            return;
        }
        if (phase === "recording") {
            client.stopRecording();
        }
    }, [phase]);

    // If user pressed while idle, kick off recording once the WS reports ready.
    useEffect(() => {
        if (phase === "ready" && pendingStartRef.current) {
            pendingStartRef.current = false;
            void clientRef.current?.startRecording();
        }
    }, [phase]);

    const endConversation = useCallback(() => {
        pendingStartRef.current = false;
        clientRef.current?.disconnect();
        setError(undefined);
    }, []);

    const controlState = useMemo(() => phaseToControlState(phase), [phase]);
    const copy = useMemo(() => getControlCopy(controlState), [controlState]);
    const trimmed = useMemo(() => transcript.slice(-TRANSCRIPT_LIMIT), [transcript]);

    const getInputVolume = useCallback(() => micLevelRef.current, []);
    const getOutputVolume = useCallback(() => outputLevelRef.current, []);

    const sessionActive =
        phase === "connecting" ||
        phase === "ready" ||
        phase === "recording" ||
        phase === "processing" ||
        phase === "speaking";

    return {
        control: {
            state: controlState,
            copy,
            buttonHandlers: {
                onPointerDown: handlePointerDown,
                onPointerUp: handlePointerRelease,
                onPointerCancel: handlePointerRelease,
                onPointerLeave: handlePointerRelease,
            },
            isConnecting: controlState === "connecting",
            showWave:
                controlState === "listening" ||
                controlState === "recording" ||
                controlState === "processing" ||
                controlState === "speaking",
        },
        sessionActive,
        error,
        transcript: trimmed,
        getInputVolume,
        getOutputVolume,
        endConversation,
    };
}
