import { describe, expect, it, vi } from 'vitest';
import {
  getBunSocketIP,
  isJSONMediaType,
  makeOTPRequest,
  normalizeOTPEmail,
  OTPFixedWindowLimiter,
  withOTPAdvisoryLock,
  type OTPAdvisoryConnection,
} from '../web/otpSecurity';

describe('OTP request boundary', () => {
  it('accepts only application/json as the base media type', () => {
    expect(isJSONMediaType('application/json')).toBe(true);
    expect(isJSONMediaType(' Application/JSON ; charset=utf-8')).toBe(true);
    expect(isJSONMediaType('application/x-www-form-urlencoded,application/json')).toBe(false);
    expect(isJSONMediaType('text/json')).toBe(false);
    expect(isJSONMediaType(null)).toBe(false);
  });

  it('uses the same lower-case-only normalization as better-auth 1.6.9', () => {
    // better-auth/dist/plugins/email-otp/routes.mjs lowercases ctx.body.email directly.
    expect(normalizeOTPEmail('  Person+OTP@Example.Test  ')).toBe('  person+otp@example.test  ');
  });

  it('rebuilds the processed request from the parsed body and relevant headers', async () => {
    const request = new Request('https://api.example.test/api/auth/sign-in/email-otp', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://app.example.test',
        cookie: 'session=abc',
        'fly-client-ip': '192.0.2.1',
        'user-agent': 'test-agent',
        'x-unrelated': 'drop-me',
      },
      body: 'email=person%40example.test',
    });
    const processed = makeOTPRequest(request, { email: 'person@example.test', otp: '123456' });
    expect(processed.headers.get('content-type')).toBe('application/json');
    expect(processed.headers.get('origin')).toBe('https://app.example.test');
    expect(processed.headers.get('cookie')).toBe('session=abc');
    expect(processed.headers.get('fly-client-ip')).toBe('192.0.2.1');
    expect(processed.headers.get('user-agent')).toBe('test-agent');
    expect(processed.headers.has('x-unrelated')).toBe(false);
    expect(await processed.json()).toEqual({ email: 'person@example.test', otp: '123456' });

    const withoutTrustedIP = makeOTPRequest(request, { email: 'person@example.test' }, null);
    expect(withoutTrustedIP.headers.has('fly-client-ip')).toBe(false);
  });

  it('reads a Bun peer IP only when a server requestIP method is available', () => {
    const request = new Request('http://localhost/api/auth/sign-in/email-otp');
    const server = { requestIP: (actual: Request) => actual === request ? { address: '192.0.2.8' } : null };
    expect(getBunSocketIP(server, request)).toBe('192.0.2.8');
    expect(getBunSocketIP({ server }, request)).toBe('192.0.2.8');
    expect(getBunSocketIP({}, request)).toBeUndefined();
    expect(getBunSocketIP({ requestIP: () => null }, request)).toBeUndefined();
  });
});

describe('OTP fixed-window rate limiter', () => {
  it('keys email and IP limits separately and resets each fixed window', () => {
    const limiter = new OTPFixedWindowLimiter();
    const first = limiter.consumeMany([
      { key: 'send:email:a@example.test', max: 3, windowMs: 600_000 },
      { key: 'send:ip:192.0.2.1', max: 3, windowMs: 60_000 },
    ], 1_000);
    expect(first.allowed).toBe(true);
    expect(limiter.consume('send:email:a@example.test', 3, 600_000, 1_001).allowed).toBe(true);
    expect(limiter.consume('send:email:a@example.test', 3, 600_000, 1_002).allowed).toBe(true);
    expect(limiter.consume('send:email:a@example.test', 3, 600_000, 1_003)).toEqual({ allowed: false, retryAfterSeconds: 600 });
    expect(limiter.consume('send:ip:192.0.2.2', 3, 60_000, 1_003).allowed).toBe(true);
    expect(limiter.consume('send:email:a@example.test', 3, 600_000, 601_000).allowed).toBe(true);
  });

  it('does not consume an unblocked key when another dimension is limited', () => {
    const limiter = new OTPFixedWindowLimiter();
    for (let i = 0; i < 3; i++) limiter.consumeMany([
      { key: 'send:email:a@example.test', max: 3, windowMs: 600_000 },
      { key: 'send:ip:192.0.2.1', max: 3, windowMs: 60_000 },
    ], 2_000 + i);
    expect(limiter.consumeMany([
      { key: 'send:email:b@example.test', max: 3, windowMs: 600_000 },
      { key: 'send:ip:192.0.2.1', max: 3, windowMs: 60_000 },
    ], 2_004).allowed).toBe(false);
    expect(limiter.consume('send:email:b@example.test', 3, 600_000, 2_005).allowed).toBe(true);
  });
});

describe('OTP advisory lock acquisition', () => {
  it('releases failed try-lock connections and retains the acquired connection through the handler', async () => {
    const events: string[] = [];
    const lock = (result: boolean): OTPAdvisoryConnection => ({
      tryLock: async () => { events.push(`try:${result}`); return result; },
      unlock: async () => { events.push('unlock'); },
      release: () => { events.push('release'); },
    });
    const connections = [lock(false), lock(true)];
    const outcome = await withOTPAdvisoryLock(
      async () => connections.shift()!,
      async () => { events.push('handler'); return 'ok'; },
      { maxWaitMs: 100, now: () => 0, sleep: async () => {}, jitter: () => 0 },
    );
    expect(outcome).toEqual({ acquired: true, value: 'ok' });
    expect(events).toEqual(['try:false', 'release', 'try:true', 'handler', 'unlock', 'release']);
  });

  it('returns busy after the bounded wait and releases every unsuccessful connection', async () => {
    let now = 0;
    let releases = 0;
    const reserve = vi.fn(async (): Promise<OTPAdvisoryConnection> => ({
      tryLock: async () => false,
      unlock: async () => {},
      release: () => { releases += 1; },
    }));
    const outcome = await withOTPAdvisoryLock(reserve, async () => 'unreachable', {
      maxWaitMs: 40,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      jitter: () => 0,
    });
    expect(outcome).toEqual({ acquired: false });
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(releases).toBe(2);
  });

  it('bounds a delayed try-lock and unlocks then releases if the late result acquired the lock', async () => {
    const events: string[] = [];
    let resolveTryLock!: (locked: boolean) => void;
    const tryLockPromise = new Promise<boolean>((resolve) => { resolveTryLock = resolve; });
    const reserve = async (): Promise<OTPAdvisoryConnection> => ({
      tryLock: () => tryLockPromise,
      unlock: async () => { events.push('unlock'); },
      release: () => { events.push('release'); },
    });
    const handler = vi.fn(async () => 'must not run');
    const outcome = await withOTPAdvisoryLock(reserve, handler, { maxWaitMs: 10 });
    expect(outcome).toEqual({ acquired: false });
    expect(handler).not.toHaveBeenCalled();

    resolveTryLock(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['unlock', 'release']);
  });

  it('clears the deadline timer when try-lock rejects immediately', async () => {
    vi.useFakeTimers();
    try {
      const connection: OTPAdvisoryConnection = {
        tryLock: async () => { throw new Error('lock query failed'); },
        unlock: async () => {},
        release: () => {},
      };
      await expect(withOTPAdvisoryLock(async () => connection, async () => 'unused'))
        .rejects.toThrow('lock query failed');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
