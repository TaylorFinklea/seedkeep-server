import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../env';
import { consumeMailSendFailure, finalizeMailSendFailure, publicBaseURL, removeFailedOTPVerification, validateWebConfig } from '../auth';
import { clearSentMail, getMailer, sentMail } from '../mail';
import { appOrigins, isAllowedAppOrigin } from '../web/origins';

const env = (overrides: Partial<Env> = {}): Env => ({
  PORT: 8787, APP_ENV: 'development', DATABASE_URL: 'postgres://seedkeep:test@localhost/seedkeep',
  S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'test-key', S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_BUCKET: 'test-bucket', S3_FORCE_PATH_STYLE: false, BETTER_AUTH_SECRET: 'test-secret-at-least-16',
  APPLE_CLIENT_ID: 'client', APPLE_CLIENT_SECRET: 'secret', DEFAULT_VISION_MODEL: 'vision',
  DEFAULT_REVIEW_MODEL: 'review', GARDEN_TOOLS_ENABLED: false, ANTHROPIC_API_KEY: undefined,
  APPLE_IAP_SHARED_SECRET: undefined, ASSISTANT_KEY_MASTER: undefined, ADMIN_SECRET: undefined, ...overrides,
});

afterEach(() => { clearSentMail(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('web origin policy', () => {
  it('parses, trims, de-slashes, and deduplicates configured origins', () => {
    expect(appOrigins(env({ APP_ORIGINS: ' https://app.example.test/, ,https://two.test,https://app.example.test ' })))
      .toEqual(['https://app.example.test', 'https://two.test']);
  });

  it.each([
    ['https://app.example.test', true], ['https://app.example.test/', false],
    ['http://localhost:5173', true], ['http://127.0.0.1:4173', true],
    ['http://localhost', false], ['http://localhost:0', false], ['http://localhost:65536', false], ['null', false], ['', false], [null, false],
    ['https://evil.test', false],
  ] as const)('development origin %s is %s', (origin, expected) => {
    expect(isAllowedAppOrigin(env({ APP_ORIGINS: 'https://app.example.test' }), origin)).toBe(expected);
  });

  it('allows loopback only in development', () => {
    expect(isAllowedAppOrigin(env({ APP_ENV: 'production' }), 'http://localhost:5173')).toBe(false);
    expect(isAllowedAppOrigin(env({ APP_ENV: 'staging', APP_ORIGINS: 'https://app.example.test' }), 'https://app.example.test')).toBe(true);
  });
});

describe('mailer selection', () => {
  it('defaults to the development log mailer and refuses log in staging or production', () => {
    expect(getMailer(env())).not.toBeNull();
    expect(getMailer(env({ APP_ENV: 'staging', MAIL_PROVIDER: 'log' }))).toBeNull();
    expect(getMailer(env({ APP_ENV: 'production', MAIL_PROVIDER: 'log' }))).toBeNull();
  });

  it('returns null for Resend without a nonblank API key', () => {
    expect(getMailer(env({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: '  ' }))).toBeNull();
  });

  it('sends Resend mail with the configured sender and rejects provider errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const mailer = getMailer(env({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: '  test-key  ', MAIL_FROM: 'Sender <sender@example.test>' }));
    await mailer!.send({ to: 'person@example.test', subject: 'Sign in', text: 'Code' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Sender <sender@example.test>', to: ['person@example.test'], subject: 'Sign in', text: 'Code' }),
    }));
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(mailer!.send({ to: 'person@example.test', subject: 'Sign in', text: 'Code' })).rejects.toThrow(/Resend rejected email/);
  });

  it('captures memory provider messages for the test helpers', async () => {
    const mailer = getMailer(env({ MAIL_PROVIDER: 'memory' }));
    expect(mailer).not.toBeNull();
    await mailer!.send({ to: 'person@example.test', subject: 'Sign in', text: 'Code' });
    expect(sentMail()).toEqual([{ to: 'person@example.test', subject: 'Sign in', text: 'Code' }]);
    clearSentMail();
    expect(sentMail()).toEqual([]);
  });
});

describe('public web configuration', () => {
  it('uses the configured base URL and environment defaults', () => {
    expect(publicBaseURL(env({ PUBLIC_BASE_URL: 'https://api.example.test' }))).toBe('https://api.example.test');
    expect(publicBaseURL(env())).toBe('http://localhost:8787');
    expect(publicBaseURL(env({ APP_ENV: 'production' }))).toBe('https://seedkeep-server.fly.dev');
  });

  it('requires staging URLs and origins, and HTTPS origins outside development', () => {
    expect(() => publicBaseURL(env({ APP_ENV: 'staging' }))).toThrow(/PUBLIC_BASE_URL/);
    expect(() => validateWebConfig(env({ APP_ENV: 'staging' }))).toThrow(/PUBLIC_BASE_URL and APP_ORIGINS/);
    expect(() => validateWebConfig(env({ APP_ENV: 'staging', PUBLIC_BASE_URL: 'https://api.test', APP_ORIGINS: 'http://app.test' }))).toThrow(/https origins/);
    expect(() => validateWebConfig(env({ APP_ENV: 'production', APP_ORIGINS: 'https://app.test' }))).not.toThrow();
  });
});

describe('mail failure cleanup handoff', () => {
  it('asks the route wrapper to retry when adapter invalidation rejects', async () => {
    const request = new Request('http://localhost/api/auth/email-otp/send-verification-otp');
    await removeFailedOTPVerification(request, async () => { throw new Error('database unavailable'); });
    expect(consumeMailSendFailure(request)).toBe(false);
    expect(consumeMailSendFailure(request)).toBeNull();
  });

  it('records successful adapter invalidation', async () => {
    const request = new Request('http://localhost/api/auth/email-otp/send-verification-otp');
    await removeFailedOTPVerification(request, async () => {});
    expect(consumeMailSendFailure(request)).toBe(true);
  });

  it('retries adapter invalidation on the route connection and propagates a failed retry', async () => {
    const request = new Request('http://localhost/api/auth/email-otp/send-verification-otp');
    await removeFailedOTPVerification(request, async () => { throw new Error('database unavailable'); });
    const retry = vi.fn().mockRejectedValue(new Error('database unavailable'));
    await expect(finalizeMailSendFailure(request, 'person@example.test', retry)).rejects.toThrow('database unavailable');
    expect(retry).toHaveBeenCalledWith('sign-in-otp-person@example.test');
  });
});
