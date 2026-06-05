// Shared type definitions for the orchestrator.

export type Role = "user" | "assistant";
export type Marker = "USER_INTERRUPTED" | "PARTIALLY_DELIVERED";

export type Message = {
    id: number;
    sessionId: string;
    role: Role;
    text: string;
    marker: Marker | null;
    createdAt: string;
};

export type SessionRow = {
    id: string;
    label: string;
    createdAt: string;
    lastActiveAt: string;
};

export type JobStatus = "running" | "finished" | "failed" | "cancelled";

export type JobRow = {
    id: string;
    sessionId: string | null;
    instruction: string;
    status: JobStatus;
    result: string | null;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
};

export type ScheduleKind = "once" | "recurring";
export type ScheduleStatus = "active" | "failed";

export type ScheduleRow = {
    id: string;
    kind: ScheduleKind;
    cron: string | null;
    fireAt: string | null;
    prompt: string;
    label: string | null;
    timezone: string | null;
    status: ScheduleStatus;
    lastFiredAt: string | null;
    lastError: string | null;
    createdAt: string;
};

export type InboxSource = "job" | "schedule" | "job_failure";

export type InboxRow = {
    id: string;
    source: InboxSource;
    originSessionId: string | null;
    text: string;
    createdAt: string;
    deliveredAt: string | null;
};

// ============================================================================
// Wire protocol — IL <-> Orchestrator over WebSocket.
// ============================================================================

export type ClientToServer =
    | { type: "user_message"; text: string }
    | { type: "deliverability"; deliverable: boolean; reason?: string }
    | { type: "abort"; turnId: string; reason?: string };

export type ServerToClient =
    | { type: "assistant_chunk"; turnId: string; text: string; final: boolean }
    | { type: "assistant_proactive"; turnId: string; text: string; final: boolean }
    | { type: "session_info"; sessionId: string; label: string; timezone: string }
    | { type: "error"; message: string };

// ============================================================================
// In-memory live-attachment state. Distinct from the persisted SessionRow.
// ============================================================================

export type ProactivePayload = {
    source: "job" | "job_failure" | "schedule";
    text: string;
    finishedAt: string;
    inboxId?: string;          // present when payload originated from inbox flush
    originSessionId: string | null;
};

export type Turn = {
    id: string;
    kind: "reply" | "proactive";
    abort: AbortController;
    streamedText: string;
    modelFinished: boolean;
    proactivePayloadsDriven: ProactivePayload[]; // re-queued on pre-stream abort
};

export type AttachedIl = {
    systemPromptFragment: string;
    ws: any;                                    // Bun ServerWebSocket
    deliverability: { deliverable: boolean; reason?: string };
    mode: "idle" | "generating";
    currentTurn: Turn | null;
    pendingProactive: ProactivePayload[];
    firstReplyOfAttachmentSent: boolean;
    // Inbox items injected into the upcoming first-reply system prompt.
    // Captured on attach; marked delivered when first reply finishes cleanly.
    inboxLeadInIds: string[];
};

export type LiveSession = {
    id: string;
    label: string;
    attached: AttachedIl | null;
};
