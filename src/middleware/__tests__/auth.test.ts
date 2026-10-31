import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../env';
import type { AppEnv } from '../../index';

const { dbGet, getSession } = vi.hoisted(() => ({ dbGet: vi.fn(), getSession: vi.fn() }));

vi.mock('../../db/client', () => ({ getSql: vi.fn(() => ({})) }));
vi.mock('../../db/helpers', () => ({ dbGet }));
vi.mock('../../lib/auth', () => ({ getAuth: vi.fn(() => ({ api: { getSession } })) }));

const { requireAuth } = await import('../auth');

const env = {
  APP_ENV: 'development',
  WEB_ORIGINS: undefined,
} as Env;

function app() {
  const router = new Hono<AppEnv>();
  router.get('/private', requireAuth(), (c) => c.json({ userId: c.get('userId') }));
  router.post('/private', requireAuth(), (c) => c.json({ userId: c.get('userId') }));
  return router;
}

describe('requireAuth', () => {
  beforeEach(() => {
    dbGet.mockReset();
    getSession.mockReset();
  });

  it('preserves native Bearer sessions without requiring a browser Origin', async () => {
    dbGet.mockResolvedValue({ id: 'session-1', userId: 'native-user', token: 'native-token' });
    const response = await app().request('/private', {
      headers: { authorization: 'Bearer native-token' },
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'native-user' });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('accepts a valid Better Auth cookie session for configured browser origins', async () => {
    getSession.mockResolvedValue({
      response: { user: { id: 'web-user' } },
      headers: new Headers({ 'set-cookie': 'better-auth.session_token=refreshed; Path=/; HttpOnly; SameSite=Lax' }),
    });
    const response = await app().request('/private', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5173',
        cookie: 'better-auth.session_token=fake-session',
      },
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'web-user' });
    expect(response.headers.get('set-cookie')).toContain('better-auth.session_token=refreshed');
    expect(getSession).toHaveBeenCalledWith(expect.objectContaining({
      query: { disableCookieCache: true },
      returnHeaders: true,
    }));
  });

  it('rejects unsafe cookie requests from a missing or untrusted Origin before session lookup', async () => {
    for (const origin of [undefined, 'https://attacker.invalid']) {
      const headers = new Headers({ cookie: 'better-auth.session_token=fake-session' });
      if (origin) headers.set('origin', origin);
      const response = await app().request('/private', { method: 'POST', headers }, env);
      expect(response.status).toBe(403);
    }
    expect(getSession).not.toHaveBeenCalled();
  });

  it('rejects missing or invalid cookie sessions', async () => {
    getSession.mockResolvedValue({ response: null, headers: new Headers() });
    const response = await app().request('/private', { headers: { origin: 'http://localhost:5173' } }, env);
    expect(response.status).toBe(401);
  });

  it('rejects an invalid Bearer token instead of falling back to a cookie', async () => {
    dbGet.mockResolvedValue(null);
    getSession.mockResolvedValue({ response: { user: { id: 'web-user' } }, headers: new Headers() });
    const response = await app().request('/private', {
      headers: { authorization: 'Bearer expired', cookie: 'better-auth.session_token=fake-session' },
    }, env);
    expect(response.status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });
});
