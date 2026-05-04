# Decisions

> Architecture decision records. Append-only — one entry per decision.

## [2026-05-04] Bun + Hono + Postgres + S3-compatible storage

**Context**: After completing Phase 1 step E on Cloudflare Workers + D1 + R2, we identified self-hostability as a first-class requirement (users should be able to run their own backend on Fly.io / Railway / Docker). Workers + D1 are Cloudflare-locked and cannot satisfy that.

**Decision**: Migrate to Bun + Hono + PostgreSQL + S3-compatible object storage. Tag the Workers attempt at `phase-1-workers-attempt` in the sibling `seedkeep` repo and start fresh in `seedkeep-server`.

**Alternatives considered**: Keep Workers as primary + add a separate self-host build (two stacks); migrate to Node.js (similar shape, slower runtime than Bun); migrate to Deno (smaller ecosystem).

**Rationale**: Bun runs Hono natively, has a built-in test runner, fast startup, and ships on Fly/Railway/Docker without ceremony. Postgres is the boring-correct choice for the catalog (D1's 10GB ceiling would have bitten us anyway). S3-compatible storage means R2 for hosted, MinIO for self-host, AWS S3 for the most-conservative deployers — one client, many backends.

## [2026-05-04] postgres.js for raw queries; Kysely-postgres-js only for better-auth

**Context**: better-auth's official Postgres adapter is built on Kysely. We could either use Kysely throughout or use a lighter-weight client (postgres.js) for the route code and keep Kysely just for the auth adapter.

**Decision**: Route handlers use `postgres.js` directly via `sql` tagged-template literals (parallels the Workers `dbGet/dbAll/dbRun/dbBatch` helpers). Better-auth uses `kysely-postgres-js` on top of the same `postgres` connection.

**Alternatives considered**: Kysely everywhere; Drizzle everywhere.

**Rationale**: Tagged-template SQL keeps queries readable and we already wrote them in raw form for the Workers attempt — porting is mechanical. Kysely's typed-query value is real but redundant with the tests + manual review we already do. One driver (postgres.js), two access patterns (raw + Kysely-via-adapter) is the simplest option that satisfies better-auth's adapter contract.

## [2026-05-04] Self-hostable docker-compose ships in repo

**Context**: Self-hosters should be able to run the whole stack locally with one command.

**Decision**: Repo includes `docker-compose.yml` with three services: `postgres:16-alpine`, `minio/minio:latest`, and the app from local `Dockerfile`. `.env.example` provides defaults that match the compose stack.

**Alternatives considered**: Ship docker-compose as a separate `seedkeep-deploy` repo; document Postgres + MinIO setup but don't ship a compose file.

**Rationale**: Lowest-friction self-host story. A user clones the repo, copies `.env.example` to `.env`, runs `docker compose up`, and has a working Seedkeep server. Power users override individual env vars to point at their own Postgres or S3.

## [2026-05-04] Pre-extracted route trusts `self_confidence` (no server-side LLM)

**Context**: F2's pre-extracted path lets free + byok users contribute to the global catalog without the server paying for vision extraction. The previous catalog-decision pipeline always ran a server-side reviewer pass (Claude Haiku) over the extracted JSON.

**Decision**: For pre-extracted submissions, skip the server-side reviewer pass. Use the client-supplied `self_confidence` as both `selfConfidence` and `reviewScore` when calling `decideCatalogStatus`. The threshold policy stays unchanged.

**Alternatives considered**: Run the reviewer pass for everyone (server eats the LLM cost); skip the catalog decision entirely so every pre-extracted submission lands in `pending` for manual review; require BYOK users to also send a server-side reviewer call against their own key.

**Rationale**: Free users are the long tail. Paying for a reviewer LLM call on every free-user upload turns Seedkeep into an unbounded server-side cost. Trusting `self_confidence` is acceptable because:
- The on-device or BYOK model produces a real number (not a constant 1.0).
- `decideCatalogStatus` already requires both confidence ≥ 0.85 AND `common_name` set, so spam can't slip through trivially.
- Bad rows can be cleaned by a periodic batch reviewer or an admin UI later.

When a user converts to hosted tier, their submissions automatically route through the full server-side flow with the real reviewer pass.

## [2026-05-04] Per-route middleware composition, not `subrouter.use('*')`

**Context**: The Workers port had `subrouter.use('*', requireAuth(), requireHousehold())` at the top of each protected router. Discovered in F1e: when multiple subrouters mount under the same `/api` prefix and one declares `use('*')`, that middleware runs for **all** `/api/*` requests — including ones that route to sibling subrouters. POST `/api/households` was getting intercepted by `requireHousehold()` from the seeds router.

**Decision**: Apply middleware per-route. Each route file declares one or two middleware tuples (`authOnly = requireAuth()`, `auth = [requireAuth(), requireHousehold()]`) and uses spread syntax at each route definition: `router.get('/path', ...auth, handler)`.

**Alternatives considered**: Path-scoped `use('/locations*', ...)`; mount-order shuffling; one consolidated wrapper subrouter that mounts every household-scoped router under itself.

**Rationale**: Per-route composition is unambiguous and tooling-friendly (easy to grep "which routes need which auth?"). Path-scoped `use()` calls would need maintenance every time a new path is added. Consolidation with a wrapper would still have the leak problem if any inner router itself used `use('*')`.
