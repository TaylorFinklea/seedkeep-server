# Decisions

> Architecture decision records. Append-only — one entry per decision.

## [2026-10-09] Browser sessions: email one-time codes, host-only cookies, exact-Origin CSRF

**Context**: The web app replaces the iOS app (umbrella decision 2026-10-09). Browsers need a sign-in method that doesn't depend on the Apple Developer membership. They also need sessions that work with `<img>` and that resist CSRF, while native Bearer clients keep working. Spec: `plans/web-m1-p2-sessions.md`.

**Decision**:
- **Sign-in:** better-auth `emailOTP`, sign-in type only. Every other emailOTP path is in `disabledPaths`. Mail goes through Resend in staging and production; log and memory mailers are for development and tests only.
- **Sessions:** better-auth's default session cookie, host-only on the API host (`__Secure-` prefix, HttpOnly, SameSite=Lax). `__Host-` isn't achievable because better-auth prefixes custom names.
- **`requireAuth` precedence:** a present Bearer header never falls back to the cookie. Bearer and cookie naming different users → 401.
- **Origin gate:** cookie-authenticated unsafe requests need an exact `APP_ORIGINS` Origin. This applies to `/api/auth/*` (except cookie-free OAuth token, registration and userinfo paths) and to the API's own OAuth pages, which need the API origin.
- **CORS:** credentialed and exact; localhost only outside production; PUT allowed.
- **Explicit household:** `X-Household-Id` selects one, with membership checked.
- **OTP handling:**
  - Strict JSON on the OTP paths, with the request rebuilt before better-auth sees it.
  - Serialized per email by a Postgres advisory lock on a dedicated lock pool. Try-lock with bounded waits; the lock is held until the handler settles.
  - In-process limiters that never skip: per IP, per email, and failures per (email, IP). The client IP comes from `fly-client-ip` only when `FLY_APP_NAME` is set.

**Accepted residual risk**: anyone can use up one address's send budget (5 codes per 10 minutes) and so delay that user's sign-in. The guessing budget is negligible: at most 5 codes × 3 attempts per 10 minutes against a 6-digit code. CAPTCHA or proof-of-work would be the mitigation if abuse appears. Limits are per machine.

**Review**: Opus 5.5 and GPT-6.1 Sol found and confirmed, across rounds, an unauthenticated pool-exhaustion deadlock, an OTP lock bypass through a mixed Content-Type, a rate-limiter bypass without `fly-client-ip`, OAuth login CSRF, limiter memory exhaustion, and lock-lifetime hazards. All were fixed with regression tests.

## [2026-07-16] R1 garden-tool kill switch: fail closed at the Sprout + MCP boundaries

**Context**: Implements the umbrella ADR "R1 fails closed at the server boundary for all garden tools, including already-issued Sprout/MCP credentials" (`~/git/seedkeep/.docs/ai/decisions.md`, 2026-07-16) and bead `seedkeep-27d.9`. The iOS gate hides in-app Sprout/MCP routes, but credentials already pasted into Claude Desktop or claude.ai never pass through iOS again — `/mcp` would still resolve those tokens against the user's (possibly parked) Postgres household and register the full read/write tool set.

**Decision**: A new `GARDEN_TOOLS_ENABLED` env var (`src/env.ts`, Zod `.default(false)` — same union/transform shape as `S3_FORCE_PATH_STYLE` rather than `z.coerce.boolean()`, which would coerce the literal string `"false"` to `true`) gates the entire 25-tool garden surface at two boundaries:
- **Sprout** (`src/routes/assistant.ts`): `POST /stream` and `POST /tool_calls/:id/confirm` return 503 `capability_unavailable` before touching the DB when disabled, mirroring the existing `ASSISTANT_KEY_MASTER` 503 `not_configured` idiom. `POST /tool_calls/:id/cancel` is left untouched — it stays available unconditionally so an old client can still clean up a stale proposal.
- **MCP** (`src/lib/assistant/mcpServer.ts`, `src/routes/mcp.ts`): `buildMcpServer` takes a required `gardenToolsEnabled` flag; when false it registers zero tools via `registerTool` but still explicitly wires the SDK's `ListToolsRequestSchema` handler (through the low-level `server.server` — the class's own documented extension point for custom request handlers) to answer `tools/list` with `{ tools: [] }`. Without that explicit wiring, `tools/list` would 404 with "Method not found", because the SDK only registers its own list/call handlers lazily inside `registerTool`, which we never call. `executeMcpTool` double-gates the same flag so a direct callback invocation (bypassing tool discovery) also refuses with `capability_unavailable`. The `/mcp` transport, `initialize`, and both personal-token and OAuth auth flows are unchanged — only tool registration is affected. Token CRUD (`/api/mcp/tokens`) and OAuth routes are untouched.

`fly.toml` has no `[env]` block, so the fail-closed default ships without any deploy-config change; enabling requires an explicit `GARDEN_TOOLS_ENABLED=true` set on the Fly app (user-gated, not done here).

