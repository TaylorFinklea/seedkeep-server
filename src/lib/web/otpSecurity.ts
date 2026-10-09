/** better-auth 1.6.9 lowercases OTP emails without trimming them. */
export function normalizeOTPEmail(email: string): string {
  return email.toLowerCase();
}

export function isJSONMediaType(contentType: string | null): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

export function makeOTPRequest(request: Request, body: Record<string, unknown>, trustedIPHeader: string | null = 'fly-client-ip'): Request {
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

  consumeMany(limits: Array<{ key: string; max: number; windowMs: number }>, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    let retryAfterSeconds = 0;
    for (const { key, max, windowMs } of limits) {
      const entry = this.windows.get(key);
      if (entry && now - entry.start < windowMs && entry.count >= max) {
        retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)));
      }
    }
    if (retryAfterSeconds) return { allowed: false, retryAfterSeconds };
    for (const { key, max, windowMs } of limits) this.consume(key, max, windowMs, now);
    return { allowed: true };
  }

  consume(key: string, max: number, windowMs: number, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    let entry = this.windows.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      this.windows.set(key, entry);
    }
    if (entry.count >= max) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)) };
    }
    entry.count += 1;
    return { allowed: true };
  }

  /** Remove expired keys so transient traffic cannot grow the map forever. */
  prune(now = Date.now()): void {
    for (const [key, entry] of this.windows) {
      if (now - entry.start >= 10 * 60_000) this.windows.delete(key);
    }
  }
}

export interface OTPAdvisoryConnection {
  tryLock(): Promise<boolean>;
  unlock(): Promise<void>;
  release(): void;
}

export interface OTPAdvisoryOptions {
  maxWaitMs?: number;
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
  handler: (connection: C) => Promise<T>,
  options: OTPAdvisoryOptions = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const maxWaitMs = options.maxWaitMs ?? 2_000;
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
              if (locked) await candidate.unlock().catch(() => undefined);
              candidate.release();
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
      candidate.release();
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
    return { acquired: true, value: await handler(connection) };
  } finally {
    try { await connection.unlock(); } finally { connection.release(); }
  }
}
