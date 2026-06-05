import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSetting } from "./db";
import type { InboxRow } from "./types";

const TEMPLATE_PATH = resolve(import.meta.dir, "./prompts/lite-agent.md");

function loadTemplate(): string {
    // Read fresh per turn (cheap, ~couple of KB) so on-disk edits take effect
    // immediately without restart. Add caching later if profiling demands it.
    return readFileSync(TEMPLATE_PATH, "utf8");
}

function formatInboxLeadIn(items: InboxRow[]): string {
    if (items.length === 0) return "";
    const lines = items.map((it, i) => `${i + 1}. ${it.text}`).join("\n");
    return `

## Inbox

You have ${items.length} undelivered update(s) from prior tasks or scheduled runs. After answering the user's current message, naturally weave them into the same response (e.g. "Also, while you were away: ..."). Do not split into a separate message.

Updates:
${lines}`;
}

export function buildSystemPrompt(args: {
    transportFragment: string;
    inboxLeadIn: InboxRow[];
}): string {
    const tz = getSetting("timezone") ?? "Australia/Sydney";
    const now = new Date().toLocaleString("en-AU", {
        timeZone: tz,
        dateStyle: "full",
        timeStyle: "short",
    });

    return loadTemplate()
        .replaceAll("{{TRANSPORT_FRAGMENT}}", args.transportFragment.trim() || "(No transport-specific guidance was provided.)")
        .replaceAll("{{CURRENT_TIME}}", now)
        .replaceAll("{{TIMEZONE}}", tz)
        .replaceAll("{{INBOX_LEAD_IN}}", formatInboxLeadIn(args.inboxLeadIn));
}

// ---------- Note formatting ----------
//
// All non-conversational events (proactive payloads, system signals) are
// injected into history as user-role messages with `<note>...</note>`
// formatting that the system prompt teaches the model to recognise.

export function formatProactiveFold(payloads: { text: string }[]): string {
    return `<note>While the user was speaking, ${payloads.length === 1 ? "a background task" : "background tasks"} finished. Incorporate naturally if relevant to the upcoming reply.\n\n${payloads.map(p => p.text).join("\n\n---\n\n")}</note>`;
}

export function formatProactiveFollowUp(payloads: { text: string }[]): string {
    return `<note>While you were responding, ${payloads.length === 1 ? "another background result" : "additional background results"} came in. Continue your response and weave them in.\n\n${payloads.map(p => p.text).join("\n\n---\n\n")}</note>`;
}

export function formatProactiveStandalone(payloads: { text: string }[]): string {
    return `<note>A background task has finished. The user did not just say anything — proactively reach out to share this with them.\n\n${payloads.map(p => p.text).join("\n\n---\n\n")}</note>`;
}
