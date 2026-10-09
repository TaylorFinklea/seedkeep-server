/**
 * Web M1 · Phase 2 — browser identity and sessions (integration).
 *
 * Contract under test (spec: .docs/ai/plans/web-m1-p2-sessions.md):
 *   - email one-time sign-in codes via better-auth emailOTP, delivered by
 *     the in-memory mailer (MAIL_PROVIDER=memory) and read with sentMail()
 *   - HttpOnly session cookie, host-only, SameSite=Lax, Path=/, Secure
 *     outside development, using better-auth's cookie name
 *   - exact-Origin CSRF gate for cookie-authenticated unsafe requests
 *   - X-Household-Id household selection, GET /api/households listing
 *   - Bearer precedence and conflicting_credentials
 *   - CORS with credentials for the app origin only
 *   - OTP hardening (serialized verification, attempt limit, expiry,
 *     rate limits keyed on fly-client-ip, disabled paths, mail errors)
 *   - Origin gate on better-auth endpoints and on the OAuth browser forms
 *   - session refresh, forged cookies, deletion revoking the cookie
 *
 * Environment: APP_ENV=staging (so Secure cookies and the __Secure- name
 * apply), PUBLIC_BASE_URL=https://api.example.test,
 * APP_ORIGINS=https://app.example.test, MAIL_PROVIDER=memory.
 *
 * Every test creates its own users and households with unique ids and
 * emails, and uses its own fly-client-ip so rate-limit buckets never leak
 * between tests. Shared tables are never truncated.
 *
 * Run with:
 *   bun test tests/integration/webSessionJourney.test.ts
 *
 * Prerequisites: local Postgres at DATABASE_URL, migrations applied.
 */

import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { createApp } from '../../src/index';

// These tests simulate requests arriving through Fly's proxy, so the
// per-test `fly-client-ip` values are trusted as client IPs (the limiter
// only trusts that header when FLY_APP_NAME is set). Without this, every
// test shares one fallback rate-limit bucket. CI and deploy.sh do not set it.
process.env.FLY_APP_NAME ??= 'seedkeep-integration-test';
import type { Env } from '../../src/env';
import { sentMail } from '../../src/lib/mail';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://seedkeep:dev-only@localhost:5432/seedkeep';

const sql: Sql = postgres(DATABASE_URL, {
  transform: { undefined: null },
  onnotice: () => { /* silence */ },
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (x: number | bigint) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});

const APP_ORIGIN = 'https://app.example.test';
const API_ORIGIN = 'https://api.example.test';
const SESSION_COOKIE = '__Secure-better-auth.session_token';

const BASE_ENV: Env = {
  PORT: 8787,
  APP_ENV: 'staging',
  DATABASE_URL,
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_BUCKET: 'test-bucket',
  S3_FORCE_PATH_STYLE: false,
  PUBLIC_BASE_URL: API_ORIGIN,
  APP_ORIGINS: APP_ORIGIN,
  MAIL_PROVIDER: 'memory',
  RESEND_API_KEY: undefined,
  MAIL_FROM: undefined,
  BETTER_AUTH_SECRET: 'test-better-auth-secret-1234567890',
  APPLE_CLIENT_ID: 'test-apple-client',
  APPLE_CLIENT_SECRET: 'test-apple-secret',
  ANTHROPIC_API_KEY: undefined,
  APPLE_IAP_SHARED_SECRET: undefined,
  ASSISTANT_KEY_MASTER: undefined,
  DEFAULT_VISION_MODEL: 'claude-sonnet-4-6',
  DEFAULT_REVIEW_MODEL: 'claude-haiku-4-5-20251001',
  ADMIN_SECRET: undefined,
  GARDEN_TOOLS_ENABLED: true,
};

/** Staging web environment with the in-memory mailer. */
const WEB_ENV: Env = { ...BASE_ENV };
/** Same, but no mailer configured (MAIL_PROVIDER unset outside development). */
const NO_MAIL_ENV: Env = { ...BASE_ENV, MAIL_PROVIDER: undefined };
/** Same, but the Resend provider is selected (fetch is mocked per test). */
const RESEND_ENV: Env = { ...BASE_ENV, MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'ci-dummy-resend-key' };

// createApp() captures the env it was given and overwrites each request's
// bindings with it, so every env used in a test needs its own app instance.
type App = ReturnType<typeof createApp>;
const apps = new Map<Env, App>();