**Alternatives considered**: A persistent per-account data-plane marker checked before registering/running tools, and revoking all issued MCP tokens/OAuth grants/the assistant key at cutover — both rejected for the same reasons as the umbrella ADR (cross-plane state and races; destructive and hard to reverse, respectively). For the MCP empty-list mechanics specifically: calling the SDK's private `setToolRequestHandlers()` (rejected — reaches around a method the `.d.ts` marks `private`, an unstable target for a library upgrade) vs. setting the handler through the public `server.server` seam (chosen).

**Rationale**: One boolean is the simplest fail-closed switch and matches this file's existing `ADMIN_SECRET`/`ASSISTANT_KEY_MASTER` optional-gating pattern. Registering zero tools (rather than filtering per-tool) disables the entire surface with one branch instead of 25 conditionals. Explicitly answering `tools/list` with an empty array — instead of letting the method 404 — keeps the transport spec-compliant: a server that advertises `capabilities: { tools: {} }` at `initialize` is expected to answer `tools/list`, not error on it.

## [2026-07-15] MCP OAuth transport accepts any Seedkeep capability scope

**Context**: The immediately following entry over-constrained transport access to tokens carrying both Seedkeep scopes. That contradicts the product contract for useful read-only OAuth grants and weakens least-privilege authorization.

**Decision**: This entry supersedes “MCP OAuth transport requires both Seedkeep scopes.” OAuth tokens may enter `/mcp` when they carry `seedkeep:read` or `seedkeep:write`; tokens with neither are rejected with `insufficient_scope`. Tool discovery and the application callback independently enforce each tool's required scope. Personal MCP tokens remain unrestricted.

**Alternatives considered**: Require both scopes (rejected because it makes read-only grants unusable); accept any valid OAuth token and expose zero tools (rejected because `openid`-only is not MCP authorization).

**Rationale**: Admission should require a Seedkeep capability, while authorization stays per operation. This preserves read-only clients, permits write-only grants to mutate only, and retains defense in depth.

## [2026-07-15] MCP OAuth transport requires both Seedkeep scopes

**Context**: Discovery filtering removed tools outside an OAuth token's scopes, but a direct or future callback invocation could bypass that filter. MCP transport access also needs a single predictable capability contract.

**Decision**: OAuth access tokens reaching `/mcp` must grant both `seedkeep:read` and `seedkeep:write`, otherwise return HTTP 403 with `insufficient_scope`. Enforce the same per-tool scope check inside the application callback. Personal MCP tokens remain unrestricted because they have no OAuth scope set.

**Alternatives considered**: Permit read-only OAuth MCP sessions (rejected for the current all-capabilities MCP contract); rely only on SDK tool registration filtering (rejected because it is not an execution boundary).

**Rationale**: A transport-level check gives clients a standards-compatible scope challenge, while the callback guard remains defense-in-depth if registration behavior changes or a tool is invoked outside discovery.

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

## [2026-05-20] Smart-planting-window recommendation engine

**Context**: iOS 0.2.0 needs per-variety planting-window recommendations. Phase A is the server side: a recommendation API consumed by the iOS client. Full design: `~/git/seedkeep/.docs/ai/specs/2026-05-20-smart-planting-window-design.md`.

**Decision**: A hybrid engine. `src/lib/recommendation/engine.ts` computes a deterministic window from catalog horticultural fields + the household's frost dates; when its confidence is below `CONFIDENCE_THRESHOLD` (0.6) the route (synchronously) or the worker (async) calls an Anthropic fallback. `recommendation_cache` stores only the **season-stable baseline** (window dates, confidence) — the date-relative `verdict` + 60-day score curve are projected per-request by `projection.ts`, so the cache never goes stale as days pass and is invalidated only by Postgres triggers on catalog/household changes. The async AI fill-in runs in a **separate `worker` Fly process** (`src/worker.ts`) to keep the web process stateless.

**Alternatives considered**: Rules-only (rejected — catalog rows are often sparse); AI-only (rejected — cost + latency + non-determinism on the hot path); caching the verdict (rejected — would need daily cache-wide recompute); in-process job loop (rejected — violates the stateless-server constraint).

**Rationale**: Rules handle well-populated catalog rows cheaply and deterministically (unit-tested like `randomPick`/`decideCatalogStatus`); AI covers the sparse tail. Separating the season-stable baseline from the per-read projection is the load-bearing idea — it makes the cache durable for a whole season. The `frost_tolerance` confidence penalty is 0.25 (not 0.20 like the others) so "missing frost_tolerance + soil temp" lands at 0.55, cleanly below the 0.6 AI-fallback gate rather than exactly on it.

## [2026-05-20] ZIP location dataset uses zone-estimated frost dates

**Context**: The engine needs each household's USDA zone + average frost dates, resolved from a home ZIP. `zip_locations` bundles a static ZIP → (lat, lon, zone, last frost, first frost) dataset.

