# Multi-stage Bun build for seedkeep-server.
# Final image runs `bun run start` against `src/server.ts`.

# ─── Build stage: install deps + transpile ─────────────────────────────────
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Install deps. Lock file pin ensures reproducible builds.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source.
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

# (Optional) Bun build to a single bundled file. We skip for now since
# Bun runs TS sources natively and we want stack traces to point at
# original lines.

# ─── Runtime stage: slimmer image with only what's needed at run time ──────
FROM oven/bun:1.3-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Copy deps + source from builder.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts

EXPOSE 8787

CMD ["bun", "run", "src/server.ts"]
