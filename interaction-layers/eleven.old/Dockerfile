FROM docker.io/oven/bun:1.2.19-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS dependencies
ENV NODE_ENV=development
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS build
ENV NODE_ENV=development
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY app/env.ts app/speechEngine.ts app/muteRegistry.ts app/orchestrator.ts app/activeSession.ts app/proactivePlayer.ts app/proactiveWs.ts ./app/
COPY public ./public
COPY package.json index.ts ./
USER bun
EXPOSE 5000
CMD ["bun", "run", "start"]
