// Web-app origin policy shared by CORS, better-auth trustedOrigins and the
// CSRF Origin gate. CONTRACT STUB (web M1 Phase 2) — owner: Luna.
import type { Env } from '../../env';

/** Exact allowed web-app origins parsed from comma-separated APP_ORIGINS (trimmed, empty entries dropped, no trailing slashes). */
export function appOrigins(env: Env): string[] {
  void env;
  return [];
}

/**
 * True when `origin` may make credentialed browser requests:
 * an exact APP_ORIGINS match, or (development only) http://localhost:<port>.
 * Null, empty, or "null" origins are never allowed.
 */
export function isAllowedAppOrigin(env: Env, origin: string | null | undefined): boolean {
  void env;
  void origin;
  return false;
}
