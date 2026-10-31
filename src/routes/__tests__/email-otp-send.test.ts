import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../env';
import type { Auth } from '../../lib/auth';

const { reserveEmailOtpSend, getSql, authHandler } = vi.hoisted(() => ({
  reserveEmailOtpSend: vi.fn(),
  getSql: vi.fn(() => ({})),
  authHandler: vi.fn(async () => new Response('delivered', { status: 200 })),
}));

vi.mock('../../lib/emailOtpRateLimit', () => ({ reserveEmailOtpSend }));
vi.mock('../../db/client', () => ({ getSql }));

const { handleBetterAuthRequest } = await import('../auth');
const env = {
  APP_ENV: 'production',
  WEB_ORIGINS: 'https://garden.example',
  BETTER_AUTH_SECRET: 'test-only-better-auth-secret',
} as Env;
const auth = { handler: authHandler } as unknown as Auth;

describe('email OTP send request boundary', () => {
  beforeEach(() => {
    reserveEmailOtpSend.mockReset();
    reserveEmailOtpSend.mockResolvedValue({ limited: false, scope: null });
    getSql.mockClear();
    authHandler.mockReset();
    authHandler.mockResolvedValue(new Response('delivered', { status: 200 }));
  });

  it('normalizes email before reserving durable limits and ignores spoofed forwarded headers', async () => {
    const request = new Request('https://server.example/api/auth/email-otp/send-verification-otp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://garden.example',
        'x-forwarded-for': '198.51.100.1, 203.0.113.2',
      },
      body: JSON.stringify({ email: ' Garden@Example.Invalid ', type: 'sign-in' }),
    });
    const response = await handleBetterAuthRequest(request, env, auth);
    expect(response.status).toBe(200);
    expect(reserveEmailOtpSend).toHaveBeenCalledWith(expect.anything(), env.BETTER_AUTH_SECRET, 'garden@example.invalid');
    expect(authHandler).toHaveBeenCalledOnce();
  });

  it.each([
    ['/api/auth/email-otp/request-password-reset', 'email'],
    ['/api/auth/forget-password/email-otp', 'email'],
    ['/api/auth/email-otp/request-email-change', 'newEmail'],
  ])('throttles every additional email-delivery route: %s', async (path, field) => {
    const response = await handleBetterAuthRequest(new Request(`https://server.example${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://garden.example' },
      body: JSON.stringify({ [field]: 'other@example.invalid' }),
    }), env, auth);
    expect(response.status).toBe(200);
    expect(reserveEmailOtpSend).toHaveBeenCalledWith(expect.anything(), env.BETTER_AUTH_SECRET, 'other@example.invalid');
  });

  it('rejects oversized padded JSON before a caller can bypass per-email accounting', async () => {
    const response = await handleBetterAuthRequest(new Request(
      'https://server.example/api/auth/email-otp/send-verification-otp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://garden.example' },
        body: JSON.stringify({ email: 'person@example.invalid', padding: 'x'.repeat(5000) }),
      },
    ), env, auth);
    expect(response.status).toBe(413);
    expect(reserveEmailOtpSend).not.toHaveBeenCalled();
    expect(authHandler).not.toHaveBeenCalled();
  });

  it('uses the global budget for malformed requests and fails closed on throttling', async () => {
    reserveEmailOtpSend.mockResolvedValue({ limited: true, scope: 'global' });
    const request = new Request('https://server.example/api/auth/email-otp/send-verification-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://garden.example' },
      body: '{',
    });
    const response = await handleBetterAuthRequest(request, env, auth);
    expect(response.status).toBe(429);
    expect(reserveEmailOtpSend).toHaveBeenCalledWith(expect.anything(), env.BETTER_AUTH_SECRET, undefined);
    expect(authHandler).not.toHaveBeenCalled();
  });

  it('fails closed when the database-backed throttle is unavailable', async () => {
    reserveEmailOtpSend.mockRejectedValue(new Error('database detail'));
    const request = new Request('https://server.example/api/auth/email-otp/send-verification-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://garden.example' },
      body: JSON.stringify({ email: 'person@example.invalid' }),
    });
    const response = await handleBetterAuthRequest(request, env, auth);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('database detail');
    expect(authHandler).not.toHaveBeenCalled();
  });

  it('rejects missing and untrusted browser origins before quota reservation', async () => {
    for (const origin of [undefined, 'https://attacker.invalid']) {
      const headers = new Headers({ 'content-type': 'application/json' });
      if (origin) headers.set('origin', origin);
      const response = await handleBetterAuthRequest(new Request(
        'https://server.example/api/auth/email-otp/send-verification-otp',
        { method: 'POST', headers, body: JSON.stringify({ email: 'person@example.invalid' }) },
      ), env, auth);
      expect(response.status).toBe(403);
    }
    expect(reserveEmailOtpSend).not.toHaveBeenCalled();
    expect(authHandler).not.toHaveBeenCalled();
  });

  it('rejects simple cross-origin text requests before quota reservation', async () => {
    const response = await handleBetterAuthRequest(new Request(
      'https://server.example/api/auth/email-otp/send-verification-otp',
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin: 'https://garden.example' },
        body: JSON.stringify({ email: 'person@example.invalid' }),
      },
    ), env, auth);
    expect(response.status).toBe(415);
    expect(reserveEmailOtpSend).not.toHaveBeenCalled();
    expect(authHandler).not.toHaveBeenCalled();
  });
});
