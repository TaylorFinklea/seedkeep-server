/** better-auth 1.6.9 lowercases OTP emails without trimming them. */
export function normalizeOTPEmail(email: string): string {
  return email.toLowerCase();
}

export function isValidOTPEmail(email: string): boolean {
  if (email.length > 254) return false;
  const match = /^([A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*)@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}$/i.exec(email);
  return Boolean(match && match[1].length <= 64);
}

export async function parseLimitedJSONBody(
  request: Request,
  maxBytes = 4_096,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'too_large' | 'invalid' }> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return { ok: false, reason: 'too_large' };
  let bodyText = '';
  let bytesRead = 0;
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: 'too_large' };
        }
        bodyText += decoder.decode(value, { stream: true });
      }
      bodyText += decoder.decode();
      return { ok: true, value: JSON.parse(bodyText) as unknown };
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  }
  try {
    return { ok: true, value: JSON.parse(bodyText) as unknown };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export function otpSendRateLimits(email: string, ip: string) {
  return [
    { key: `otp:send:email:${email}`, max: 5, windowMs: 10 * 60_000 },
    { key: `otp:send:ip:${ip}`, max: 3, windowMs: 60_000 },
  ];
}

export function otpSignInFailureRateLimits(email: string, ip: string) {
  return [
    { key: `otp:signin:email:${email}:ip:${ip}`, max: 10, windowMs: 10 * 60_000 },
    { key: `otp:signin:email:${email}`, max: 30, windowMs: 10 * 60_000 },
  ];
}

export function settleOTPSignInAttempt(
  limiter: OTPFixedWindowLimiter,
  email: string,
  limits: ReturnType<typeof otpSignInFailureRateLimits>,
  status: number,
  now = Date.now(),
): void {
  if (status >= 200 && status < 300) limiter.clearPrefix(`otp:signin:email:${email}`);
  else if (status < 500) limiter.recordMany(limits, now);
}

export function isJSONMediaType(contentType: string | null): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

export function makeOTPRequest(request: Request, body: Record<string, unknown>, trustedIPHeader: string | null = 'fly-client-ip', signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const name of ['origin', 'cookie', 'user-agent', ...(trustedIPHeader ? [trustedIPHeader] : [])]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('content-type', 'application/json');
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

/** Get Bun's peer address when Hono was entered through Bun.serve. */
export function getBunSocketIP(contextEnv: unknown, request: Request): string | undefined {
  if (!contextEnv || typeof contextEnv !== 'object') return undefined;
  const context = contextEnv as {
    requestIP?: (request: Request) => { address: string } | null;
    server?: { requestIP?: (request: Request) => { address: string } | null };
  };
  const server = typeof context.requestIP === 'function' ? context : context.server;
  const requestIP = server?.requestIP;
  if (typeof requestIP !== 'function') return undefined;
  try {
    const address = requestIP.call(server, request)?.address;
    return typeof address === 'string' && address.length > 0 ? address : undefined;
  } catch {
    return undefined;
  }
}

interface WindowEntry {
  start: number;
  count: number;
}

/** In-memory fixed-window limiter. Counts are local to this server machine. */
export class OTPFixedWindowLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly keysByPrefix = new Map<string, Set<string>>();
  private pruneCursor: IterableIterator<[string, WindowEntry]> | undefined;
  private lastFullPruneAt = Number.NEGATIVE_INFINITY;

  private keyPrefix(key: string): string {
    if (!key.startsWith('otp:signin:email:')) return key;
    const pairSeparator = key.indexOf(':ip:', 'otp:signin:email:'.length);
    return pairSeparator < 0 ? key : key.slice(0, pairSeparator);
  }

  private deleteKey(key: string): void {
    this.windows.delete(key);
    const prefix = this.keyPrefix(key);
    const members = this.keysByPrefix.get(prefix);
    members?.delete(key);
    if (members?.size === 0) this.keysByPrefix.delete(prefix);
  }

  private addKey(key: string): void {
    const prefix = this.keyPrefix(key);
    let members = this.keysByPrefix.get(prefix);
    if (!members) this.keysByPrefix.set(prefix, members = new Set());
    members.add(key);
  }

  constructor(private readonly maxKeys = 50_000, private readonly pruneBatchSize = 100) {}

  private inspect(keys: Array<{ key: string; max: number; windowMs: number }>, now: number): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    this.prune(now);
    let retryAfterSeconds = 0;
    for (const { key, max, windowMs } of keys) {
      const entry = this.windows.get(key);
      if (entry && now - entry.start < windowMs && entry.count >= max) {
        retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)));
      }
    }
    if (retryAfterSeconds) return { allowed: false, retryAfterSeconds };
    const newKeys = new Set(keys.filter(({ key }) => !this.windows.has(key)).map(({ key }) => key));
    if (newKeys.size > 0 && !this.makeRoom(newKeys.size, now)) {
      return { allowed: false, retryAfterSeconds: 60 };
    }
    return { allowed: true };
  }

  private makeRoom(required: number, now: number): boolean {
    if (this.windows.size + required <= this.maxKeys) return true;
    // A full scan is only allowed once per minute at capacity. Normal traffic
    // prunes a small rotating batch on every operation.
    if (now - this.lastFullPruneAt >= 60_000) {
      this.lastFullPruneAt = now;
      for (const [key, entry] of this.windows) {
        if (now - entry.start >= 10 * 60_000) this.deleteKey(key);
      }
    }
    return this.windows.size + required <= this.maxKeys;
  }

  private prune(now: number): void {
    if (!this.pruneCursor) this.pruneCursor = this.windows.entries();
    for (let i = 0; i < this.pruneBatchSize; i += 1) {
      const next = this.pruneCursor.next();
      if (next.done) {
        this.pruneCursor = this.windows.entries();
        break;
      }
      const [key, entry] = next.value;
      if (now - entry.start >= 10 * 60_000) this.deleteKey(key);
    }
  }

  consumeMany(limits: Array<{ key: string; max: number; windowMs: number }>, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const result = this.inspect(limits, now);
    if (!result.allowed) return result;
    this.recordMany(limits, now);
    return { allowed: true };
  }

  checkMany(limits: Array<{ key: string; max: number; windowMs: number }>, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    return this.inspect(limits, now);
  }

  recordMany(limits: Array<{ key: string; max: number; windowMs: number }>, now = Date.now()): void {
    for (const { key, max, windowMs } of limits) this.consume(key, max, windowMs, now);
  }

  clearPrefix(prefix: string): void {
    for (const key of this.keysByPrefix.get(prefix) ?? []) this.deleteKey(key);
  }

  consume(key: string, max: number, windowMs: number, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    let entry = this.windows.get(key);
    if (!entry || now - entry.start >= windowMs) {
      if (!entry && !this.makeRoom(1, now)) return { allowed: false, retryAfterSeconds: 60 };
      entry = { start: now, count: 0 };
      this.windows.set(key, entry);
      this.addKey(key);
    }
    if (entry.count >= max) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)) };
    }
    entry.count += 1;
    return { allowed: true };
  }

}

