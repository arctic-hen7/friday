// Routing layer for proactive payloads (job results, schedule outputs, failures).
//
// Decision tree:
//   if originSessionId is set AND that session is currently attached:
//       deliver via that session's IL (pendingProactive + trySchedule)
//   else:
//       enqueue into the global inbox (persisted, surfaced on next attach)

import { enqueueInbox } from "./inbox";
import { liveSession } from "./sessions";
import type { ProactivePayload } from "./types";
import { trySchedule } from "./turnLoop";

export function onProactivePayload(payload: ProactivePayload): void {
    const targetId = payload.originSessionId;
    if (targetId) {
        const live = liveSession(targetId);
        if (live?.attached) {
            live.attached.pendingProactive.push(payload);
            trySchedule(live);
            return;
        }
    }
    // No live attached origin session → persist to global inbox.
    enqueueInbox(payload.source, payload.text, targetId);
}
