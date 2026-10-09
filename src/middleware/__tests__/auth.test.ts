import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../index';

const mocks = vi.hoisted(() => ({
  dbGet: vi.fn(), getSql: vi.fn(), getAuth: vi.fn(), getSessionCookie: vi.fn(),
  sessionLookup: vi.fn(),
}));
vi.mock('../../db/helpers', () => ({ dbGet: mocks.dbGet }));
vi.mock('../../db/client', () => ({ getSql: mocks.getSql }));
vi.mock('../../lib/auth', () => ({ getAuth: mocks.getAuth, getSessionCookie: mocks.getSessionCookie }));

import { requireAuth } from '../auth';

const env = {
  PORT: 8787, APP_ENV: 'development', DATABASE_URL: 'postgres://seedkeep:test@localhost/seedkeep',
  S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'key', S3_SECRET_ACCESS_KEY: 'secret', S3_BUCKET: 'bucket',
  S3_FORCE_PATH_STYLE: false, BETTER_AUTH_SECRET: 'test-secret-at-least-16', APPLE_CLIENT_ID: 'client',
  APPLE_CLIENT_SECRET: 'secret', DEFAULT_VISION_MODEL: 'vision', DEFAULT_REVIEW_MODEL: 'review',
  GARDEN_TOOLS_ENABLED: false, APP_ORIGINS: 'https://app.example.test',
} as const;

function makeApp() {
  const app = new Hono<AppEnv>();
  app.get('/protected', requireAuth(), (c) => c.json({ method: c.get('authMethod'), userId: c.get('userId') }));
  app.post('/protected', requireAuth(), (c) => c.json({ method: c.get('authMethod'), userId: c.get('userId') }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSql.mockReturnValue({});
  mocks.getSessionCookie.mockResolvedValue({ name: 'better-auth.session_token', attributes: {} });
  mocks.getAuth.mockReturnValue({ api: { getSession: mocks.sessionLookup } });
  mocks.sessionLookup.mockImplementation(async ({ headers, returnHeaders }) => {
    const cookie = headers.get('cookie') ?? '';
    const session = cookie.includes('token=valid-a') ? { user: { id: 'user-a' }, session: { token: 'valid-a' } }
      : cookie.includes('token=valid-b') ? { user: { id: 'user-b' }, session: { token: 'valid-b' } }
      : null;
    return returnHeaders ? { response: session, headers: new Headers() } : session;
  });
  mocks.dbGet.mockResolvedValue({ id: 'session-a', userId: 'user-a', token: 'bearer-a' });
});

describe('requireAuth credential precedence', () => {
  it('does not fall back from an invalid Bearer header to a valid cookie', async () => {
    mocks.dbGet.mockResolvedValue(null);
    const response = await makeApp().request('/protected', { headers: { Authorization: 'Bearer invalid', Cookie: 'better-auth.session_token=token=valid-a' } }, env);
    expect(response.status).toBe(401);
    expect(mocks.sessionLookup).not.toHaveBeenCalled();
  });

  it('rejects valid Bearer and cookie credentials for different users', async () => {
    const response = await makeApp().request('/protected', { headers: { Authorization: 'Bearer bearer-a', Cookie: 'better-auth.session_token=token=valid-b' } }, env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'conflicting_credentials' } });
  });

  it('selects Bearer when both credentials resolve to the same user', async () => {
    const response = await makeApp().request('/protected', { headers: { Authorization: 'Bearer bearer-a', Cookie: 'better-auth.session_token=token=valid-a' } }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: 'bearer', userId: 'user-a' });
  });

  it('rejects cookie-authenticated unsafe requests without an allowed Origin', async () => {
    const response = await makeApp().request('/protected', { method: 'POST', headers: { Cookie: 'better-auth.session_token=token=valid-a' } }, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'csrf_origin_rejected' } });
    expect(mocks.sessionLookup).not.toHaveBeenCalled();
  });

  it('accepts cookie requests from an allowed Origin and forwards renewal cookies', async () => {
    mocks.sessionLookup.mockResolvedValue({
      response: { user: { id: 'user-a' }, session: { token: 'valid-a' } },
      headers: new Headers({ 'set-cookie': 'better-auth.session_token=renewed; HttpOnly' }),
    });
    const response = await makeApp().request('/protected', { method: 'POST', headers: {
      Cookie: 'better-auth.session_token=token=valid-a', Origin: 'https://app.example.test',
    } }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('renewed');
    expect(await response.json()).toEqual({ method: 'cookie', userId: 'user-a' });
  });
});
