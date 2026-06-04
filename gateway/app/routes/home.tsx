import type { Route } from "./+types/home";
import { useMemo, useState } from "react";
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

type MessagePayload = {
    message: string;
    event_id?: number;
    role: "user" | "agent";
};

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

function statusLabel(status: ConversationStatus) {
    switch (status) {
        case "connected":
            return "Live";
        case "connecting":
            return "Connecting";
        case "error":
            return "Error";
        default:
            return "Idle";
    }
}

function VoiceAgent() {
    const [messages, setMessages] = useState<TranscriptMessage[]>([]);
    const [error, setError] = useState<string>();
    const [conversationId, setConversationId] = useState<string>();

    const conversation = useConversation({
        onConnect: ({ conversationId }) => {
            setConversationId(conversationId);
            setError(undefined);
        },
        onDisconnect: () => {
            setConversationId(undefined);
        },
        onError: message => {
            setError(message);
        },
        onMessage: (payload: MessagePayload) => {
            setMessages(current => [
                ...current,
                {
                    id: `${payload.event_id ?? current.length}-${payload.role}-${Date.now()}`,
                    role: payload.role === "agent" ? "agent" : "user",
                    message: payload.message,
                },
            ]);
        },
    });

    const isActive = conversation.status === "connected" || conversation.status === "connecting";
    const status = useMemo(() => statusLabel(conversation.status), [conversation.status]);

    async function startConversation() {
        try {
            setError(undefined);
            await requestMicrophoneAccess();
            const token = await getConversationToken();

            conversation.startSession({
                conversationToken: token,
                connectionType: "webrtc",
            });
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
        }
    }

    return (
        <main className="min-h-svh bg-zinc-950 text-zinc-100">
            <section className="mx-auto flex min-h-svh w-full max-w-5xl flex-col px-5 py-5 sm:px-8">
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-4">
                    <div>
                        <p className="text-sm font-medium text-emerald-300">Speech Engine prototype</p>
                        <h1 className="mt-1 text-2xl font-semibold tracking-normal text-white sm:text-3xl">
                            Friday voice agent
                        </h1>
                    </div>
                    <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
                        <span
                            className={`h-2.5 w-2.5 rounded-full ${conversation.status === "connected" ? "bg-emerald-400" : "bg-zinc-500"
                                }`}
                        />
                        {status}
                    </div>
                </header>

                <div className="grid flex-1 gap-5 py-5 lg:grid-cols-[1fr_18rem]">
                    <section className="flex min-h-[28rem] flex-col rounded-md border border-zinc-800 bg-zinc-900/70">
                        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                            <h2 className="text-sm font-semibold text-zinc-200">Conversation</h2>
                            {conversationId ? (
                                <span className="max-w-56 truncate font-mono text-xs text-zinc-500">
                                    {conversationId}
                                </span>
                            ) : null}
                        </div>

                        <div className="flex-1 space-y-3 overflow-y-auto p-4">
                            {messages.length === 0 ? (
                                <div className="flex h-full min-h-80 items-center justify-center text-center text-sm text-zinc-500">
                                    Press start and speak when the browser asks for microphone access.
                                </div>
                            ) : (
                                messages.map(message => (
                                    <article
                                        key={message.id}
                                        className={`max-w-[82%] rounded-md px-3 py-2 text-sm leading-6 ${message.role === "user"
                                                ? "ml-auto bg-emerald-500 text-zinc-950"
                                                : "bg-zinc-800 text-zinc-100"
                                            }`}
                                    >
                                        {message.message}
                                    </article>
                                ))
                            )}
                        </div>

                        {error ? (
                            <div className="border-t border-red-950 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                                {error}
                            </div>
                        ) : null}
                    </section>

                    <aside className="flex flex-col gap-3 rounded-md border border-zinc-800 bg-zinc-900/70 p-4">
                        <button
                            className="rounded-md bg-emerald-400 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                            disabled={isActive}
                            type="button"
                            onClick={startConversation}
                        >
                            Start
                        </button>
                        <button
                            className="rounded-md border border-zinc-700 px-4 py-3 text-sm font-semibold text-zinc-100 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-500"
                            disabled={!isActive}
                            type="button"
                            onClick={() => conversation.endSession()}
                        >
                            End
                        </button>
                        <button
                            className="rounded-md border border-zinc-700 px-4 py-3 text-sm font-semibold text-zinc-100 transition hover:bg-zinc-800"
                            type="button"
                            onClick={() => conversation.setMuted(!conversation.isMuted)}
                        >
                            {conversation.isMuted ? "Unmute mic" : "Mute mic"}
                        </button>

                        <div className="mt-2 rounded-md bg-zinc-950 p-3 text-sm text-zinc-400">
                            <div className="flex justify-between gap-3">
                                <span>Mode</span>
                                <span className="font-medium text-zinc-200">{conversation.mode}</span>
                            </div>
                            <div className="mt-2 flex justify-between gap-3">
                                <span>Gateway</span>
                                <span className="truncate font-mono text-xs text-zinc-300">Same origin</span>
                            </div>
                        </div>
                    </aside>
                </div>
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
