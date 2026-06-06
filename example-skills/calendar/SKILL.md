---
name: calendar
description: "Read Google Calendar (today/week agenda, view event details), create events with attendees and Meet links, update event properties (time, attendees, location, description), and delete events. Use whenever the user mentions calendar, meeting, event, agenda, schedule, invite, or specific dates/times."
metadata:
  version: 1.0.0
  requires:
    bins:
      - gws
  references:
    - ../gws-shared/SKILL.md
    - ../gws-people/SKILL.md
    - ../email/SKILL.md
---

# calendar (Google Calendar via `gws`)

> **Auth, global flags, and security rules:** see `../gws-shared/SKILL.md`.

## Decision table — common requests → command

| Request | Command |
|---------|---------|
| What's on today | `gws calendar +agenda --today` |
| Tomorrow | `gws calendar +agenda --tomorrow` |
| This week | `gws calendar +agenda --week` |
| Next N days | `gws calendar +agenda --days <N>` |
| Only one calendar | add `--calendar '<name-or-id>'` to any `+agenda` |
| View one event's details | `gws calendar events get --params '{"calendarId":"primary","eventId":"<ID>"}'` |
| Create a quick event from text | `gws calendar events quickAdd --params '{"calendarId":"primary","text":"Lunch with Alice tomorrow 1pm"}'` |
| Create a structured event | `gws calendar +insert --summary '...' --start <RFC3339> --end <RFC3339>` |
| Create with attendees | add `--attendee email@…` (repeatable) to `+insert` |
| Create with Meet link | add `--meet` to `+insert` |
| Reschedule (change time) | `events.patch` with `start`/`end` (see recipe) |
| Add/remove attendees on existing event | `events.patch` with full `attendees` array (see recipe) |
| Change title / location / description | `events.patch` with the changed field |
| Cancel an event | `events.delete` (see recipe) |
| Find a free slot | `freebusy.query` (see recipe) |
| Move to another calendar | `events.move` |
| List recurring instances | `events.instances` |

`+agenda` is read-only. `+insert` is a write — confirm with the user and consider `--dry-run` first. `events.patch` and `events.delete` are writes and notify attendees by default.

## Time formats — the only ones you should use

- **Timed events:** RFC3339 with an explicit offset. `2026-06-17T09:00:00-07:00` or `2026-06-17T16:00:00Z`. Don't pass naked local times.
- **All-day events:** in the event body, set `start.date` and `end.date` to `YYYY-MM-DD` strings *without* `dateTime`. End date is exclusive (an all-day event on June 17 has `start.date=2026-06-17`, `end.date=2026-06-18`).
- **Timezone:** defer to the user's Google account timezone. Only pass `--timezone <IANA>` when the user explicitly names one (e.g. "in New York time").

## Recipes

### Show agenda

```bash
gws calendar +agenda --today
gws calendar +agenda --week --format table
gws calendar +agenda --days 3 --calendar 'Work'
```

### Create a timed event with attendees and Meet

```bash
# Preview first
gws calendar +insert \
  --summary 'Sync with Alice' \
  --start '2026-06-17T14:00:00+10:00' \
  --end   '2026-06-17T14:30:00+10:00' \
  --attendee alice@example.com \
  --meet \
  --description 'Quarterly catch-up.' \
  --location 'Zoom (link in event)' \
  --dry-run

# Then create for real (drop --dry-run)
```

### Create an all-day event

`+insert` only accepts timed events; for all-day use `events.insert` directly:

```bash
gws calendar events insert --params '{"calendarId":"primary"}' --json '{
  "summary": "Conference",
  "start": {"date": "2026-06-17"},
  "end":   {"date": "2026-06-19"}
}'
```

### Reschedule an event

Get the event ID first (`+agenda` shows IDs in JSON; or list with `events.list`).

```bash
gws calendar events patch \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>","sendUpdates":"all"}' \
  --json '{
    "start": {"dateTime": "2026-06-18T14:00:00+10:00"},
    "end":   {"dateTime": "2026-06-18T14:30:00+10:00"}
  }'
```

`sendUpdates`: `all` (notify everyone), `externalOnly`, or `none`. Default is `none` — if the user wants attendees notified, pass `all` explicitly.

### Add or remove attendees

`events.patch` replaces the whole `attendees` array — first fetch the current list, then write the new list:

