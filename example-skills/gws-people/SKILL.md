---
name: gws-people
description: "Look up Google Contacts to resolve a name to an email address. Most often used as a helper for the calendar/ and email/ skills when the user names an attendee or recipient by first name."
metadata:
  version: 1.0.0
  requires:
    bins:
      - gws
  references:
    - ../gws-shared/SKILL.md
---

# gws-people (Google People API via `gws`)

> **Auth, global flags:** see `../gws-shared/SKILL.md`.

You're usually here because `../calendar/SKILL.md` or `../email/SKILL.md` needs an email address for a name the user gave you ("invite Alice", "email Bob"). Confirm the match with the user before drafting or sending.

## Decision table — common requests → command

| Request | Command |
|---------|---------|
| Find a contact by name | `gws people people searchContacts --params '{"query":"<name>","readMask":"names,emailAddresses"}'` |
| Find a contact by email substring | Same as above; query matches names, emails, phones, orgs |
| Get full details by resource name | `gws people people get --params '{"resourceName":"people/c<id>","personFields":"names,emailAddresses,phoneNumbers"}'` |
| Get the authenticated user's own profile | `gws people people get --params '{"resourceName":"people/me","personFields":"names,emailAddresses"}'` |
| List all "My Contacts" | `gws people people.connections list --params '{"resourceName":"people/me","personFields":"names,emailAddresses","pageSize":200}'` |
| Search auto-saved "other" contacts (not in groups) | `gws people otherContacts search --params '{"query":"<q>","readMask":"names,emailAddresses"}'` |
| Search the workspace directory | `gws people people searchDirectoryPeople --params '{"query":"<q>","readMask":"names,emailAddresses","sources":["DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT","DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE"]}'` |

## Recipes

### Resolve a first name to an email (the canonical use case)

```bash
gws people people searchContacts \
  --params '{"query":"Alice","readMask":"names,emailAddresses"}'
```

The response includes one or more `Person` objects with `names[].displayName` and `emailAddresses[].value`. Pick the match and confirm with the user if more than one comes back.

> **Search cache warmup:** the People API recommends a warmup call with an empty query before the first real search, otherwise results can be stale. In practice, just retry once if the first search returns nothing for a name you know exists.

### Pull more fields for a known contact

```bash
gws people people get --params '{
  "resourceName": "people/c1234567890",
  "personFields": "names,emailAddresses,phoneNumbers,organizations"
}'
```

`personFields` is required — the API returns a 400 if you omit it. Common values: `names`, `emailAddresses`, `phoneNumbers`, `organizations`, `addresses`, `birthdays`, `biographies`, `photos`.

### "Other contacts" (auto-saved from email/calendar interactions)

These often hold the email address for someone you've corresponded with but never explicitly added to contacts. Search them when `searchContacts` finds nothing:

```bash
gws people otherContacts search \
  --params '{"query":"alice","readMask":"names,emailAddresses"}'
```

## Common gotchas

- **`personFields` / `readMask` are required** on most read calls — the API rejects requests that omit them. Always include at least `names,emailAddresses`.
- **`searchContacts` only searches "My Contacts"** (the grouped contacts). Auto-saved contacts live in `otherContacts`. If a search misses, fall through to the other resource.
- **Resource names look like `people/c<id>`** for personal contacts and `people/<id>` for directory people. Don't confuse them with raw IDs.
- **Workspace directory searches need `sources`.** Without it `searchDirectoryPeople` returns empty.

## Fallback — anything not covered above

```bash
gws people --help                           # browse resources/methods
gws schema people.<resource>.<method>       # required params and types
```

The full People API also covers contact groups (`contactGroups.list/create/update/delete`, `contactGroups.members.modify`), batch reads (`people.getBatchGet`), batch mutations (`people.batchCreateContacts`, `people.batchUpdateContacts`, `people.batchDeleteContacts`), contact photos (`updateContactPhoto`, `deleteContactPhoto`), and copying an "other contact" into "My Contacts" (`otherContacts.copyOtherContactToMyContactsGroup`).

> [!CAUTION]
> Create/update/delete operations are writes — confirm with the user and use `--dry-run` first.
