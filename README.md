# Friday

> Rough setup notes — a proper README will follow.

## First-time setup

```sh
./setup.sh
```

That script:

1. Copies `user.Dockerfile.example` → `user.Dockerfile` and `.env.example` → `.env` if they don't exist.
2. Builds the `friday-primary-base` image from `primary.Dockerfile` (this is the upstream-tracked base; don't edit it).
3. Builds + starts the `primary` container (built from `user.Dockerfile`, which extends the base).
4. Drops you into a shell inside the container so you can authenticate things like:
   - `codex login` (writes to `/root/.codex`, which is bind-mounted back to `./codex/`).
   - Per-skill CLI logins, e.g. `todoist login`, `gcalcli init`. For these to persist across rebuilds, bind-mount the relevant config dirs via `docker-compose.override.yml` (see below).

Re-run `./setup.sh` any time — it's idempotent.

## Per-user customization

Three files are gitignored and meant to be edited locally. Copy from the `.example` siblings and customize:

| File | Purpose |
|---|---|
| `.env` | Secrets and per-environment config (API keys, ports). |
| `user.Dockerfile` | Extra CLIs / packages your skills need. `FROM friday-primary-base:latest`, then `RUN ...`. Rebuild with `podman-compose up -d --build primary`. |
| `docker-compose.override.yml` | Runtime customizations (auto-merged by Compose). Best place to bind-mount host auth/config dirs so OAuth refresh tokens persist, inject per-tool env vars, or add sidecars. |

Pulling upstream changes won't touch any of these.

## Adding skills

Drop skill folders into `codex/skills/` (untracked). If a skill needs an external CLI, add the install line to `user.Dockerfile`; if it needs auth, bind-mount the config dir via `docker-compose.override.yml`. Then re-run `./setup.sh` — it rebuilds the image, recreates the container with the new mounts, and shells you in so you can run the login command interactively.

`./setup.sh` is the single command for both first-run and "I changed something, apply it."
