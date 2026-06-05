FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# # Codex CLI (official install script)
# RUN curl -fsSL https://chatgpt.com/codex/install.sh | sh
    # && ln -s /root/.local/bin/codex /usr/local/bin/codex || true
RUN npm install --global @openai/codex@latest

ENV CODEX_HOME=/root/.codex
WORKDIR /workspace

# Container is long-lived; orchestrator execs `codex exec` into it per job.
CMD ["sleep", "infinity"]
