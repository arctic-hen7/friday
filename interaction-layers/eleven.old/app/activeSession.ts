// Singleton holding the session id chosen by the user in the picker UI.
// The Speech Engine WS handler reads this when a new Eleven conversation
// connects, so the orchestrator attachment uses the right session.
//
// Single-user assumption: only one Eleven conversation runs at a time. If we
// later need multiple, key this by some per-conversation identifier supplied
// in the conversation token request.
//
// Anchored on globalThis so dev-mode (Vite SSR + Bun) module-graph splits
// don't end up with two copies of the singleton, matching the muteRegistry
// pattern that was already in the gateway.

const KEY = Symbol.for("friday.activeSession");
type Holder = { [k: symbol]: { current: string | null } | undefined };
const h = globalThis as unknown as Holder;
const slot = h[KEY] ?? (h[KEY] = { current: null });

export function getActiveSessionId(): string | null {
    return slot.current;
}

export function setActiveSessionId(id: string | null): void {
    slot.current = id;
}