```bash
# 1. Fetch current attendees
gws calendar events get --params '{"calendarId":"primary","eventId":"<ID>"}' \
  | jq '.attendees'

# 2. Patch with the new full list
gws calendar events patch \
  --params '{"calendarId":"primary","eventId":"<ID>","sendUpdates":"all"}' \
  --json '{"attendees":[
    {"email":"alice@example.com"},
    {"email":"bob@example.com"}
  ]}'
```

### Change one field (title, location, description)

```bash
gws calendar events patch \
  --params '{"calendarId":"primary","eventId":"<ID>"}' \
  --json '{"summary":"New title"}'
```

### Cancel an event

```bash
# Preview
gws calendar events delete \
  --params '{"calendarId":"primary","eventId":"<ID>","sendUpdates":"all"}' \
  --dry-run

# Confirm with user, then drop --dry-run
```

### Find a free slot

```bash
gws calendar freebusy query --json '{
  "timeMin": "2026-06-17T09:00:00+10:00",
  "timeMax": "2026-06-17T18:00:00+10:00",
  "items": [{"id":"primary"}, {"id":"alice@example.com"}]
}'
```

Returns `busy` ranges per calendar; gap-find from there.

### Recurring events

Pass an RFC 5545 `RRULE` in `recurrence`:

```bash
gws calendar events insert --params '{"calendarId":"primary"}' --json '{
  "summary": "Weekly standup",
  "start": {"dateTime": "2026-06-17T09:00:00+10:00"},
  "end":   {"dateTime": "2026-06-17T09:15:00+10:00"},
  "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=20"]
}'
```

To edit one instance, fetch via `events.instances` and patch that specific instance ID.

## Cross-skill: invite someone by name

When the user says "invite Alice to a 2pm sync tomorrow":

1. Find Alice's email — `../gws-people/SKILL.md`:
   ```bash
   gws people people searchContacts \
     --params '{"query":"Alice","readMask":"names,emailAddresses"}'
   ```
   Confirm the match with the user if there's more than one Alice.
2. Create the event with her as an attendee:
   ```bash
   gws calendar +insert \
     --summary 'Sync' \
     --start '2026-06-07T14:00:00+10:00' \
     --end   '2026-06-07T14:30:00+10:00' \
     --attendee alice@example.com \
     --meet --dry-run
   ```
3. If the user also wants a follow-up email, hand off to `../email/SKILL.md` and draft (don't auto-send).

## Common gotchas

- **Time without offset → wrong day.** Always include the timezone offset (`+10:00`, `Z`) in `dateTime`. Don't write `2026-06-17T14:00:00`.
- **All-day `end.date` is exclusive.** Off-by-one is the #1 mistake.
- **`patch` replaces arrays wholesale.** To add one attendee, send the full new list, not just the new entry.
- **`sendUpdates` defaults to `none`.** If attendees should be notified about a reschedule/cancel, set it to `all`.
- **Event IDs vs iCalUIDs are different.** `events.get` takes `eventId`; if you only have the iCalUID, look it up with `events.list --params '{"iCalUID":"..."}'`.
- **`calendarId` defaults to `primary` for the helpers, but `events.*` API methods require it explicitly.** Always include it in `--params`.
- **`quickAdd` is fast but limited.** Natural-language only; can't set attendees, Meet links, or descriptions. Use it for "lunch tomorrow 1pm", not for anything structured.
- **`+insert` has no `--update` counterpart.** Updates always go through raw `events.patch`.
- **JSON quoting:** wrap `--json '{...}'` in single quotes so the inner `"` survive.

## Fallback — anything not covered above

```bash
gws calendar --help                                  # browse resources/methods
gws schema calendar.<resource>.<method>              # required params and types
gws calendar <resource> <method> --params '{...}' --json '{...}'
```

Useful resources beyond this skill: `calendarList` (manage which calendars show in your list), `acl` (sharing/permissions), `calendars` (create secondary calendars), `colors` (event colour palette), `settings` (account-level prefs), `events.move` (move event between calendars), `events.import` (import external `.ics`).

> [!CAUTION]
> `+insert`, `events.patch`, `events.delete`, `events.move`, and `calendars.clear` all affect real people's calendars. Confirm with the user, and use `--dry-run` for previews.