function appFor(env: Env): App {
  let app = apps.get(env);
  if (!app) {
    app = createApp(env);
    apps.set(env, app);
  }
  return app;
}

const cleanup = {
  userIds: new Set<string>(),
  householdIds: new Set<string>(),
  emails: new Set<string>(),
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

function uniqueEmail(): string {
  const email = `${uid('wsj')}@example.invalid`;
  cleanup.emails.add(email);
  return email;
}

/** Unique fly-client-ip per call so rate-limit buckets stay independent. */
function freshIp(): string {
  return `198.18.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

interface CallInit {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body, serialized with Content-Type application/json. */
  body?: unknown;
  /** Raw string body (for form posts); sets no content type by itself. */
  raw?: string;
}

function call(env: Env, path: string, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['Content-Type'] ??= 'application/json';
  } else if (init.raw !== undefined) {
    body = init.raw;
  }
  return appFor(env).request(path, { method: init.method ?? 'GET', headers, body }, env);
}

interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function json<T = unknown>(res: Response): Promise<Envelope<T>> {
  return (await res.json()) as Envelope<T>;
}

function sessionCookieFrom(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) throw new Error(`no ${SESSION_COOKIE} Set-Cookie on response`);
  return raw.split(';')[0]!;
}

function hasSessionSetCookie(res: Response): boolean {
  return res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`));
}

