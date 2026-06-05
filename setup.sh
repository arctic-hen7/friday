#!/usr/bin/env bash
# Bootstrap and reconcile the primary container.
#
# Use on first clone to seed user-local files and build everything; re-run
# any time you change `user.Dockerfile` (new CLI for a skill) or
# `docker-compose.override.yml` (new bind mount / env) to pick up the
# changes and drop back into a shell.
#
# What it does every run:
#   1. Seeds `user.Dockerfile` and `.env` from the `.example` files if
#      they don't exist (never clobbers).
#   2. Rebuilds `friday-primary-base` from `primary.Dockerfile`
#      (cached — fast no-op when nothing upstream changed).
#   3. Rebuilds the primary image from `user.Dockerfile` and recreates
#      the container with the current `docker-compose.override.yml`
#      merged in.
#   4. Execs into the container so you can `codex login`, run per-skill
#      auth commands, etc.

set -euo pipefail

cd "$(dirname "$0")"

# 1. Ensure user-local files exist (don't clobber existing customizations).
if [[ ! -f user.Dockerfile ]]; then
    cp user.Dockerfile.example user.Dockerfile
    echo "==> Created user.Dockerfile from example."
fi

if [[ ! -f .env ]]; then
    cp .env.example .env
    echo "==> Created .env from example — edit it before running the full stack."
fi

# docker-compose.override.yml is optional; only nudge if neither exists.
if [[ ! -f docker-compose.override.yml ]]; then
    echo "==> No docker-compose.override.yml — copy from .example if you need bind mounts or extra env."
fi

# 2. Build the base image that user.Dockerfile chains on top of.
echo "==> Building friday-primary-base..."
podman build -f primary.Dockerfile -t friday-primary-base:latest .

# 3. Rebuild the primary image and recreate the container so changes to
#    `user.Dockerfile` and `docker-compose.override.yml` always take
#    effect. podman-compose auto-merges `docker-compose.override.yml`
#    when present.
echo "==> Rebuilding and (re)starting primary container..."
podman-compose up -d --build --force-recreate primary

# 4. Shell in.
echo "==> Entering primary container. Run \`codex login\` and any per-skill"
echo "    auth commands here. Type 'exit' when done; the container stays up."
podman exec -it friday-primary bash

echo "Setup complete! You can re-run this script whenever you change the packages/setup of your primary agent."
