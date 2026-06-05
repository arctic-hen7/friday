/**
 * Server-side gate that tracks which Speech Engine conversations have been
 * muted by the client. ElevenLabs' SDK currently keeps the LiveKit mic track
 * enabled when "muted" (sends silent frames) which the ASR transcribes as
 * periodic "..." user turns. Until that's fixed upstream, the frontend POSTs
 * /api/mute on mute and /api/unmute on unmute, and `onTranscript` short-circuits
 * for muted conversations so we never round-trip those phantom turns to the LLM.
 *
 * In dev, the React Router routes (mute.ts/unmute.ts) are loaded through Vite's
 * SSR module loader while `speechEngine.ts` is loaded by Node/Bun directly from
 * `index.ts`. Those are two separate module graphs, so a plain `new Set()` at
 * module scope ends up duplicated — the routes write to one, the speech engine
 * reads from the other, and the registry appears to never see a mute. Anchor
 * the set on `globalThis` (keyed by a process-wide Symbol) so both copies of
 * this module share the same underlying state. In production both live in the
 * same bundle, so this is a no-op there.
 */

const REGISTRY_KEY = Symbol.for("friday.muteRegistry");
type RegistryHolder = { [key: symbol]: Set<string> | undefined };
const holder = globalThis as unknown as RegistryHolder;
const muted: Set<string> = holder[REGISTRY_KEY] ?? (holder[REGISTRY_KEY] = new Set<string>());

export function setConversationMuted(conversationId: string, isMuted: boolean): void {
    if (isMuted) muted.add(conversationId);
    else muted.delete(conversationId);
}

export function isConversationMuted(conversationId: string): boolean {
    return muted.has(conversationId);
}