/** Most recent sign-in code captured for this address by the memory mailer. */
function latestCode(email: string): string {
  const message = [...sentMail()].reverse().find((m) => m.to === email);
  const match = message?.text.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no sign-in code captured for ${email}`);
  return match[1]!;
}

/** A 6-digit code that is guaranteed to differ from `code`. */
function wrongCode(code: string, step = 1): string {
  return String((Number(code) + step) % 1_000_000).padStart(6, '0');
}

function requestCode(
  env: Env,
  email: string,
  ip: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return call(env, '/api/auth/email-otp/send-verification-otp', {
    method: 'POST',
    headers: { Origin: APP_ORIGIN, 'fly-client-ip': ip, ...extraHeaders },
    body: { email, type: 'sign-in' },
  });
}

function signInWithCode(env: Env, email: string, otp: string, ip: string): Promise<Response> {
  return call(env, '/api/auth/sign-in/email-otp', {
    method: 'POST',
    headers: { Origin: APP_ORIGIN, 'fly-client-ip': ip },
    body: { email, otp },
  });
}

interface WebUser {
  email: string;
  userId: string;
  /** Bearer token from the sign-in body (native clients). */
  token: string;
  /** "name=value" ready for a Cookie header. */
  cookie: string;
}

/** Full browser sign-in: send code, read it from the mailer, verify it. */
async function webSignIn(env: Env = WEB_ENV): Promise<WebUser> {
  const email = uniqueEmail();
  const ip = freshIp();
  const sendRes = await requestCode(env, email, ip);
  expect(sendRes.status).toBe(200);
  const res = await signInWithCode(env, email, latestCode(email), ip);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; user: { id: string } };
  cleanup.userIds.add(body.user.id);
  return {
    email,
    userId: body.user.id,
    token: body.token,
    cookie: sessionCookieFrom(res),
  };
}

/** Insert a household and a membership directly. Returns the household id. */
async function insertMembership(
  userId: string,
  role: 'owner' | 'member',
  joinedAt: number,
  name = 'Direct Household',
): Promise<string> {
  const householdId = uid('wsj-hh');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at)
     VALUES ($1, $2, $3, $3)`,
    [householdId, name, now],
  );
  cleanup.householdIds.add(householdId);
  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at)
     VALUES ($1, $2, $3, $4)`,
    [householdId, userId, role, joinedAt],
  );
  return householdId;
}

/** POST /api/households as a cookie session from the app origin. */
async function createHouseholdWithCookie(user: WebUser, name: string): Promise<string> {
  const res = await call(WEB_ENV, '/api/households', {
    method: 'POST',
    headers: { Cookie: user.cookie, Origin: APP_ORIGIN },
    body: { name },
  });
  // Existing contract: POST /api/households returns 200 (see onboardingJourney).
  expect(res.status).toBe(200);
  const body = await json<{ household: { id: string } }>(res);
  const id = body.data!.household.id;
  cleanup.householdIds.add(id);
  return id;
}

/** Native-style user with no household, created through the same OTP path. */
async function seedUserWithHousehold(): Promise<{ userId: string; householdId: string }> {
  const userId = uid('wsj-user');
  const householdId = uid('wsj-hh');
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Pairing User', $2, TRUE, NOW(), NOW())`,
    [userId, `${userId}@example.invalid`],
  );
  cleanup.userIds.add(userId);
  await sql.unsafe(
    `INSERT INTO households (id, name, created_at, updated_at) VALUES ($1, 'Pairing Household', $2, $2)`,
    [householdId, now],
  );
  cleanup.householdIds.add(householdId);
  await sql.unsafe(
    `INSERT INTO memberships (household_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
    [householdId, userId, now],
  );
  return { userId, householdId };
}

beforeAll(async () => {
  await sql`SELECT 1`;
});

afterAll(async () => {
  for (const id of cleanup.householdIds) {
    await sql.unsafe(`DELETE FROM households WHERE id = $1`, [id]).catch(() => {});
  }
  for (const email of cleanup.emails) {
    await sql
      .unsafe(`DELETE FROM verification WHERE identifier LIKE $1`, [`%-otp-${email}`])
      .catch(() => {});
  }
  for (const id of cleanup.userIds) {
    await sql.unsafe(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => {});
  }
  await sql.end({ timeout: 5 });
});

// ─────────────────────────────────────────────────────────────────────────
// 1–5 · Journey: code → sign-in → cookie identity → household create/list
// ─────────────────────────────────────────────────────────────────────────

describe('Web session journey — email code to household API', () => {
  it('requests a code, rejects a wrong code, signs in with the right one, and uses only the cookie', async () => {
    const email = uniqueEmail();
    const ip = freshIp();

    // 1. Request a code; it is captured by the memory mailer.
    const sendRes = await requestCode(WEB_ENV, email, ip);
    expect(sendRes.status).toBe(200);
    const code = latestCode(email);
    expect(code).toMatch(/^\d{6}$/);
    const mail = [...sentMail()].reverse().find((m) => m.to === email);
    expect(mail?.subject).toBe('Your Seedkeep sign-in code');

    // 2a. A wrong code fails and sets no session cookie.
    const wrong = await signInWithCode(WEB_ENV, email, wrongCode(code), ip);
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.status).toBeLessThan(500);
    expect(hasSessionSetCookie(wrong)).toBe(false);

    // 2b. The right code signs in and sets the session cookie.
    const ok = await signInWithCode(WEB_ENV, email, code, ip);
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { token: string; user: { id: string } };
    expect(typeof okBody.token).toBe('string');
    cleanup.userIds.add(okBody.user.id);

    const setCookie = ok.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Secure');
    expect(setCookie).not.toMatch(/Domain=/i);
    const cookie = setCookie!.split(';')[0]!;

    // 3. GET /api/me with only the cookie.
    const me = await call(WEB_ENV, '/api/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const meBody = await json<{ user: { id: string } }>(me);
    expect(meBody.data!.user.id).toBe(okBody.user.id);

    // 4. POST /api/households with the cookie from the allowed origin.
    const create = await call(WEB_ENV, '/api/households', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: APP_ORIGIN },
      body: { name: 'Web Garden' },
    });
    // Existing contract: 200 (matches onboardingJourney), not 201.
    expect(create.status).toBe(200);
    const created = await json<{ household: { id: string }; role: string }>(create);
    expect(created.data!.role).toBe('owner');
    const householdId = created.data!.household.id;
    cleanup.householdIds.add(householdId);

    // 4b. The same call without Origin, or from a foreign origin, is refused.
    const noOrigin = await call(WEB_ENV, '/api/households', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: { name: 'Web Garden' },
    });
    expect(noOrigin.status).toBe(403);
    expect((await json(noOrigin)).error?.code).toBe('csrf_origin_rejected');

    const evil = await call(WEB_ENV, '/api/households', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.test' },
      body: { name: 'Web Garden' },
    });
    expect(evil.status).toBe(403);
    expect((await json(evil)).error?.code).toBe('csrf_origin_rejected');

    // 5. GET /api/households lists the household.
    const list = await call(WEB_ENV, '/api/households', { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
    const listBody = await json<{
      households: { id: string; name: string; role: string; joined_at: number }[];
    }>(list);
    const row = listBody.data!.households.find((h) => h.id === householdId);
    expect(row).toBeDefined();
    expect(row!.name).toBe('Web Garden');
    expect(row!.role).toBe('owner');
    expect(typeof row!.joined_at).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6 · Household selection with X-Household-Id
// ─────────────────────────────────────────────────────────────────────────

describe('Household selection', () => {
  it('X-Household-Id selects one of the caller households; foreign and unknown ids get the same 403', async () => {
    const user = await webSignIn();
    const hhA = await createHouseholdWithCookie(user, 'Garden A');
    const hhB = await insertMembership(user.userId, 'member', Date.now() + 5_000, 'Garden B');

    // Newest membership first.
    const list = await call(WEB_ENV, '/api/households', { headers: { Cookie: user.cookie } });
    expect(list.status).toBe(200);
    const listBody = await json<{ households: { id: string }[] }>(list);
    expect(listBody.data!.households.map((h) => h.id)).toEqual([hhB, hhA]);

    const selectA = await call(WEB_ENV, '/api/households/me', {
      headers: { Cookie: user.cookie, 'X-Household-Id': hhA },
    });
    expect(selectA.status).toBe(200);
    expect((await json<{ household: { id: string } }>(selectA)).data!.household.id).toBe(hhA);

    const selectB = await call(WEB_ENV, '/api/households/me', {
      headers: { Cookie: user.cookie, 'X-Household-Id': hhB },
    });
    expect(selectB.status).toBe(200);
    expect((await json<{ household: { id: string } }>(selectB)).data!.household.id).toBe(hhB);

    // Header absent: newest membership, as before (old iOS builds).
    const noHeader = await call(WEB_ENV, '/api/households/me', { headers: { Cookie: user.cookie } });
    expect(noHeader.status).toBe(200);
    expect((await json<{ household: { id: string } }>(noHeader)).data!.household.id).toBe(hhB);

    // A household that exists but belongs to someone else.
    const other = await webSignIn();
    const foreignId = await createHouseholdWithCookie(other, 'Not Yours');
    const foreign = await call(WEB_ENV, '/api/households/me', {
      headers: { Cookie: user.cookie, 'X-Household-Id': foreignId },
    });
    expect(foreign.status).toBe(403);
    const foreignBody = await json(foreign);
    expect(foreignBody.error?.code).toBe('household_forbidden');

    // A household id that does not exist: identical response.
    const missing = await call(WEB_ENV, '/api/households/me', {
      headers: { Cookie: user.cookie, 'X-Household-Id': uid('wsj-missing') },
    });
    expect(missing.status).toBe(403);
    const missingBody = await json(missing);
    expect(missingBody.error).toEqual(foreignBody.error);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7 · Bearer and cookie precedence
// ─────────────────────────────────────────────────────────────────────────

describe('Credential precedence', () => {
  it('Bearer wins with no cookie fallback; conflicting users are refused', async () => {
    const userA = await webSignIn();
    const userB = await webSignIn();

    // Bearer for A with a cookie for B: different users.
    const conflict = await call(WEB_ENV, '/api/me', {
      headers: { Authorization: `Bearer ${userA.token}`, Cookie: userB.cookie },
    });
    expect(conflict.status).toBe(401);
    expect((await json(conflict)).error?.code).toBe('conflicting_credentials');

    // Garbage Bearer with a valid cookie: no fallback to the cookie.
    const badBearer = await call(WEB_ENV, '/api/me', {
      headers: { Authorization: 'Bearer not-a-real-token', Cookie: userA.cookie },
    });
    expect(badBearer.status).toBe(401);
    expect((await json(badBearer)).error?.code).toBe('unauthorized');

    // Bearer and cookie for the same user: allowed.
    const sameUser = await call(WEB_ENV, '/api/me', {
      headers: { Authorization: `Bearer ${userA.token}`, Cookie: userA.cookie },
    });
    expect(sameUser.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8 · CORS preflight with credentials
// ─────────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('preflight for PUT from the app origin allows credentials; a foreign origin gets no allow header', async () => {
    const preflight = await call(WEB_ENV, '/api/households/me', {
      method: 'OPTIONS',
      headers: {
        Origin: APP_ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type,x-household-id',
      },
    });
    expect(preflight.status).toBeGreaterThanOrEqual(200);
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
    expect(preflight.headers.get('access-control-allow-methods') ?? '').toContain('PUT');
    expect((preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain(
      'x-household-id',
    );

    const foreign = await call(WEB_ENV, '/api/households/me', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.test',
        'Access-Control-Request-Method': 'PUT',
      },
    });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9 · Native Bearer journey stays green (no Origin header)
// ─────────────────────────────────────────────────────────────────────────

describe('Native Bearer clients', () => {
  it('Bearer-only requests with no Origin still work for identity and household create', async () => {
    const user = await webSignIn();
    const me = await call(WEB_ENV, '/api/me', {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(me.status).toBe(200);

    const create = await call(WEB_ENV, '/api/households', {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token}` },
      body: { name: 'Native Garden' },
    });
    expect(create.status).toBe(200);
    cleanup.householdIds.add((await json<{ household: { id: string } }>(create)).data!.household.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10 · OTP hardening
// ─────────────────────────────────────────────────────────────────────────

describe('Email OTP hardening', () => {
  it('concurrent correct sign-ins with one code: exactly one succeeds', async () => {
    const email = uniqueEmail();
    const ip = freshIp();
    expect((await requestCode(WEB_ENV, email, ip)).status).toBe(200);
    const code = latestCode(email);

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => signInWithCode(WEB_ENV, email, code, ip)),
    );
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBe(1);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    for (const r of successes) {
      cleanup.userIds.add(((await r.json()) as { user: { id: string } }).user.id);
    }
  });

  it('concurrent wrong guesses use up the attempt limit, so the right code then fails', async () => {
    const email = uniqueEmail();
    const ip = freshIp();
    expect((await requestCode(WEB_ENV, email, ip)).status).toBe(200);
    const code = latestCode(email);

    const guesses = await Promise.all(
      [1, 2, 3, 4, 5].map((step) => signInWithCode(WEB_ENV, email, wrongCode(code, step), ip)),
    );
    for (const r of guesses) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(hasSessionSetCookie(r)).toBe(false);
    }

    const afterLimit = await signInWithCode(WEB_ENV, email, code, ip);
    expect(afterLimit.status).toBeGreaterThanOrEqual(400);
    expect(hasSessionSetCookie(afterLimit)).toBe(false);
  });

  it('an expired code fails', async () => {
    const email = uniqueEmail();
    const ip = freshIp();
    expect((await requestCode(WEB_ENV, email, ip)).status).toBe(200);
    const code = latestCode(email);

    await sql.unsafe(
      `UPDATE verification SET "expiresAt" = NOW() - INTERVAL '1 second'
        WHERE identifier = $1`,
      [`sign-in-otp-${email}`],
    );

    const expired = await signInWithCode(WEB_ENV, email, code, ip);
    expect(expired.status).toBeGreaterThanOrEqual(400);
    expect(hasSessionSetCookie(expired)).toBe(false);
  });

  it('sending is limited to 3 per 60 seconds per fly-client-ip; a forged X-Forwarded-For does not reset it', async () => {
    const email = uniqueEmail();
    const ip = freshIp();
    for (let i = 0; i < 3; i += 1) {
      expect((await requestCode(WEB_ENV, email, ip)).status).toBe(200);
    }

    const fourth = await requestCode(WEB_ENV, email, ip);
    expect(fourth.status).toBe(429);

    const forged = await requestCode(WEB_ENV, email, ip, {
      'X-Forwarded-For': '203.0.113.99',
    });
    expect(forged.status).toBe(429);
  });

  it('only the sign-in type is accepted by the send endpoint', async () => {
    const res = await call(WEB_ENV, '/api/auth/email-otp/send-verification-otp', {
      method: 'POST',
      headers: { Origin: APP_ORIGIN, 'fly-client-ip': freshIp() },
      body: { email: uniqueEmail(), type: 'email-verification' },
    });
    expect(res.status).toBe(400);
  });

  it('disabled emailOTP paths return 404', async () => {
    const headers = { Origin: APP_ORIGIN, 'fly-client-ip': freshIp() };
    const email = uniqueEmail();
    const paths = [
      '/api/auth/email-otp/check-verification-otp',
      '/api/auth/email-otp/forget-password',
      '/api/auth/email-otp/reset-password',
      '/api/auth/email-otp/verify-email',
    ];
    for (const path of paths) {
      const res = await call(WEB_ENV, path, {
        method: 'POST',
        headers,
        body: { email, type: 'sign-in', otp: '000000' },
      });
      expect(res.status).toBe(404);
    }
  });

  it('with MAIL_PROVIDER unset outside development, sending a code returns 503 mail_not_configured', async () => {
    const res = await requestCode(NO_MAIL_ENV, uniqueEmail(), freshIp());
    expect(res.status).toBe(503);
    expect((await json(res)).error?.code).toBe('mail_not_configured');
  });

  it('a failing mail provider returns 502 mail_send_failed and leaves no usable code', async () => {
    const email = uniqueEmail();
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response('{"message":"provider down"}', { status: 500 })) as unknown as typeof fetch,
    );
    let res: Response;
    try {
      res = await requestCode(RESEND_ENV, email, freshIp());
    } finally {
      fetchSpy.mockRestore();
    }
    expect(res.status).toBe(502);
    expect((await json(res)).error?.code).toBe('mail_send_failed');

    // No stored code remains for this address after the failed send.
    const rows = await sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM verification WHERE identifier = $1`,
      [`sign-in-otp-${email}`],
    );
    expect(rows[0]!.n).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 11 · Origin gate on better-auth endpoints
// ─────────────────────────────────────────────────────────────────────────

describe('better-auth Origin gate', () => {
  it('sign-out is refused for a foreign or missing Origin on a cookie, and succeeds from the app origin', async () => {
    const user = await webSignIn();

    const foreign = await call(WEB_ENV, '/api/auth/sign-out', {
      method: 'POST',
      headers: { Cookie: user.cookie, Origin: 'https://evil.test' },
    });
    expect(foreign.status).toBe(403);
    expect((await json(foreign)).error?.code).toBe('csrf_origin_rejected');

    const stillSignedIn = await call(WEB_ENV, '/api/me', { headers: { Cookie: user.cookie } });
    expect(stillSignedIn.status).toBe(200);

    const noOrigin = await call(WEB_ENV, '/api/auth/sign-out', {
      method: 'POST',
      headers: { Cookie: user.cookie },
    });
    expect(noOrigin.status).toBe(403);
    expect((await json(noOrigin)).error?.code).toBe('csrf_origin_rejected');

    const allowed = await call(WEB_ENV, '/api/auth/sign-out', {
      method: 'POST',
      headers: { Cookie: user.cookie, Origin: APP_ORIGIN },
    });
    expect(allowed.status).toBe(200);

    const afterSignOut = await call(WEB_ENV, '/api/me', { headers: { Cookie: user.cookie } });
    expect(afterSignOut.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 12 · OAuth browser forms (/oauth/pair, /oauth2/consent)
// ─────────────────────────────────────────────────────────────────────────

async function insertPairingCode(userId: string, householdId: string): Promise<string> {
  const code = Math.random().toString(36).slice(2, 10).toUpperCase();
  await sql.unsafe(
    `INSERT INTO web_pairing_codes (code, user_id, household_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [code, userId, householdId, Date.now() + 10 * 60 * 1000],
  );
  return code;
}

