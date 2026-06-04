import type { Route } from "./+types/home";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";

export function meta({ }: Route.MetaArgs) {
    return [
        { title: "Friday Voice Agent" },
        { name: "description", content: "Friday voice agent gateway and client" },
    ];
}

type TranscriptMessage = {
    id: string;
    role: "user" | "agent";
    message: string;
};

type ConversationStatus = "disconnected" | "connecting" | "connected" | "error";
type ControlState = "idle" | "connecting" | "listening" | "processing" | "speaking" | "muted" | "error";

type MessagePayload = {
    message: string;
    event_id?: number;
    role: "user" | "agent";
};

type VadScorePayload = {
    vadScore: number;
};

const VAD_SPEECH_THRESHOLD = 0.45;
const VAD_SILENCE_THRESHOLD = 0.2;
const VAD_PROCESSING_DELAY_MS = 450;

async function requestMicrophoneAccess() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    for (const track of stream.getTracks()) {
        track.stop();
    }
}

async function getConversationToken() {
    const response = await fetch("/api/conversation-token", {
        method: "POST",
    });

    if (!response.ok) {
        throw new Error("Could not create an ElevenLabs conversation token");
    }

    const data = (await response.json()) as { token?: string };

    if (!data.token) {
        throw new Error("Gateway did not return a conversation token");
    }

    return data.token;
}

function getErrorMessage(error: unknown) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
        return "Microphone permission was denied. Allow microphone access in your browser settings and try again.";
    }

    if (error instanceof DOMException && error.name === "NotFoundError") {
        return "No microphone was found. Connect a microphone and try again.";
    }

    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function getControlState(
    status: ConversationStatus,
    isMuted: boolean,
    isSpeaking: boolean,
    isProcessing: boolean,
): ControlState {
    if (status === "connecting") {
        return "connecting";
    }

    if (status === "error") {
        return "error";
    }

    if (status !== "connected") {
        return "idle";
    }

    if (isMuted) {
        return "muted";
    }

    if (isSpeaking) {
        return "speaking";
    }

    if (isProcessing) {
        return "processing";
    }

    return "listening";
}

function controlCopy(controlState: ControlState) {
    switch (controlState) {
        case "connecting":
            return {
                title: "Connecting",
                detail: "Opening the microphone and joining the voice session",
            };
        case "listening":
            return {
                title: "Listening",
                detail: "Tap to mute. Hold to end.",
            };
        case "processing":
            return {
                title: "Processing",
                detail: "Friday is working on your last message",
            };
        case "speaking":
            return {
                title: "Speaking",
                detail: "Cut in anytime. Tap to mute, hold to end.",
            };
        case "muted":
            return {
                title: "Muted",
                detail: "Tap to unmute. Hold to end.",
            };
        case "error":
            return {
                title: "Try again",
                detail: "Tap after fixing the issue below",
            };
        default:
            return {
                title: "Start",
                detail: "Tap to talk with Friday",
            };
    }
}

