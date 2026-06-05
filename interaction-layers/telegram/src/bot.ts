// Per-chat Telegram <-> Friday orchestrator bridge.
//
// Each authorised Telegram chat can attach to at most one Friday session at a
// time. While attached, plain text messages from the user become orchestrator
// `user_message`s; assistant chunks are buffered until the orchestrator signals
// `final: true`, then posted as one Telegram message (split only if the result
// overflows Telegram's hard size cap). Proactive turns work the same way.
//
// Telegram is treated as always-deliverable for the orchestrator's purposes —
// the inbox handles offline gaps, so we don't try to model presence here.

import { WebSocket } from "ws";
import {
    attachSession,
    createSession,
    deleteSession,
    listSessions,
    orchestratorWsUrl,
    type SessionSummary,
} from "./orchestrator";
import {
    TelegramClient,
    TelegramError,
    type TgMessage,
} from "./telegram";

const SYSTEM_PROMPT_FRAGMENT = `You are speaking to the user via Telegram text chat.
- Replies are rendered as plain Telegram messages — keep them concise and conversational.
- Do not use Markdown, HTML, code fences, tables, or other rich formatting; Telegram will show the raw characters.
- Lists are fine when genuinely useful; prefer short prose otherwise.
- Never reference visual or voice elements — this is a text chat.`;

// Telegram caps text messages at 4096 chars. Stay a little under so we never
// surprise the API with a borderline payload.
const TG_MAX_TEXT = 4000;

// Server -> client wire types from the orchestrator.
type OrchestratorMsg =
    | { type: "assistant_chunk"; turnId: string; text: string; final: boolean }
    | { type: "assistant_proactive"; turnId: string; text: string; final: boolean }
    | { type: "session_info"; sessionId: string; label: string; timezone: string }
    | { type: "error"; message: string };

type StreamingTurn = {
    turnId: string;
    isProactive: boolean;
    // Accumulated chunks. Held until the orchestrator says `final: true`, then
    // flushed as a single Telegram message (or split on whitespace if the
    // accumulated text exceeds TG_MAX_TEXT).
    buffer: string;
};

type ChatState = {
    chatId: number;
    sessionId: string | null;
    sessionLabel: string | null;
    ws: WebSocket | null;
    wsReady: boolean;
    turn: StreamingTurn | null;
};

export class TelegramBot {
    private readonly tg: TelegramClient;
    private readonly allowedChatIds: Set<number>;
    private readonly chats = new Map<number, ChatState>();
    private updateOffset = 0;
    private stopping = false;
    private me: { id: number; username?: string } | null = null;

    constructor(opts: { token: string; allowedChatIds: number[] }) {
        this.tg = new TelegramClient(opts.token);
        this.allowedChatIds = new Set(opts.allowedChatIds);
    }

    async start(): Promise<void> {
        this.me = await this.tg.getMe();
        console.log(
            `[telegram] logged in as @${this.me.username ?? "?"} (id=${this.me.id})`,
        );

        await this.tg.setMyCommands([
            { command: "help", description: "Show available commands" },
            { command: "sessions", description: "List all sessions" },
            { command: "new", description: "Create a new session: /new [label]" },
            { command: "attach", description: "Attach to a session: /attach <id-or-prefix>" },
            { command: "detach", description: "Detach from the current session" },
            { command: "current", description: "Show the currently attached session" },
            { command: "delete", description: "Delete a session: /delete <id-or-prefix>" },
        ]).catch((err: unknown) => {
            console.warn("[telegram] setMyCommands failed:", err);
        });

        await this.pollLoop();
    }

    stop(): void {
        this.stopping = true;
        for (const chat of this.chats.values()) {
            this.closeWs(chat, "shutdown");
        }
    }

    // ---------- long-poll loop ----------

