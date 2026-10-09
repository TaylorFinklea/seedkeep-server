// Web-app origin policy shared by CORS, better-auth trustedOrigins and the
// CSRF Origin gate. CONTRACT STUB (web M1 Phase 2) — owner: Luna.
import type { Env } from '../../env';

/** Exact allowed web-app origins parsed from comma-separated APP_ORIGINS (trimmed, empty entries dropped, no trailing slashes). */
export function appOrigins(env: Env): string[] {
  return [...new Set((env.APP_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean))];
}

/**
 * True when `origin` may make credentialed browser requests:
 * an exact APP_ORIGINS match, or (development only) http://localhost:<port>.
 * Null, empty, or "null" origins are never allowed.
 */
export function isAllowedAppOrigin(env: Env, origin: string | null | undefined): boolean {
  if (!origin || origin === 'null') return false;
  if (appOrigins(env).includes(origin)) return true;
  if (env.APP_ENV !== 'development') return false;
  const match = /^http:\/\/(?:localhost|127\.0\.0\.1):(\d+)$/.exec(origin);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}