**Decision**: USDA zones (phzmapi.org) and lat/lon centroids (Census ZCTA) are real authoritative data. Frost dates are **zone-estimated** via a 17-entry zone→frost lookup in `scripts/build-zip-dataset.ts` — no clean per-ZIP NOAA dataset was obtainable. All 33,751 rows currently use the zone estimate.

**Alternatives considered**: Real per-ZIP NOAA freeze/frost climatology (not readily available as a bulk join-able file); a third-party geocoding/climate API (rejected — breaks the self-hostable, no-proprietary-API-in-the-path constraint).

**Rationale**: Zone-estimated frost dates are accurate to ~±1–2 weeks — good enough for a planting-*window* feature that already presents ranges, not exact days. Real NOAA data is a clean future upgrade: re-run the build script with a NOAA source, re-seed `zip_locations`; no schema or code change. The trade-off is documented so it isn't mistaken for authoritative data.

## [2026-05-30] OAuth household pin lives in `oauth_user_household`, not better-auth schema

**Context**: better-auth's `oauthAccessToken` row has only `userId` — no household scope. iOS captures the household at pairing-code mint time, but when claude.ai later hits `/mcp` we resolve household from `memberships`. For users with multiple memberships the chosen row diverges from what `requireHousehold` picks for iOS sessions, exposing a different household than the user expected.

**Decision**: Migration 0016 adds a user-keyed `oauth_user_household(user_id PK, household_id, updated_at)` table. `/oauth/pair` UPSERTs the pin using the household captured by the pairing code. `/mcp` resolves household by preferring the pin (joined to memberships for validity), falling back to `ORDER BY joined_at DESC LIMIT 1` for parity with `requireHousehold`.

**Alternatives considered**: Patch better-auth's `oauthAccessToken` row with an extra column (rejected — fights the library); store household in OAuth scope strings (rejected — scopes are user-visible and shouldn't carry per-user state); session-keyed pin (rejected — the access token doesn't carry session_token, so there's no path from access-token → session).

**Rationale**: A separate user-keyed table outside better-auth's schema means library upgrades don't fight us. UPSERT semantics keep the pin in sync with the iOS-time choice on each repair, and `LIMIT 1 + ORDER BY joined_at DESC` fallback matches the existing iOS resolution rule so single-membership users see identical behavior across both paths.

## [2026-05-30] Per-thread stream lock via column on `assistant_threads`

**Context**: The streaming POST and the proposed-change confirmation POST both call Anthropic and persist assistant messages. The pre-existing pending-tool-call SELECT doesn't lock — two devices sending simultaneously could each pass the check and each spawn an orchestration, corrupting conversation history with overlapping placeholder rows.

**Decision**: Migration 0017 adds `stream_lock_at BIGINT` to `assistant_threads`. `acquireStreamLock` runs `UPDATE … SET stream_lock_at = $now WHERE id = $1 AND (stream_lock_at IS NULL OR stream_lock_at < $stale) RETURNING id` — atomic UPDATE-with-conditional-WHERE returns nothing when another stream holds the lock. `releaseStreamLock` clears it in `streamSSE`'s `finally` block. Stale locks (>10 min) auto-release on the next acquire.

**Alternatives considered**: Postgres advisory locks via `pg_try_advisory_lock` (rejected — session-scoped to a connection that pin-holding for ~minutes blocks the postgres.js pool); separate `assistant_thread_locks` table (rejected — heavier than needed, same semantics); UNIQUE-constraint on placeholder messages (rejected — placeholders are intentionally per-orchestration, not per-thread).

**Rationale**: A column on the existing thread row is the lightest representation. The TTL handles crashes mid-stream without manual janitor work. The lock is opportunistic — if it's busy, the second client gets a clean 409 `stream_busy` and can retry, rather than corrupting state.

## [2026-05-30] TOCTOU re-check in `executeProposedChange`

**Context**: The proposed-change card shows the user "was → becomes" snapshot, captured at preview time. By the time the user clicks Confirm, another device or tool call could have mutated the row. Without a re-check, the user authorized one change but a different one happens.

**Decision**: `executeProposedChange` takes an optional `storedWas` (extracted from `proposed_change_json.was` by the /confirm route). Before applying, a new `readCurrentWas` helper re-runs the same SELECT as `previewDestructive` and `wasMatches` does a shallow key-by-key comparison. Divergence returns `status='failed', code='stale_proposal'` — the user must cancel and re-ask so they see the current state.

**Alternatives considered**: `SELECT … FOR UPDATE` around preview+apply (rejected — preview happens during streaming, holding a row lock for ~minutes); accept the race (rejected — destructive ops deserve the re-check); compare hashes of the full row (rejected — works but obscures which field changed; key-by-key is easier to debug).

**Rationale**: The shallow compare is conservative (treats null/undefined as equal so JSON round-tripping doesn't trip the check) and only fires when the row genuinely changed. The error code is distinct so the iOS client can surface a "Refresh and ask Sprout again" UX rather than the generic execution_error string.