    private async pollLoop(): Promise<void> {
        while (!this.stopping) {
            try {
                const updates = await this.tg.getUpdates({
                    offset: this.updateOffset,
                    timeout: 30,
                });
                for (const update of updates) {
                    this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
                    if (update.message) {
                        await this.handleMessage(update.message).catch((err) => {
                            console.error("[telegram] message handler failed:", err);
                        });
                    }
                }
            } catch (err) {
                if (this.stopping) return;
                if (err instanceof TelegramError && err.retryAfter) {
                    console.warn(`[telegram] flood-wait ${err.retryAfter}s`);
                    await sleep(err.retryAfter * 1000);
                    continue;
                }
                console.error("[telegram] getUpdates failed:", err);
                await sleep(2000);
            }
        }
    }

    // ---------- inbound Telegram messages ----------

    private async handleMessage(msg: TgMessage): Promise<void> {
        const chatId = msg.chat.id;
        if (!this.allowedChatIds.has(chatId)) {
            // Print prominently — when the operator is bootstrapping with an
            // empty allow-list, this is exactly the line they're looking for.
            console.log(
                `[telegram] message from unauthorised chat id=${chatId} ` +
                `user=@${msg.from?.username ?? "?"} — add this id to ` +
                `TELEGRAM_ALLOWED_CHAT_IDS and restart to enable it.`,
            );
            await this.tg.sendMessage({
                chatId,
                text: `This Friday bot is locked. Your chat id is ${chatId} — ` +
                    `add it to TELEGRAM_ALLOWED_CHAT_IDS and restart the bot.`,
            }).catch(() => { /* ignore — they may have blocked us */ });
            return;
        }

        const text = msg.text?.trim();
        if (!text) return;

        const chat = this.ensureChat(chatId);

        if (text.startsWith("/")) {
            await this.handleCommand(chat, text);
            return;
        }

        await this.handleUserText(chat, text);
    }

    private ensureChat(chatId: number): ChatState {
        let chat = this.chats.get(chatId);
        if (!chat) {
            chat = {
                chatId,
                sessionId: null,
                sessionLabel: null,
                ws: null,
                wsReady: false,
                turn: null,
            };
            this.chats.set(chatId, chat);
        }
        return chat;
    }

    // ---------- slash command dispatch ----------

    private async handleCommand(chat: ChatState, raw: string): Promise<void> {
        // Strip a trailing @botname suffix Telegram appends in group chats.
        const [head, ...rest] = raw.split(/\s+/);
        const cmd = head!.split("@")[0]!.toLowerCase();
        const args = rest.join(" ").trim();

        switch (cmd) {
            case "/start":
            case "/help":
                await this.cmdHelp(chat);
                return;
            case "/sessions":
                await this.cmdSessions(chat);
                return;
            case "/new":
                await this.cmdNew(chat, args);
                return;
            case "/attach":
                await this.cmdAttach(chat, args);
                return;
            case "/detach":
                await this.cmdDetach(chat);
                return;
            case "/current":
                await this.cmdCurrent(chat);
                return;
            case "/delete":
                await this.cmdDelete(chat, args);
                return;
            default:
                await this.reply(chat, `Unknown command ${cmd}. Try /help.`);
                return;
        }
    }

    private async cmdHelp(chat: ChatState): Promise<void> {
        await this.reply(
            chat,
            [
                "Friday — Telegram interaction layer.",
                "",
                "/sessions — list sessions",
                "/new [label] — create a new session (label optional)",
                "/attach <id-or-prefix> — attach to a session",
                "/detach — release the current session",
                "/current — show the attached session",
                "/delete <id-or-prefix> — delete a session",
                "",
                "Any other message is sent to the attached session as a user message.",
            ].join("\n"),
        );
    }

    private async cmdSessions(chat: ChatState): Promise<void> {
        let rows: SessionSummary[];
        try {
            rows = await listSessions();
        } catch (err) {
            await this.reply(chat, `Could not reach the orchestrator: ${errMsg(err)}`);
            return;
        }
        if (rows.length === 0) {
            await this.reply(chat, "No sessions yet. Use /new <label> to create one.");
            return;
        }
        const lines = rows.map((r) => {
            const mark = r.id === chat.sessionId ? " (attached here)" : r.attached ? " (busy)" : "";
            return `• ${shortId(r.id)} — ${r.label}${mark}`;
        });
        await this.reply(chat, ["Sessions:", ...lines].join("\n"));
    }

