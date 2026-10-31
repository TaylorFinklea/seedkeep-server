import type { Env } from '../env';

const DEVELOPMENT_WEB_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function getWebOrigins(env: Pick<Env, 'APP_ENV' | 'WEB_ORIGINS'>): string[] {
  const configured = (env.WEB_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const candidates = configured.length
    ? configured
    : env.APP_ENV === 'development'
      ? DEVELOPMENT_WEB_ORIGINS
      : [];
  const origins = new Set<string>();
  for (const candidate of candidates) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error('WEB_ORIGINS must contain comma-separated HTTP(S) origins.');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== candidate ||
      (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
    ) {
      throw new Error('WEB_ORIGINS must contain exact HTTPS origins (HTTP is allowed only for loopback).');
    }
    origins.add(candidate);
  }
  return [...origins];
}

export function isWebOriginAllowed(
  env: Pick<Env, 'APP_ENV' | 'WEB_ORIGINS'>,
  origin: string | undefined,
): boolean {
  return Boolean(origin && getWebOrigins(env).includes(origin));
}
