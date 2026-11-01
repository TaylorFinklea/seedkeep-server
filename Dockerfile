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
# zip_locations.csv is needed by the seed:zip script run on the deployed image.
COPY data ./data

# (Optional) Bun build to a single bundled file. We skip for now since
# Bun runs TS sources natively and we want stack traces to point at
# original lines.

# ─── Runtime stage: slimmer image with only what's needed at run time ──────
FROM alpine:3.24 AS runtime

ENV NODE_ENV=production \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

WORKDIR /app

# Keep the Bun 1.3 executable while using Alpine 3.24's PostgreSQL 18
# client. Neon is PostgreSQL 18; pg_dump refuses a newer server with an
# older client. Bun's Alpine runtime needs libgcc and libstdc++.
RUN apk add --no-cache ca-certificates libgcc libstdc++ postgresql18-client
COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
RUN bun --version && pg_dump --version | grep -E '^pg_dump \(PostgreSQL\) 18\.'

# Copy deps + source from builder.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/data ./data

EXPOSE 8787

CMD ["bun", "run", "src/server.ts"]
