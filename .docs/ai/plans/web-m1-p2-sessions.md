# Web M1 · Phase 2 — Browser identity and sessions

Umbrella plan: `~/git/seedkeep/.docs/ai/phases/2026-10-09-web-app-plan.md`.
Branch: `web/m1-p2-sessions`.

Goal: a browser on an allowed web origin (staging
`https://app-staging.seedkeep.app`, production `https://app.seedkeep.app`,
local `http://localhost:5173`) can sign in with an email one-time code. It then
calls every household API with an HttpOnly session cookie, protected by an
exact-Origin CSRF gate, and can choose which of its households to act on.
Native iOS Bearer auth keeps working unchanged.

No CloudKit or Apple-account migration. Apple sign-in stays for old builds.

## Contract (parent-owned; do not edit)

- `src/env.ts`: new optional variables `PUBLIC_BASE_URL`, `APP_ORIGINS`,
  `MAIL_PROVIDER` ('resend' | 'log' | 'memory'), `RESEND_API_KEY`,
  `MAIL_FROM`. Their defaults are applied in code (see below).
- `src/index.ts`: `AppEnv.Variables.authMethod: 'bearer' | 'cookie'`.
- Stubs with final signatures: `src/lib/mail/index.ts` (`Mailer`,
  `getMailer`, `sentMail`, `clearSentMail`) and `src/lib/web/origins.ts`
  (`appOrigins`, `isAllowedAppOrigin`).
- Error codes (envelope `{ ok:false, error:{ code, message } }`):

  | Code | Status | Meaning |
  |---|---|---|
  | `unauthorized` | 401 | existing behaviour |
  | `conflicting_credentials` | 401 | Bearer and cookie name different users |
  | `csrf_origin_rejected` | 403 | cookie-authenticated unsafe request without an allowed Origin |
  | `household_forbidden` | 403 | `X-Household-Id` is not one of the caller's households |
  | `mail_not_configured` | 503 | sign-in code requested where no mailer is configured |

## Behaviour

### 1. Public base URL (`src/lib/auth.ts`)
`publicBaseURL(env)` returns `PUBLIC_BASE_URL` when set. Otherwise:
- production → `https://seedkeep-server.fly.dev`. This must stay
  byte-identical to today, because the claude.ai OAuth issuer depends on it.
- development → `http://localhost:${PORT}`.
- staging → throw at boot with a clear message.

### 2. Email one-time code (better-auth `emailOTP` plugin, 1.6.9)
- Sign-in only: `type: 'sign-in'`. Codes are 6 digits, expire after 300
  seconds, and allow 3 attempts. Unknown emails auto-create a user, whose
  household is created by the client afterwards.
- `sendVerificationOTP` sends through `getMailer(env)`:
  - subject: "Your Seedkeep sign-in code"
  - text: "Your Seedkeep sign-in code is 123456. It expires in 5 minutes.
    If you didn't ask for it, ignore this email."
  - plus a minimal HTML version
  - With no mailer, the send endpoint responds 503 `mail_not_configured`,
    in the envelope shape where possible.
- Rate limits use better-auth's built-in limiter:
  - send-code: 3 per 60 seconds per IP
  - sign-in attempts: 10 per 60 seconds per IP
- Endpoints (standard better-auth paths under `/api/auth`):
  - `POST /api/auth/email-otp/send-verification-otp` with
    `{ email, type: 'sign-in' }`
  - `POST /api/auth/sign-in/email-otp` with `{ email, otp }`
- An email that already belongs to an Apple-created user signs into that
  user, since the code proves email ownership. Nothing else is merged.

### 3. Mail (`src/lib/mail`)
`getMailer` provider rules:
- **resend:** `POST https://api.resend.com/emails` with
  `Authorization: Bearer RESEND_API_KEY` and the `from` sender. Requires a
  non-blank trimmed key, otherwise null. Non-2xx responses reject, and the
  key is never logged.
- **log:** writes `[mail:dev] to=… subject=… text=…` to the console. It is
  refused (null) when APP_ENV is production or staging.
- **memory:** captures messages for `sentMail()` and `clearSentMail()`.
- **Unset MAIL_PROVIDER:** 'log' in development, null otherwise.

The sender defaults to `Seedkeep <login@seedkeep.app>`.

### 4. Session cookie (better-auth `advanced`)
- `useSecureCookies` is true unless APP_ENV is development.
- The session cookie is host-only (no `Domain`) with `Path=/`, `HttpOnly`,
  `SameSite=Lax` and `Secure` (outside development).
- Prefer the name `__Host-seedkeep.session_token` if better-auth 1.6.9 can
  set it without double-prefixing (verify in code). Otherwise accept
  better-auth's `__Secure-` name and record why.
- `crossSubDomainCookies` stays disabled.
- Sign-in responses keep returning `token` in the body (native clients), and
  also set the cookie (browsers).

### 5. Origins, CORS, trustedOrigins (`src/lib/web/origins.ts`, `src/index.ts`)
- `appOrigins(env)` parses `APP_ORIGINS` (comma-separated), trims entries,
  drops empties, and drops a trailing slash.
- `isAllowedAppOrigin(env, origin)`:
  - true for an exact `appOrigins` match
  - in development only, also true for `http://localhost:<port>` and
    `http://127.0.0.1:<port>`
  - false for null, empty, `"null"`, or anything else
- CORS:
  - A request with no Origin header passes through (native clients).
  - An allowed origin is echoed back, with `credentials: true`.
  - Any other origin is refused.
  - Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS.
  - Allowed headers: Content-Type, Authorization, X-Household-Id,
    If-Match.
  - Exposed headers: x-request-id, ETag.
  - Production no longer accepts localhost origins. Non-production keeps
    them.
