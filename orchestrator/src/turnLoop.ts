// The proactive-message + turn state machine.
//
// Lives at the heart of the orchestrator. Implements:
//  - Reply turn (case 1 fold + case 2 in-turn continuation)
//  - Proactive turn (case 3 standalone push)
//  - Abort handling with USER_INTERRUPTED / PARTIALLY_DELIVERED markers
//  - Deliverability-driven abort of proactive turns
//
// See the design conversation for the rationale behind each branch.

import { runLiteAgent } from "./liteAgent";
import { appendMessage, loadHistory } from "./sessions";
import { buildSystemPrompt, formatProactiveFold, formatProactiveFollowUp, formatProactiveStandalone } from "./prompts";
import { listUndelivered, markDelivered } from "./inbox";
import type { LiveSession, ProactivePayload, ServerToClient, Turn } from "./types";

function sendToIl(session: LiveSession, msg: ServerToClient): void {
    const il = session.attached;
    if (!il) return;
    try {
        il.ws.send(JSON.stringify(msg));
    } catch (err) {
        // WS may be in the process of closing — swallow.
        console.warn(`[ws] failed to send to ${session.id}: ${err}`);
    }
}

function newTurn(kind: "reply" | "proactive"): Turn {
    return {
        id: crypto.randomUUID(),
        kind,
        abort: new AbortController(),
        streamedText: "",
        modelFinished: false,
        proactivePayloadsDriven: [],
    };
}

// ---------- Scheduling decision (cases 1/2/3) ----------

export function trySchedule(session: LiveSession): void {
    const il = session.attached;
    if (!il || il.pendingProactive.length === 0) return;

    if (il.mode === "generating") {
        // Case 2 — the reply/proactive loop checks pendingProactive between
        // iterations. Nothing to do here.
        return;
    }

    // mode === 'idle'
    if (!il.deliverability.deliverable) {
        // Case 1 — keep cached. trySchedule will be called again when
        // deliverability flips true OR when a user_message arrives.
        return;
    }

    // Case 3 — idle + deliverable → standalone proactive turn.
    void startProactiveTurn(session);
}

// ---------- Reply turn ----------

export async function handleUserMessage(session: LiveSession, userText: string): Promise<void> {
    const il = session.attached;
    if (!il) return;

    // If a turn is somehow in flight when a user_message arrives, treat as
    // a late abort. Should be rare — usually the IL fires `abort` first.
    if (il.currentTurn) abortCurrentTurn(session, "user_message arrived");

    // Persist user message immediately.
    appendMessage(session.id, "user", userText);

    // CASE 1 fold: drain anything queued while the user was speaking and
    // inject as a note BEFORE generation begins.
    const folded = il.pendingProactive.splice(0);
    if (folded.length > 0) {
        appendMessage(session.id, "user", formatProactiveFold(folded));
    }

    // Inbox lead-in only on the first reply of this attachment.
    let inboxItems: ReturnType<typeof listUndelivered> = [];
    if (!il.firstReplyOfAttachmentSent) {
        inboxItems = listUndelivered();
        il.inboxLeadInIds = inboxItems.map(i => i.id);
    }

    const result = await runTurn(session, "reply", inboxItems);

    // Mark inbox items delivered only if turn completed without abort.
    if (result.cleanCompletion && il.inboxLeadInIds.length > 0) {
        markDelivered(il.inboxLeadInIds);
        il.firstReplyOfAttachmentSent = true;
        il.inboxLeadInIds = [];
    }

    // After turn, maybe more proactive arrived; try idle scheduling.
    trySchedule(session);
}

// ---------- Proactive turn ----------

async function startProactiveTurn(session: LiveSession): Promise<void> {
    const il = session.attached;
    if (!il || il.pendingProactive.length === 0) return;
    if (!il.deliverability.deliverable) return;
    if (il.mode === "generating") return;

    const payloads = il.pendingProactive.splice(0);
    appendMessage(session.id, "user", formatProactiveStandalone(payloads));

    // Stash for re-queue on pre-stream abort. Done before runTurn so the
    // abort handler sees them on the active turn.
    await runTurn(session, "proactive", [], payloads);
}

// ---------- Core turn runner (handles reply OR proactive) ----------

type TurnResult = { cleanCompletion: boolean };