    private async cmdNew(chat: ChatState, label: string): Promise<void> {
        const trimmed = label.trim() || defaultSessionLabel();

        // Full cleanup of whatever was attached here: drop the WS, then
        // delete the session server-side. Doing the delete after the close
        // lets the orchestrator tear down its live state cleanly.
        const previousId = chat.sessionId;
        const previousLabel = chat.sessionLabel;
        if (previousId) {
            this.closeWs(chat, "new_session");
            try {
                await deleteSession(previousId);
            } catch (err) {
                await this.reply(
                    chat,
                    `Could not create a new session: failed to delete previous session ` +
                    `${shortId(previousId)} — ${errMsg(err)}`,
                );
                return;
            }
        }

        let row: SessionSummary;
        try {
            row = await createSession(trimmed);
        } catch (err) {
            await this.reply(chat, `Failed to create session: ${errMsg(err)}`);
            return;
        }

        const prefix = previousId
            ? `Deleted previous session ${shortId(previousId)} (${previousLabel ?? "?"}). `
            : "";

        // Auto-attach so the user can start talking immediately.
        try {
            const token = await attachSession(row.id, SYSTEM_PROMPT_FRAGMENT);
            this.openWs(chat, row, token);
            await this.reply(
                chat,
                `${prefix}Created and attached to ${row.label} (${shortId(row.id)}).`,
            );
        } catch (err) {
            // Session exists but attach failed — leave it for /attach later.
            await this.reply(
                chat,
                `${prefix}Created session ${shortId(row.id)} — ${row.label}, but attach failed: ` +
                `${errMsg(err)}. Use /attach ${shortId(row.id)} to retry.`,
            );
        }
    }

    private async cmdAttach(chat: ChatState, arg: string): Promise<void> {
        const needle = arg.trim();
        if (!needle) {
            await this.reply(chat, "Usage: /attach <id-or-prefix>");
            return;
        }

        let rows: SessionSummary[];
        try {
            rows = await listSessions();
        } catch (err) {
            await this.reply(chat, `Could not reach the orchestrator: ${errMsg(err)}`);
            return;
        }
        const matches = rows.filter((r) => r.id.startsWith(needle));
        if (matches.length === 0) {
            await this.reply(chat, `No session matches "${needle}".`);
            return;
        }
        if (matches.length > 1) {
            await this.reply(
                chat,
                [
                    `Ambiguous prefix "${needle}" matches:`,
                    ...matches.map((r) => `• ${shortId(r.id)} — ${r.label}`),
                ].join("\n"),
            );
            return;
        }
        const target = matches[0]!;

        if (chat.sessionId === target.id && chat.wsReady) {
            await this.reply(chat, `Already attached to ${target.label}.`);
            return;
        }

        // Drop any existing attachment first.
        if (chat.ws) this.closeWs(chat, "reattach");

        try {
            const token = await attachSession(target.id, SYSTEM_PROMPT_FRAGMENT);
            this.openWs(chat, target, token);
            await this.reply(chat, `Attached to ${target.label} (${shortId(target.id)}).`);
        } catch (err) {
            const msg = errMsg(err);
            if (msg === "session_busy") {
                await this.reply(chat, "That session is already attached to another client.");
            } else if (msg === "session_not_found") {
                await this.reply(chat, "That session no longer exists.");
            } else {
                await this.reply(chat, `Attach failed: ${msg}`);
            }
        }
    }

    private async cmdDetach(chat: ChatState): Promise<void> {
        if (!chat.sessionId) {
            await this.reply(chat, "Not attached to any session.");
            return;
        }
        const label = chat.sessionLabel ?? shortId(chat.sessionId);
        this.closeWs(chat, "user_detach");
        await this.reply(chat, `Detached from ${label}.`);
    }

    private async cmdCurrent(chat: ChatState): Promise<void> {
        if (!chat.sessionId) {
            await this.reply(chat, "Not attached to any session. Use /attach <id> to pick one.");
            return;
        }
        const ready = chat.wsReady ? "ready" : "connecting…";
        await this.reply(
            chat,
            `Attached to ${chat.sessionLabel ?? "(unknown)"} (${shortId(chat.sessionId)}) — ${ready}.`,
        );
    }

