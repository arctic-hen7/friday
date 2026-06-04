import type { Route } from "./+types/home";
import { ConversationProvider } from "@elevenlabs/react";
import { useVoiceAgent } from "../voiceAgent";

export function meta({ }: Route.MetaArgs) {
    return [
        { title: "Friday Voice Agent" },
        { name: "description", content: "Friday voice agent gateway and client" },
    ];
}

function VoiceAgent() {
    const { control, conversationId, error, transcript } = useVoiceAgent();

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
                            className={`status-pill status-pill-${control.state}`}
                            aria-label={`Session status: ${control.copy.title}`}
                        >
                            <span />
                            {control.copy.title}
                        </div>
                    </header>

                    <div className="flex flex-1 items-center justify-center py-10">
                        <div className="w-full max-w-sm text-center sm:max-w-md">
                            <div className="relative mx-auto flex aspect-square w-[min(72vw,18rem)] items-center justify-center sm:w-80">
                                <div className={`ambient-ring ambient-ring-${control.state}`} />
                                {control.isConnecting ? <div className="connection-spinner" /> : null}
                                <button
                                    className={`voice-button voice-button-${control.state}`}
                                    type="button"
                                    aria-label={control.copy.detail}
                                    aria-busy={control.isConnecting}
                                    {...control.buttonHandlers}
                                >
                                    <span className="voice-button-content">
                                        <span className="voice-button-title">{control.copy.title}</span>
                                        {control.showWave ? (
                                            <span className={`voice-wave voice-wave-${control.state}`} aria-hidden="true">
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
                                {control.copy.detail}
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
                        {transcript.length === 0 ? (
                            <div className="flex h-full items-center justify-center px-4 text-center text-sm leading-6 text-zinc-500">
                                Transcript appears here after the session starts.
                            </div>
                        ) : (
                            transcript.map(message => (
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