async function runTurn(
    session: LiveSession,
    kind: "reply" | "proactive",
    inboxItems: ReturnType<typeof listUndelivered>,
    initialPayloads: ProactivePayload[] = [],
): Promise<TurnResult> {
    const il = session.attached!;
    const turn = newTurn(kind);
    turn.proactivePayloadsDriven = initialPayloads;
    il.currentTurn = turn;
    il.mode = "generating";

    const chunkType: ServerToClient["type"] =
        kind === "reply" ? "assistant_chunk" : "assistant_proactive";

    let cleanCompletion = false;

    try {
        // Inner loop: each iteration runs a full Lite agent call. We loop again
        // if additional proactive payloads arrived during generation.
        while (true) {
            const history = loadHistory(session.id);
            const systemPrompt = buildSystemPrompt({
                transportFragment: il.systemPromptFragment,
                inboxLeadIn: inboxItems,
            });

            turn.streamedText = "";
            turn.modelFinished = false;

            try {
                await runLiteAgent({
                    systemPrompt,
                    history,
                    toolContext: { sessionId: session.id },
                    signal: turn.abort.signal,
                    onText: (text) => {
                        turn.streamedText += text;
                        sendToIl(session, {
                            type: chunkType,
                            turnId: turn.id,
                            text,
                            final: false,
                        } as ServerToClient);
                    },
                });
            } catch (err) {
                if (turn.abort.signal.aborted) {
                    // Abort was the cause — handled below.
                    break;
                }
                throw err;
            }

            turn.modelFinished = true;
            if (turn.abort.signal.aborted) break;

            // Persist the assistant's clean response.
            if (turn.streamedText.length > 0) {
                appendMessage(session.id, "assistant", turn.streamedText);
            }

            // CASE 2 continuation: did more proactive arrive during this
            // iteration? Drain, inject a follow-up note, loop.
            if (il.pendingProactive.length > 0) {
                const more = il.pendingProactive.splice(0);
                appendMessage(session.id, "user", formatProactiveFollowUp(more));
                turn.proactivePayloadsDriven.push(...more);
                inboxItems = []; // inbox already covered in the first iteration
                continue;
            }

            break;
        }

        if (!turn.abort.signal.aborted) {
            // Clean turn — emit final chunk.
            sendToIl(session, {
                type: chunkType,
                turnId: turn.id,
                text: "",
                final: true,
            } as ServerToClient);
            il.mode = "idle";
            il.currentTurn = null;
            cleanCompletion = true;
        }
    } catch (err) {
        // Unhandled error — surface to IL, reset state.
        console.error(`[turn] error in ${kind} turn for ${session.id}:`, err);
        sendToIl(session, {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
        });
        il.mode = "idle";
        il.currentTurn = null;
    }

    return { cleanCompletion };
}

// ---------- Abort ----------

export function abortCurrentTurn(session: LiveSession, _reason: string): void {
    const il = session.attached;
    if (!il) return;
    const turn = il.currentTurn;
    if (!turn) return;

    turn.abort.abort();

    const hasEmitted = turn.streamedText.length > 0;

    if (!hasEmitted) {
        // Pre-first-chunk: discard generation entirely.
        if (turn.kind === "proactive") {
            // Re-queue payloads — user never heard them.
            il.pendingProactive.unshift(...turn.proactivePayloadsDriven);
        }
        // For reply: user message already in history; no assistant message.
    } else if (!turn.modelFinished) {
        // Mid-stream interruption.
        appendMessage(session.id, "assistant", turn.streamedText, "USER_INTERRUPTED");
    } else {
        // Model finished but delivery interrupted.
        appendMessage(session.id, "assistant", turn.streamedText, "PARTIALLY_DELIVERED");
    }

    il.mode = "idle";
    il.currentTurn = null;
}

// ---------- Deliverability change ----------

export function onDeliverabilityChanged(
    session: LiveSession,
    next: { deliverable: boolean; reason?: string },
): void {
    const il = session.attached;
    if (!il) return;
    const was = il.deliverability.deliverable;
    il.deliverability = next;

    // If deliverability dropped during a proactive turn, abort it. Reply
    // turns are only aborted by explicit `abort` from the IL (user
    // interruption will typically fire both signals; the abort wins).
    if (il.currentTurn?.kind === "proactive" && !next.deliverable) {
        abortCurrentTurn(session, `deliverability: ${next.reason ?? "lost"}`);
        return;
    }

    // Newly deliverable + idle → maybe flush queue.
    if (next.deliverable && !was && il.mode === "idle") {
        trySchedule(session);
    }
}

// ---------- Detach helper ----------
//
// Called when an IL disconnects. Move any in-flight or pending state to the
// inbox so nothing is lost.

import { enqueueInbox } from "./inbox";

export function onIlDisconnect(session: LiveSession): void {
    const il = session.attached;
    if (!il) return;

    // Abort any in-flight turn (this also stores partial assistant text).
    if (il.currentTurn) abortCurrentTurn(session, "il_disconnect");

    // Dump pending proactive payloads into the global inbox tagged with
    // this session's id so they surface on next attach (here or elsewhere).
    for (const p of il.pendingProactive) {
        enqueueInbox(p.source, p.text, session.id);
    }
    il.pendingProactive = [];

    session.attached = null;
}