    private async cmdDelete(chat: ChatState, arg: string): Promise<void> {
        const needle = arg.trim();
        if (!needle) {
            await this.reply(chat, "Usage: /delete <id-or-prefix>");
            return;
        }
        let rows: SessionSummary[];
        try {
            rows = await listSessions();
        } catch (err) {
            await this.reply(chat, `Could not reach the orchestrator: ${errMsg(err)}`);
            return;
        }
        const matches = rows.filter((r) => r.id.startsWith(needle));
        if (matches.length === 0) {
            await this.reply(chat, `No session matches "${needle}".`);
            return;
        }
        if (matches.length > 1) {
            await this.reply(
                chat,
                [
                    `Ambiguous prefix "${needle}" matches:`,
                    ...matches.map((r) => `• ${shortId(r.id)} — ${r.label}`),
                ].join("\n"),
            );
            return;
        }
        const target = matches[0]!;

        // If we have it attached, clean up locally before issuing the delete.
        if (chat.sessionId === target.id) this.closeWs(chat, "session_deleted");

        try {
            await deleteSession(target.id);
            await this.reply(chat, `Deleted ${target.label} (${shortId(target.id)}).`);
        } catch (err) {
            await this.reply(chat, `Delete failed: ${errMsg(err)}`);
        }
    }

    // ---------- plain user text -> orchestrator ----------

    private async handleUserText(chat: ChatState, text: string): Promise<void> {
        if (!chat.sessionId) {
            await this.reply(
                chat,
                "No session attached. Use /sessions to list, /attach <id> to pick one, or /new <label> to create one.",
            );
            return;
        }
        if (!chat.ws || !chat.wsReady) {
            await this.reply(chat, "Reconnecting to the orchestrator — try again in a moment.");
            return;
        }

        // A new user message implicitly aborts any in-flight turn the user
        // didn't wait out. The orchestrator records markers as appropriate.
        // Any buffered partial output is discarded — we never half-deliver.
        if (chat.turn) {
            this.sendWs(chat, { type: "abort", turnId: chat.turn.turnId, reason: "user_message" });
            chat.turn = null;
        }

        this.sendWs(chat, { type: "user_message", text });
        // Telegram chat action gives a quick "typing…" hint while we wait.
        this.tg.sendChatAction({ chatId: chat.chatId, action: "typing" }).catch(() => {
            /* best-effort */
        });
    }

    // ---------- orchestrator WS wiring ----------

    private openWs(chat: ChatState, target: SessionSummary, token: string): void {
        const ws = new WebSocket(orchestratorWsUrl(token));
        chat.ws = ws;
        chat.wsReady = false;
        chat.sessionId = target.id;
        chat.sessionLabel = target.label;

        ws.on("open", () => {
            chat.wsReady = true;
            // Telegram-style ILs are always deliverable: the inbox already
            // covers offline gaps for us.
            this.sendWs(chat, { type: "deliverability", deliverable: true });
            console.log(
                `[telegram] chat ${chat.chatId} attached to session ${target.id} (${target.label})`,
            );
        });

        ws.on("message", (raw) => {
            let msg: OrchestratorMsg;
            try {
                msg = JSON.parse(raw.toString()) as OrchestratorMsg;
            } catch {
                return;
            }
            void this.handleOrchestratorMsg(chat, msg);
        });

        ws.on("close", () => {
            if (chat.ws !== ws) return;
            const wasAttached = chat.sessionId;
            chat.ws = null;
            chat.wsReady = false;
            chat.turn = null;
            // Only surface the disconnect if the user hadn't asked for it.
            if (wasAttached && !this.stopping) {
                console.warn(
                    `[telegram] orchestrator WS closed for chat ${chat.chatId} (session=${wasAttached})`,
                );
                chat.sessionId = null;
                chat.sessionLabel = null;
                this.tg.sendMessage({
                    chatId: chat.chatId,
                    text: "Orchestrator connection dropped. Use /attach to reconnect.",
                }).catch(() => { /* ignore */ });
            }
        });

        ws.on("error", (err) => {
            console.error(`[telegram] orchestrator WS error (chat=${chat.chatId}):`, err);
        });
    }