- better-auth `trustedOrigins`: the existing native and claude.ai entries
  (`seedkeep://*`, `https://claude.ai`, `https://*.claude.ai`, this server's
  public base URL), plus `appOrigins(env)`, plus `http://localhost:*` only in
  development.

### 6. `requireAuth()` (`src/middleware/auth.ts`)
Precedence:
1. **An `Authorization` header is present:**
   - It must be `Bearer <token>` and resolve to an unexpired session,
     otherwise 401 `unauthorized`. There is never a fallback to the cookie.
   - If a session cookie is also present and resolves to a different user,
     respond 401 `conflicting_credentials`.
   - Set `authMethod='bearer'`.
2. **Otherwise, with a better-auth session cookie:**
   - Validate it through `auth.api.getSession({ headers, returnHeaders: true })`,
     or the 1.6.9 equivalent that verifies the signature and expiry.
   - Pass any `Set-Cookie` renewal headers on to the final response.
   - Invalid or expired → 401 `unauthorized`.
   - For unsafe methods (POST, PUT, PATCH, DELETE), `isAllowedAppOrigin(env,
     Origin)` must hold, otherwise 403 `csrf_origin_rejected`. A missing or
     `null` Origin is rejected; `Sec-Fetch-Site` alone is not trusted.
   - Set `authMethod='cookie'`.
3. **Neither:** 401 `unauthorized`, as today.

`/mcp` keeps its own Bearer-only authentication; it is out of scope.

### 7. Household selection (`src/middleware/household.ts`, `src/routes/households.ts`)
- **`X-Household-Id` header present:** the caller must have a membership for
  it, otherwise 403 `household_forbidden`. The response is the same whether
  the household exists or not.
- **Header absent:** keep today's behaviour (newest membership) for old iOS
  builds.
- **New `GET /api/households`** (`requireAuth` only) returns
  `{ ok:true, data:{ households:[{ id, name, role, joined_at }] } }`, newest
  first.
- `POST /api/households` (create) keeps its existing contract. Verify that it
  works for a cookie session from an allowed origin.

### 8. Deploy safety (`scripts/deploy.sh`, new `fly.staging.toml`)
- `scripts/deploy.sh <staging|production>`:
  - The environment argument is required; there is no default.
  - It refuses a dirty tree and runs the full gate first (typecheck, unit,
    integration).
  - staging uses `fly.staging.toml` with app `seedkeep-server-staging`;
    production uses `fly.toml` with app `seedkeep-server`.
  - It runs `fly deploy --config … --app …`, then polls `/api/health`
    (staging URL `https://api-staging.seedkeep.app`, production unchanged)
    for up to 120 seconds. A health failure exits non-zero.
  - Production asks for typed confirmation unless `CONFIRM=production` is
    set.
- `fly.staging.toml`: a copy of `fly.toml` with app
  `seedkeep-server-staging`, the same processes and checks,
  `min_machines_running = 1` for the app process, and
  `[env] APP_ENV = "staging"`. Secrets stay out of the file.
- Do not create Fly resources or deploy. This phase only adds the files.

## File ownership

| Files | Owner |
|---|---|
| contract files above, `docs`, `.docs/ai/**` | Parent |
| `src/lib/auth.ts`, `src/lib/mail/**`, `src/lib/web/**`, `src/middleware/auth.ts`, `src/middleware/household.ts`, `src/index.ts` (CORS block only), `src/routes/households.ts` (new GET route only), unit tests under `src/**/__tests__/` for these | **Luna** |
| `tests/integration/webSessionJourney.test.ts` (new), `scripts/deploy.sh`, `fly.staging.toml` (new), `README.md` ("Web clients" and "Deploying" sections) | **Haiku** |

## Tests

**Luna — unit tests (vitest):**
- `appOrigins` parsing
- `isAllowedAppOrigin` across environments and edge origins
- the `getMailer` selection matrix: resend without a key gives null; log is
  refused in staging and production; memory captures messages
- the CORS origin callback for no-origin, allowed, localhost (dev vs prod)
  and foreign origins
- `publicBaseURL` defaults, including the staging throw
- `requireAuth` precedence, using a stubbed session lookup if needed

**Haiku — integration tests (`bun test`, real Postgres, `MAIL_PROVIDER=memory`,
`APP_ORIGINS=https://app.example.test`)** cover this journey:
1. Request a code; it is captured in memory.
2. A wrong code fails; the right code signs in. The response sets the
   session cookie with the HttpOnly, SameSite=Lax and Path=/ attributes, plus
   Secure outside development.
3. `GET /api/me` with only the cookie → 200.
4. `POST /api/households` with the cookie and `Origin: https://app.example.test`
   → 201. The same call without Origin, or with `Origin: https://evil.test`,
   → 403 `csrf_origin_rejected`.
5. `GET /api/households` lists the household.
6. With two households, `X-Household-Id` selects one. A foreign id → 403
   `household_forbidden`.
7. An invalid Bearer plus a valid cookie → 401. A Bearer for user A plus a
   cookie for user B → 401 `conflicting_credentials`.
8. CORS preflight for `PUT` from the app origin succeeds with
   `Access-Control-Allow-Credentials: true`. A foreign origin gets no allow
   header.
9. The existing Bearer journeys stay green.

Every test creates its own users and households, and cleans up or uses unique
ids. Never truncate shared tables.

## Gates

Run these with the CI-equivalent environment:
- `bun run typecheck` must be clean.
- `bun run test`.
- `bun test tests/integration/` against your own database. Each worker gets a
  separate one: `seedkeep_luna` and `seedkeep_haiku` in the same local
  container.

Do not commit. Report the files changed, the test counts, and any contract
issue.
