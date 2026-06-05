import { useEffect, useState } from "react";

type Session = {
    id: string;
    label: string;
    lastActiveAt: string;
    attached: boolean;
};

type State =
    | { phase: "loading" }
    | { phase: "ready"; sessions: Session[] }
    | { phase: "error"; message: string };

export function useActiveSession() {
    const [active, setActive] = useState<string | null>(null);
    const [resolved, setResolved] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch("/api/select-session")
            .then(r => r.json())
            .then((d: { sessionId: string | null }) => {
                if (cancelled) return;
                setActive(d.sessionId);
                setResolved(true);
            })
            .catch(() => { if (!cancelled) setResolved(true); });
        return () => { cancelled = true; };
    }, []);

    async function set(id: string | null) {
        await fetch("/api/select-session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: id }),
        });
        setActive(id);
    }

    return { active, resolved, set };
}

export function SessionPicker({ onPicked }: { onPicked: (id: string) => void }) {
    const [state, setState] = useState<State>({ phase: "loading" });
    const [creating, setCreating] = useState(false);
    const [newLabel, setNewLabel] = useState("");

    async function refresh() {
        setState({ phase: "loading" });
        try {
            const res = await fetch("/api/sessions");
            if (!res.ok) throw new Error(`/sessions returned ${res.status}`);
            const sessions = (await res.json()) as Session[];
            setState({ phase: "ready", sessions });
        } catch (err) {
            setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
        }
    }

    useEffect(() => { void refresh(); }, []);

    async function pick(id: string) {
        await fetch("/api/select-session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: id }),
        });
        onPicked(id);
    }

    async function create() {
        setCreating(true);
        try {
            const res = await fetch("/api/sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ label: newLabel.trim() || `Voice ${new Date().toLocaleString()}` }),
            });
            if (!res.ok) throw new Error(`create returned ${res.status}`);
            const row = (await res.json()) as Session;
            await pick(row.id);
        } catch (err) {
            setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
        } finally {
            setCreating(false);
            setNewLabel("");
        }
    }

    return (
        <div className="session-picker-overlay">
            <div className="session-picker">
                <h2>Pick a session</h2>
                {state.phase === "loading" && <p className="muted">Loading…</p>}
                {state.phase === "error" && (
                    <div>
                        <p className="error">Couldn't reach the orchestrator: {state.message}</p>
                        <button onClick={() => void refresh()}>Retry</button>
                    </div>
                )}
                {state.phase === "ready" && (
                    <>
                        <div className="session-list">
                            {state.sessions.length === 0 ? (
                                <p className="muted">No sessions yet — create one below.</p>
                            ) : (
                                state.sessions.map(s => (
                                    <button
                                        key={s.id}
                                        className="session-row"
                                        disabled={s.attached}
                                        onClick={() => void pick(s.id)}
                                        title={s.attached ? "Currently in use elsewhere" : ""}
                                    >
                                        <div className="session-label">{s.label}</div>
                                        <div className="session-meta">
                                            {s.attached ? "in use" : `last active ${new Date(s.lastActiveAt).toLocaleString()}`}
                                        </div>
                                    </button>
                                ))
                            )}
                        </div>
                        <div className="session-create">
                            <input
                                type="text"
                                placeholder="New session label (optional)"
                                value={newLabel}
                                onChange={e => setNewLabel(e.target.value)}
                                disabled={creating}
                            />
                            <button onClick={() => void create()} disabled={creating}>
                                {creating ? "Creating…" : "New session"}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
