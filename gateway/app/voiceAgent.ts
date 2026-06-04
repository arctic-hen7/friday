import { useConversation } from "@elevenlabs/react";
import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes } from "react";

export type TranscriptMessage = {
    id: string;
    role: "user" | "agent";
    message: string;
};

export type VoiceControlState =
    | "idle"
    | "connecting"
    | "listening"
    | "processing"
    | "speaking"
    | "muted"
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
        "onClick" | "onPointerCancel" | "onPointerDown" | "onPointerLeave" | "onPointerUp"
    >;
    isConnecting: boolean;
    showWave: boolean;
};

export type VoiceAgentState = {
    control: VoiceControl;
    conversationId?: string;
    error?: string;
    transcript: TranscriptMessage[];
};

type ConversationStatus = "disconnected" | "connecting" | "connected" | "error";

type MessagePayload = {
    message: string;
    event_id?: number;
    role: "user" | "agent";
};

type VadScorePayload = {
    vadScore: number;
};

const TRANSCRIPT_LIMIT = 18;
const LONG_PRESS_END_DELAY_MS = 850;
const HAPTIC_END_PULSE_MS = 35;
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
): VoiceControlState {
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

function getControlCopy(controlState: VoiceControlState): VoiceControlCopy {
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

export function useVoiceAgent(): VoiceAgentState {
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
    const copy = useMemo(() => getControlCopy(controlState), [controlState]);
    const transcript = useMemo(() => messages.slice(-TRANSCRIPT_LIMIT), [messages]);

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
            navigator.vibrate?.(HAPTIC_END_PULSE_MS);
            endConversation();
        }, LONG_PRESS_END_DELAY_MS);
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

    return {
        control: {
            state: controlState,
            copy,
            buttonHandlers: {
                onClick: handleClick,
                onPointerCancel: handlePointerRelease,
                onPointerDown: handlePointerDown,
                onPointerLeave: handlePointerRelease,
                onPointerUp: handlePointerRelease,
            },
            isConnecting: controlState === "connecting",
            showWave: controlState === "listening" || controlState === "processing" || controlState === "speaking",
        },
        conversationId,
        error,
        transcript,
    };
}
