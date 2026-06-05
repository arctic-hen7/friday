FROM docker.io/oven/bun:1.2.19-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY src ./src
COPY package.json tsconfig.json index.ts ./
USER bun
CMD ["bun", "run", "start"]
