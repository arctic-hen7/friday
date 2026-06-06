---
name: email
description: "Read Gmail (triage inbox, search, read messages), draft replies and new messages, and send only when explicitly asked. Use whenever the user mentions email, inbox, replying, drafting, forwarding, or specific senders/subjects."
metadata:
  version: 1.0.0
  requires:
    bins:
      - gws
  references:
    - ../gws-shared/SKILL.md
    - ../gws-people/SKILL.md
---

# email (Gmail via `gws`)

> **Auth, global flags, and security rules:** see `../gws-shared/SKILL.md`.

## Send policy — read this first

Trust explicit verbs from the user. Default to drafting when unclear.

| User says | What to do |
|-----------|------------|
| "send X to Alice", "go ahead and send", "forward this to Bob" | Real send (no `--draft`) |
| "draft a reply to X", "write me an email to Y", "compose a reply" | Always `--draft` |
| "reply to X saying ..." (no verb committing to send) | `--draft`, then tell the user where the draft is |
| Ambiguous | `--draft`, then ask "want me to send it?" |

Never invent recipient addresses. If the user names someone by first name only, look them up via `../gws-people/SKILL.md` (`searchContacts`) and confirm before sending or drafting.

## Decision table — common requests → command

| Request | Command |
|---------|---------|
| Show me my unread inbox | `gws gmail +triage` |
| What's new today | `gws gmail +triage --query 'newer_than:1d'` |
| Search for X | `gws gmail +triage --query '<gmail-search>'` (see cookbook below) |
| Read message body | `gws gmail +read --id <ID>` |
| Read with headers | `gws gmail +read --id <ID> --headers` |
| Read HTML body | `gws gmail +read --id <ID> --html` |
| Draft a reply | `gws gmail +reply --message-id <ID> --body '...' --draft` |
| Draft a reply-all | `gws gmail +reply-all --message-id <ID> --body '...' --draft` |
| Draft a forward | `gws gmail +forward --message-id <ID> --to <emails> --draft` |
| Draft a new message | `gws gmail +send --to <emails> --subject '...' --body '...' --draft` |
| Actually send (user asked) | Same as above, remove `--draft` |
| List existing drafts | `gws gmail users.drafts list` (use `gws schema gmail.users.drafts.list`) |
| Send an existing draft | `gws gmail users.drafts send --params '{"id":"<draftId>"}'` |
| Delete a draft | `gws gmail users.drafts delete --params '{"id":"<draftId>"}'` |
| Label / archive / mark read | `gws gmail users.messages.modify` (`gws schema gmail.users.messages.modify`) |
| Get message IDs from a query | `gws gmail users.messages.list --params '{"q":"<query>","maxResults":N}'` |

The `+reply`, `+reply-all`, and `+forward` helpers handle In-Reply-To, References, threadId, and quoted-original formatting automatically — always prefer them over raw `messages.send` when replying or forwarding.

## Recipes

### Triage and read

```bash
# Latest 5 unread
gws gmail +triage --max 5

# Unread from a specific person
gws gmail +triage --query 'from:alice@example.com is:unread'

# Read a message as plain text
gws gmail +read --id 18f1a2b3c4d

# Read with headers, JSON for further processing
gws gmail +read --id 18f1a2b3c4d --headers --format json
```

### Draft a reply (default behaviour)

```bash
gws gmail +reply --message-id 18f1a2b3c4d \
  --body 'Thanks — Friday at 2pm works for me.' \
  --draft
```

After running, surface the draft ID/location to the user and ask if they want it sent.

### Send (only when explicitly asked)

```bash
# Dry-run first to verify recipients/subject/body
gws gmail +send --to alice@example.com --subject 'Hello' --body 'Hi Alice!' --dry-run

# Then the real send
gws gmail +send --to alice@example.com --subject 'Hello' --body 'Hi Alice!'
```

### Forward without sending

```bash
gws gmail +forward --message-id 18f1a2b3c4d \
  --to bob@example.com \
  --body 'FYI — thought you should see this.' \
  --draft
```

### HTML body

Use `--html` and pass fragment tags (`<p>`, `<b>`, `<a>`, `<br>`) — no `<html>`/`<body>` wrapper. Quoted-reply blocks and inline images are preserved automatically.

### Attachments

`-a/--attach <path>` (repeatable). Combined cap 25 MB.

## Gmail search query cookbook

These go in `--query` for `+triage`, or `q` in `users.messages.list`.

| Want | Query |
|------|-------|
| Unread | `is:unread` |
| From someone | `from:alice@example.com` |
| To someone | `to:bob@example.com` |
| Subject contains | `subject:"quarterly report"` |
| Has attachment | `has:attachment` |
| Newer than N days | `newer_than:7d` (also `2w`, `1m`, `1y`) |
| Older than | `older_than:30d` |
| Specific label | `label:work` |
| In inbox | `in:inbox` (vs. `in:anywhere`) |
| Important | `is:important` |
| Combine | `from:alice is:unread newer_than:3d` (space = AND, use `OR` for OR, `-` to negate) |

## Cross-skill: schedule a meeting AND email the invite

When the user says "set up a meeting with Alice next Tuesday and email her about it":

1. Resolve Alice's email — `../gws-people/SKILL.md` → `gws people people searchContacts --params '{"query":"Alice","readMask":"emailAddresses,names"}'`
2. Create the calendar event with her as attendee — see `../calendar/SKILL.md`
3. Draft the email (default: `--draft`) referencing the event time:
   ```bash
   gws gmail +send --to alice@example.com \
     --subject 'Tuesday 2pm — sync' \
     --body 'Hi Alice — sent a calendar invite for Tuesday at 2pm. Let me know if that time doesn't work.' \
     --draft
   ```
4. Surface the draft and the event link; ask the user to confirm before sending.

## Common gotchas

- **Don't invent IDs.** Always pull message IDs from a prior `+triage` or `users.messages.list` call. Don't pattern-match `--message-id` from earlier chat unless you saw it in tool output this session.
- **`+reply` vs raw `messages.send`:** raw send doesn't set threading headers, so the reply lands as a new conversation. Use `+reply`.
- **`--draft` on `+send` saves a draft of a *new* message**, not a reply. For drafted replies use `+reply --draft`.
- **HTML quoting:** in `--html` mode, the quote block uses Gmail's `gmail_quote` CSS — don't wrap your body in `<html>`/`<body>`.
- **`--from` is for send-as aliases**, not arbitrary spoofing. The address must already be configured as a send-as in the user's Gmail settings.
- **zsh `!` expansion:** wrap queries with `!` in double quotes or escape them.
- **JSON params:** wrap `--params`/`--json` values in single quotes so inner `"` survive the shell.

## Fallback — anything not covered above

The `gws gmail` surface is large. For operations beyond this skill:

```bash
gws gmail --help                            # browse resources/methods
gws schema gmail.<resource>.<method>        # inspect required params and types
gws gmail <resource> <method> --params '{...}' --json '{...}'
```

Useful resources to know about: `users.labels` (create/list/modify labels), `users.threads` (thread-level ops), `users.settings.sendAs` (manage aliases/signatures), `users.history` (incremental sync), `users.messages.batchModify` (bulk label changes), `users.messages.trash`/`untrash`.

`+watch` exists (`gws gmail +watch --help`) for streaming new messages via Pub/Sub — requires a GCP project and is not for everyday use.

> [!CAUTION]
> Anything without `--draft` that hits `+send`, `+reply`, `+reply-all`, `+forward`, or `users.drafts.send` will leave your outbox. Add `--dry-run` first when in doubt.