function VoiceAgent() {
    const [messages, setMessages] = useState<TranscriptMessage[]>([]);
    const [error, setError] = useState<string>();
    const [conversationId, setConversationId] = useState<string>();
    const [isProcessing, setIsProcessing] = useState(false);
    const heardSpeechRef = useRef(false);
    const pressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const processingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const longPressTriggeredRef = useRef(false);

    function clearProcessingTimer() {
        if (processingTimerRef.current) {
            clearTimeout(processingTimerRef.current);
            processingTimerRef.current = undefined;
        }
    }

    function resetProcessingState() {
        clearProcessingTimer();
        heardSpeechRef.current = false;
        setIsProcessing(false);
    }

    const conversation = useConversation({
        onConnect: ({ conversationId }) => {
            setConversationId(conversationId);
            setError(undefined);
            resetProcessingState();
        },
        onDisconnect: () => {
            setConversationId(undefined);
            resetProcessingState();
        },
        onError: message => {
            setError(message);
            resetProcessingState();
        },
        onMessage: (payload: MessagePayload) => {
            if (payload.role === "agent") {
                setIsProcessing(false);
            }

            setMessages(current => [
                ...current,
                {
                    id: `${payload.event_id ?? current.length}-${payload.role}-${Date.now()}`,
                    role: payload.role === "agent" ? "agent" : "user",
                    message: payload.message,
                },
            ]);
        },
        onModeChange: ({ mode }) => {
            if (mode === "speaking") {
                setIsProcessing(false);
            }
        },
        onInterruption: () => {
            resetProcessingState();
        },
        onVadScore: ({ vadScore }: VadScorePayload) => {
            if (vadScore >= VAD_SPEECH_THRESHOLD) {
                clearProcessingTimer();
                heardSpeechRef.current = true;
                setIsProcessing(false);
                return;
            }

            if (!heardSpeechRef.current) {
                return;
            }

            if (vadScore > VAD_SILENCE_THRESHOLD) {
                clearProcessingTimer();
                return;
            }

            if (processingTimerRef.current || isProcessing) {
                return;
            }

            processingTimerRef.current = setTimeout(() => {
                processingTimerRef.current = undefined;
                setIsProcessing(true);
            }, VAD_PROCESSING_DELAY_MS);
        },
    });

    useEffect(() => {
        if (conversation.status !== "connected" || conversation.isMuted || conversation.isSpeaking) {
            resetProcessingState();
        }
    }, [conversation.isMuted, conversation.isSpeaking, conversation.status]);

    useEffect(() => {
        return () => {
            clearLongPressTimer();
            clearProcessingTimer();
        };
    }, []);

    const controlState = useMemo(
        () => getControlState(conversation.status, conversation.isMuted, conversation.isSpeaking, isProcessing),
        [conversation.isMuted, conversation.isSpeaking, conversation.status, isProcessing],
    );
    const copy = useMemo(() => controlCopy(controlState), [controlState]);
    const transcriptMessages = useMemo(() => messages.slice(-18), [messages]);

    async function startConversation() {
        try {
            setError(undefined);
            resetProcessingState();
            await requestMicrophoneAccess();
            const token = await getConversationToken();

            conversation.startSession({
                conversationToken: token,
                connectionType: "webrtc",
            });
        } catch (error) {
            setError(getErrorMessage(error));
        }
    }

    function endConversation() {
        setError(undefined);
        resetProcessingState();
        conversation.endSession();
    }

    function handlePrimaryAction() {
        if (conversation.status === "connecting") {
            return;
        }

        if (conversation.status !== "connected") {
            void startConversation();
            return;
        }

        conversation.setMuted(!conversation.isMuted);
    }

    function clearLongPressTimer() {
        if (pressTimerRef.current) {
            clearTimeout(pressTimerRef.current);
            pressTimerRef.current = undefined;
        }
    }

    function handlePointerDown() {
        if (conversation.status !== "connected") {
            return;
        }

        clearLongPressTimer();
        longPressTriggeredRef.current = false;

        pressTimerRef.current = setTimeout(() => {
            longPressTriggeredRef.current = true;
            navigator.vibrate?.(35);
            endConversation();
        }, 850);
    }

    function handlePointerRelease() {
        clearLongPressTimer();
    }

    function handleClick() {
        if (longPressTriggeredRef.current) {
            longPressTriggeredRef.current = false;
            return;
        }

        handlePrimaryAction();
    }

    return (
        <main className="min-h-svh overflow-hidden bg-[#090b0d] text-zinc-100">
            <section className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_23rem]">
                <div className="relative flex min-h-svh flex-col px-5 py-5 sm:px-8 lg:px-12">
                    <header className="flex items-center justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-300">
                                Friday
                            </p>
                            <h1 className="mt-2 text-xl font-semibold text-white sm:text-2xl">
                                Voice gateway
                            </h1>
                        </div>
                        <div
                            className={`status-pill status-pill-${controlState}`}
                            aria-label={`Session status: ${copy.title}`}
                        >
                            <span />
                            {copy.title}
                        </div>
                    </header>

                    <div className="flex flex-1 items-center justify-center py-10">
                        <div className="w-full max-w-sm text-center sm:max-w-md">
                            <div className="relative mx-auto flex aspect-square w-[min(72vw,18rem)] items-center justify-center sm:w-80">
                                <div className={`ambient-ring ambient-ring-${controlState}`} />
                                {controlState === "connecting" ? <div className="connection-spinner" /> : null}
                                <button
                                    className={`voice-button voice-button-${controlState}`}
                                    type="button"
                                    aria-label={copy.detail}
                                    aria-busy={controlState === "connecting"}
                                    onClick={handleClick}
                                    onPointerCancel={handlePointerRelease}
                                    onPointerDown={handlePointerDown}
                                    onPointerLeave={handlePointerRelease}
                                    onPointerUp={handlePointerRelease}
                                >
                                    <span className="voice-button-content">
                                        <span className="voice-button-title">{copy.title}</span>
                                        {controlState === "listening" || controlState === "processing" || controlState === "speaking" ? (
                                            <span className={`voice-wave voice-wave-${controlState}`} aria-hidden="true">
                                                <span />
                                                <span />
                                                <span />
                                                <span />
                                                <span />
                                            </span>
                                        ) : null}
                                    </span>
                                </button>
                            </div>

                            <p className="mx-auto mt-6 min-h-12 max-w-xs text-balance text-sm leading-6 text-zinc-400 sm:max-w-sm">
                                {copy.detail}
                            </p>

                            {error ? (
                                <div className="mx-auto mt-4 max-w-sm rounded-md border border-red-500/30 bg-red-950/70 px-4 py-3 text-left text-sm leading-6 text-red-100">
                                    {error}
                                </div>
                            ) : null}

                            {conversationId ? (
                                <p className="mx-auto mt-4 max-w-xs truncate font-mono text-[0.7rem] text-zinc-600 sm:max-w-sm">
                                    {conversationId}
                                </p>
                            ) : null}
                        </div>
                    </div>
                </div>

                <aside className="hidden min-h-svh border-l border-white/10 bg-[#101318] lg:flex lg:flex-col">
                    <div className="border-b border-white/10 px-5 py-5">
                        <h2 className="text-sm font-semibold text-white">Transcript</h2>
                        <p className="mt-1 text-xs text-zinc-500">Desktop session view</p>
                    </div>

                    <div className="flex-1 space-y-3 overflow-y-auto px-4 py-5">
                        {transcriptMessages.length === 0 ? (
                            <div className="flex h-full items-center justify-center px-4 text-center text-sm leading-6 text-zinc-500">
                                Transcript appears here after the session starts.
                            </div>
                        ) : (
                            transcriptMessages.map(message => (
                                <article
                                    key={message.id}
                                    className={`rounded-md px-3 py-2 text-sm leading-6 ${
                                        message.role === "user"
                                            ? "ml-8 bg-emerald-400 text-zinc-950"
                                            : "mr-8 bg-zinc-800 text-zinc-100"
                                    }`}
                                >
                                    <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-[0.16em] opacity-70">
                                        {message.role === "user" ? "You" : "Friday"}
                                    </p>
                                    {message.message}
                                </article>
                            ))
                        )}
                    </div>
                </aside>
            </section>
        </main>
    );
}

export default function Home() {
    return (
        <ConversationProvider>
            <VoiceAgent />
        </ConversationProvider>
    );
}