async function pairingCodeUsed(code: string): Promise<boolean> {
  const rows = await sql.unsafe<{ used_at: number | null }[]>(
    `SELECT used_at FROM web_pairing_codes WHERE code = $1`,
    [code],
  );
  return rows[0]!.used_at !== null;
}

describe('OAuth browser forms Origin gate', () => {
  it('/oauth/pair requires the API origin; a rejected post does not consume the code', async () => {
    const { userId, householdId } = await seedUserWithHousehold();
    const code = await insertPairingCode(userId, householdId);
    const form = new URLSearchParams({ code }).toString();
    const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };

    const foreign = await call(WEB_ENV, '/oauth/pair', {
      method: 'POST',
      headers: { ...formHeaders, Origin: 'https://evil.test' },
      raw: form,
    });
    expect(foreign.status).toBe(403);
    expect(await pairingCodeUsed(code)).toBe(false);

    const noOrigin = await call(WEB_ENV, '/oauth/pair', {
      method: 'POST',
      headers: formHeaders,
      raw: form,
    });
    expect(noOrigin.status).toBe(403);
    expect(await pairingCodeUsed(code)).toBe(false);

    const own = await call(WEB_ENV, '/oauth/pair', {
      method: 'POST',
      headers: { ...formHeaders, Origin: API_ORIGIN },
      raw: form,
    });
    expect(own.status).toBe(200);
    expect(await pairingCodeUsed(code)).toBe(true);

    // The pairing cookie uses better-auth's name and attributes, and works.
    const setCookie = own.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/');
    const me = await call(WEB_ENV, '/api/me', { headers: { Cookie: setCookie!.split(';')[0]! } });
    expect(me.status).toBe(200);
  });

  it('/oauth2/consent applies the same Origin rule', async () => {
    const form = new URLSearchParams({ consent_code: 'not-a-real-consent', accept: 'true' }).toString();
    const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };

    const foreign = await call(WEB_ENV, '/oauth2/consent', {
      method: 'POST',
      headers: { ...formHeaders, Origin: 'https://evil.test' },
      raw: form,
    });
    expect(foreign.status).toBe(403);

    const noOrigin = await call(WEB_ENV, '/oauth2/consent', {
      method: 'POST',
      headers: formHeaders,
      raw: form,
    });
    expect(noOrigin.status).toBe(403);

    const own = await call(WEB_ENV, '/oauth2/consent', {
      method: 'POST',
      headers: { ...formHeaders, Origin: API_ORIGIN },
      raw: form,
    });
    expect(own.status).not.toBe(403);
    expect(await own.text()).not.toContain('csrf_origin_rejected');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 13 · Session token handling
// ─────────────────────────────────────────────────────────────────────────

describe('Session tokens', () => {
  it('garbage and wrongly signed session cookies get 401', async () => {
    const garbage = await call(WEB_ENV, '/api/me', {
      headers: { Cookie: `${SESSION_COOKIE}=garbage` },
    });
    expect(garbage.status).toBe(401);
    expect((await json(garbage)).error?.code).toBe('unauthorized');

    const user = await webSignIn();
    const token = user.cookie.slice(`${SESSION_COOKIE}=`.length).split('.')[0]!;
    const forged = await call(WEB_ENV, '/api/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${token}.${'A'.repeat(44)}` },
    });
    expect(forged.status).toBe(401);
  });

  it('a session older than updateAge refreshes through the cookie with a new Set-Cookie', async () => {
    const user = await webSignIn();
    await sql.unsafe(
      `UPDATE session
          SET "createdAt" = NOW() - INTERVAL '2 days',
              "updatedAt" = NOW() - INTERVAL '2 days',
              "expiresAt" = NOW() + INTERVAL '28 days'
        WHERE "userId" = $1`,
      [user.userId],
    );

    const res = await call(WEB_ENV, '/api/me', { headers: { Cookie: user.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
  });

  it('after DELETE /api/me the cookie no longer authenticates', async () => {
    const user = await webSignIn();
    const receiptHash = createHash('sha256').update(uid('receipt')).digest('hex');

    const del = await call(WEB_ENV, '/api/me', {
      method: 'DELETE',
      headers: { Cookie: user.cookie, Origin: APP_ORIGIN },
      body: { cloudkit_disposition: 'no_cloudkit_garden', deletion_receipt_hash: receiptHash },
    });
    expect(del.status).toBe(200);
    expect((await json<{ deleted: boolean }>(del)).data!.deleted).toBe(true);

    const after = await call(WEB_ENV, '/api/me', { headers: { Cookie: user.cookie } });
    expect(after.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Security fix round
// ─────────────────────────────────────────────────────────────────────────

const SETTLE_LIMIT_MS = 10_000;

/** Resolves to the value, or the sentinel if `ms` elapses first. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | 'deadline'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function errorCodeOf(body: unknown): string | null {
  const b = body as { error?: { code?: string }; code?: string } | null;
  return b?.error?.code ?? b?.code ?? null;
}

describe('OTP send does not deadlock under pool pressure (a)', () => {
  it('12 concurrent sends for 12 emails from 12 IPs all settle within 10s and /api/health still answers', async () => {
    const requests = Array.from({ length: 12 }, () => ({ email: uniqueEmail(), ip: freshIp() }));

    const started = Date.now();
    const sends = Promise.all(
      requests.map(async ({ email, ip }) => {
        const res = await requestCode(WEB_ENV, email, ip);
        const body = await res.json().catch(() => null);
        return { status: res.status, code: errorCodeOf(body) };
      }),
    );
    const outcome = await withDeadline(sends, SETTLE_LIMIT_MS);

    expect(outcome).not.toBe('deadline');
    expect(Date.now() - started).toBeLessThan(SETTLE_LIMIT_MS);
    const results = outcome as Array<{ status: number; code: string | null }>;
    expect(results.length).toBe(12);
    for (const r of results) {
      if (r.status === 200) continue;
      expect(r.status).toBe(429);
      expect(['otp_busy', 'rate_limited']).toContain(r.code);
    }

    const health = await call(WEB_ENV, '/api/health');
    expect(health.status).toBe(200);
  }, 30_000);
});

describe('Sign-in Content-Type gate (b)', () => {
  it('form-encoded bodies under a mixed Content-Type get 415 and cannot be used to guess the code', async () => {
    const email = uniqueEmail();
    expect((await requestCode(WEB_ENV, email, freshIp())).status).toBe(200);
    const code = latestCode(email);

    const mixedContentType = 'application/x-www-form-urlencoded,application/json';

    // 8 concurrent wrong guesses sent as form bodies under the mixed header.
    const malformed = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((step) =>
        call(WEB_ENV, '/api/auth/sign-in/email-otp', {
          method: 'POST',
          headers: {
            Origin: APP_ORIGIN,
            'Content-Type': mixedContentType,
            'fly-client-ip': freshIp(),
          },
          raw: new URLSearchParams({ email, otp: wrongCode(code, step) }).toString(),
        }),
      ),
    );
    for (const res of malformed) {
      expect(res.status).toBe(415);
      expect(errorCodeOf(await res.json())).toBe('unsupported_media_type');
    }

    // 3 normal wrong guesses (JSON), each from its own IP.
    for (const step of [9, 10, 11]) {
      const res = await signInWithCode(WEB_ENV, email, wrongCode(code, step), freshIp());
      expect(res.status).toBeGreaterThanOrEqual(400);
    }

    // The correct code must not sign in now.
    const correct = await signInWithCode(WEB_ENV, email, code, freshIp());
    expect(correct.status).not.toBe(200);
    expect(hasSessionSetCookie(correct)).toBe(false);
  });
});

describe('Per-email send limit without a trusted IP header (c)', () => {
  it('with no fly-client-ip, the 4th send for one email is 429 rate_limited (3 per 10 minutes)', async () => {
    const email = uniqueEmail();
    const send = () =>
      call(WEB_ENV, '/api/auth/email-otp/send-verification-otp', {
        method: 'POST',
        headers: { Origin: APP_ORIGIN },
        body: { email, type: 'sign-in' },
      });

    for (let i = 0; i < 3; i += 1) {
      expect((await send()).status).toBe(200);
    }
    const fourth = await send();
    expect(fourth.status).toBe(429);
    expect(errorCodeOf(await fourth.json())).toBe('rate_limited');
  });
});

describe('OAuth consent Origin gate (d)', () => {
  it('POST /api/auth/oauth2/consent with a valid session cookie and a foreign Origin is 403', async () => {
    const user = await webSignIn();
    const res = await call(WEB_ENV, '/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { Cookie: user.cookie, Origin: 'https://evil.test' },
      body: { accept: true, consent_code: 'not-a-real-consent' },
    });
    expect(res.status).toBe(403);
  });
});

describe('Resend timeouts (e)', () => {
  it('an aborted or timed-out Resend request returns 502 mail_send_failed and leaves no usable code', async () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      const email = uniqueEmail();
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        (async () => {
          throw new DOMException(`request ${name}`, name);
        }) as unknown as typeof fetch,
      );
      let res: Response;
      try {
        res = await requestCode(RESEND_ENV, email, freshIp());
      } finally {
        fetchSpy.mockRestore();
      }
      expect(res.status).toBe(502);
      expect(errorCodeOf(await res.json())).toBe('mail_send_failed');

      const rows = await sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM verification WHERE identifier = $1`,
        [`sign-in-otp-${email}`],
      );
      expect(rows[0]!.n).toBe(0);
    }
  });
});

describe('Memory mailer refused outside test (f)', () => {
  it('APP_ENV production with MAIL_PROVIDER memory and NODE_ENV not test gives 503 mail_not_configured', async () => {
    const PROD_MEMORY_ENV: Env = { ...BASE_ENV, APP_ENV: 'production', MAIL_PROVIDER: 'memory' };
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let res: Response;
    try {
      res = await requestCode(PROD_MEMORY_ENV, uniqueEmail(), freshIp());
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
    expect(res.status).toBe(503);
    expect(errorCodeOf(await res.json())).toBe('mail_not_configured');
  });
});
