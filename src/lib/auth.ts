import { betterAuth } from 'better-auth';
import { getKysely } from '../db/client';
import type { Env } from '../env';

/**
 * better-auth instance for Seedkeep (Postgres-backed).
 *
 * Phase 1 only supports Sign in with Apple; the iOS client posts an
 * Apple-minted id_token to `/api/auth/sign-in/social` and gets back a
 * Bearer token that we look up in the `session` table on every protected
 * request.
 */

// Inferred type from `betterAuth(...)` — the explicit `BetterAuthOptions`
// upper bound from the library doesn't accept our literal config.
type AuthInstance = ReturnType<typeof buildAuth>;

let _auth: AuthInstance | null = null;

function buildAuth(env: Env) {
  return betterAuth({
    database: {
      db: getKysely(env),
      type: 'postgres',
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_ENV === 'production'
      ? 'https://api.seedkeep.app'
      : `http://localhost:${env.PORT}`,
    basePath: '/api/auth',
    socialProviders: {
      apple: {
        clientId: env.APPLE_CLIENT_ID,
        clientSecret: env.APPLE_CLIENT_SECRET,
        appBundleIdentifier: env.APPLE_CLIENT_ID,
        audience: [env.APPLE_CLIENT_ID],
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24,      // refresh every 24h
    },
    trustedOrigins: [
      'seedkeep://*',
      'http://localhost:*',
      'https://api.seedkeep.app',
    ],
    advanced: {
      crossSubDomainCookies: { enabled: false },
    },
  });
}

export function getAuth(env: Env): AuthInstance {
  if (!_auth) _auth = buildAuth(env);
  return _auth;
}

export type Auth = AuthInstance;