    private closeWs(chat: ChatState, reason: string): void {
        const ws = chat.ws;
        if (ws) {
            try { ws.close(1000, reason); } catch { /* ignore */ }
        }
        chat.ws = null;
        chat.wsReady = false;
        chat.sessionId = null;
        chat.sessionLabel = null;
        chat.turn = null;
    }

    private sendWs(chat: ChatState, msg: Record<string, unknown>): void {
        const ws = chat.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
            ws.send(JSON.stringify(msg));
        } catch (err) {
            console.warn(`[telegram] WS send failed (chat=${chat.chatId}):`, err);
        }
    }

    // ---------- orchestrator -> Telegram ----------

    private async handleOrchestratorMsg(chat: ChatState, msg: OrchestratorMsg): Promise<void> {
        switch (msg.type) {
            case "session_info":
                chat.sessionLabel = msg.label;
                return;
            case "error":
                await this.reply(chat, `Friday error: ${msg.message}`);
                return;
            case "assistant_chunk":
                await this.handleAssistantChunk(chat, msg, false);
                return;
            case "assistant_proactive":
                await this.handleAssistantChunk(chat, msg, true);
                return;
        }
    }

    private async handleAssistantChunk(
        chat: ChatState,
        msg: { turnId: string; text: string; final: boolean },
        isProactive: boolean,
    ): Promise<void> {
        let turn = chat.turn;
        if (!turn || turn.turnId !== msg.turnId) {
            // New turn — start a fresh buffer. Anything in-flight from a
            // previous turn is dropped; the orchestrator only ever finalises
            // one turn at a time.
            turn = { turnId: msg.turnId, isProactive, buffer: "" };
            chat.turn = turn;
        }

        if (msg.text) turn.buffer += msg.text;
        if (!msg.final) return;

        // Detach the turn before any awaits so a follow-up turn arriving
        // mid-flush can't append to the buffer we're about to send.
        chat.turn = null;

        const text = turn.buffer.trim();
        if (!text) return;

        for (const piece of splitForTelegram(text)) {
            try {
                await this.tg.sendMessage({ chatId: chat.chatId, text: piece });
            } catch (err) {
                console.error(
                    `[telegram] failed to deliver assistant turn (chat=${chat.chatId}):`,
                    err,
                );
                return;
            }
        }
    }

    // ---------- helpers ----------

    private async reply(chat: ChatState, text: string): Promise<void> {
        try {
            await this.tg.sendMessage({ chatId: chat.chatId, text });
        } catch (err) {
            console.error(`[telegram] reply failed (chat=${chat.chatId}):`, err);
        }
    }
}

function shortId(id: string): string {
    return id.slice(0, 8);
}

// Split a finalised assistant turn into Telegram-sized pieces. Prefer to break
// at paragraph boundaries, then sentence-ending whitespace, then any
// whitespace, before falling back to a hard cut.
function splitForTelegram(text: string): string[] {
    if (text.length <= TG_MAX_TEXT) return [text];
    const pieces: string[] = [];
    let rest = text;
    while (rest.length > TG_MAX_TEXT) {
        const window = rest.slice(0, TG_MAX_TEXT);
        const minCut = Math.floor(TG_MAX_TEXT * 0.5);
        let cut = window.lastIndexOf("\n\n");
        if (cut < minCut) cut = window.lastIndexOf("\n");
        if (cut < minCut) cut = window.lastIndexOf(". ");
        if (cut >= minCut) cut += 1; // keep the period on the trailing edge
        if (cut < minCut) cut = window.lastIndexOf(" ");
        if (cut < minCut) cut = TG_MAX_TEXT;
        pieces.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest.length > 0) pieces.push(rest);
    return pieces;
}

function defaultSessionLabel(): string {
    // Local time, minutes precision — readable in the /sessions list.
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `Session ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function errMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
