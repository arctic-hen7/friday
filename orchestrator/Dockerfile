FROM oven/bun:1.2.19-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Podman remote client — talks to the host's podman socket so we can
# `podman exec` into the primary container from inside this one.
RUN apk add --no-cache podman-remote \
    && ln -sf /usr/bin/podman-remote /usr/local/bin/podman

FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

FROM base AS run
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 6000
CMD ["bun", "run", "start"]