export interface OTPAdvisoryConnection {
  tryLock(): Promise<boolean>;
  unlock(): Promise<void>;
  release(): void;
  discard(): Promise<void> | void;
}

export interface OTPAdvisoryOptions {
  maxWaitMs?: number;
  handlerTimeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  jitter?: () => number;
}

/**
 * Acquire with a fresh lock-pool connection per attempt. Contending requests
 * never reserve a connection from the application pool, and failed attempts
 * return their lock-pool connection before sleeping.
 */
export async function withOTPAdvisoryLock<T, C extends OTPAdvisoryConnection>(
  reserve: () => Promise<C>,
  handler: (connection: C, signal: AbortSignal) => Promise<T>,
  options: OTPAdvisoryOptions = {},
): Promise<{ acquired: true; value: T } | { acquired: false; timedOut?: boolean }> {
  const maxWaitMs = options.maxWaitMs ?? 2_000;
  const handlerTimeoutMs = options.handlerTimeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const jitter = options.jitter ?? Math.random;
  const deadline = now() + maxWaitMs;
  let connection: C | undefined;

  while (now() < deadline) {
    const remaining = Math.max(0, deadline - now());
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const candidate = await Promise.race([
      reserve().then((reserved) => {
        if (timedOut) reserved.release();
        return timedOut ? null : reserved;
      }),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => { timedOut = true; resolve(null); }, remaining);
      }),
    ]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (!candidate) return { acquired: false };
    let tryLockTimedOut: boolean | null;
    try {
      tryLockTimedOut = await Promise.race([
        candidate.tryLock().then(
          async (locked) => {
            if (timedOut) {
              if (locked) {
                try { await candidate.unlock(); candidate.release(); }
                catch { await candidate.discard(); }
              } else candidate.release();
              return null;
            }
            return locked;
          },
          (error) => {
            if (timedOut) {
              candidate.release();
              return null;
            }
            throw error;
          },
        ),
        new Promise<null>((resolve) => {
          timeoutId = setTimeout(() => { timedOut = true; resolve(null); }, Math.max(0, deadline - now()));
        }),
      ]);
    } catch (error) {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      await candidate.discard();
      throw error;
    }
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (tryLockTimedOut === null) return { acquired: false };
    if (tryLockTimedOut) {
      connection = candidate;
      break;
    }
    candidate.release();
    if (now() >= deadline) break;
    await sleep(Math.min(20 + Math.floor(jitter() * 40), deadline - now()));
  }

  if (!connection) return { acquired: false };
  try {
    const abortController = new AbortController();
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const value = await Promise.race([
      handler(connection, abortController.signal),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          abortController.abort(new Error('OTP handler timed out'));
          reject(new Error('OTP handler timed out'));
        }, handlerTimeoutMs);
      }),
    ]).catch((error) => {
      if (timedOut) return { acquired: false as const, timedOut: true as const };
      throw error;
    }).finally(() => { if (timeoutId !== undefined) clearTimeout(timeoutId); });
    if (typeof value === 'object' && value !== null && 'timedOut' in value) return value;
    return { acquired: true, value };
  } finally {
    try {
      await connection.unlock();
    } catch (error) {
      try { await connection.discard(); } catch { /* the pool close is best-effort */ }
      throw error;
    }
    connection.release();
  }
}
