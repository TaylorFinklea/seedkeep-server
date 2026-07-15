import { betterAuth } from 'better-auth';
import { mcp } from 'better-auth/plugins';
import { getKysely } from '../db/client';
import type { Env } from '../env';
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from './assistant/mcpScopes';

/// Public-facing host that OAuth issuers/metadata + redirect URIs use.
/// This must match the hostname clients (Claude.ai) actually hit.
function publicBaseURL(env: Env): string {
  return env.APP_ENV === 'production'
    ? 'https://seedkeep-server.fly.dev'
    : `http://localhost:${env.PORT}`;
}

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

const OIDC_SCOPES = [
  'openid', 'profile', 'email', 'offline_access', MCP_READ_SCOPE, MCP_WRITE_SCOPE,
];

function buildAuth(env: Env) {
  const base = publicBaseURL(env);
  return betterAuth({
    database: {
      db: getKysely(env),
      type: 'postgres',
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: base,
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
      'https://seedkeep-server.fly.dev',
      'https://claude.ai',
      'https://*.claude.ai',
    ],
    advanced: {
      crossSubDomainCookies: { enabled: false },
    },
    plugins: [
      // MCP plugin wraps the OIDC provider with MCP-specific metadata
      // endpoints (.well-known/oauth-protected-resource) + adds a
      // WWW-Authenticate header to 401s on the protected /mcp resource.
      // It requires `oidcConfig` since it composes the oidc-provider
      // plugin inline.
      mcp(({
        loginPage: '/oauth/pair',
        resource: `${base}/mcp`,
        metadata: { scopes_supported: OIDC_SCOPES },
        oidcConfig: {
          loginPage: '/oauth/pair',
          consentPage: '/oauth/consent',
          allowDynamicClientRegistration: true,
          requirePKCE: true,
          allowPlainCodeChallengeMethod: false,
          accessTokenExpiresIn: 60 * 60 * 24,        // 24 h
          refreshTokenExpiresIn: 60 * 60 * 24 * 30,  // 30 d
          codeExpiresIn: 600,                         // 10 min
          scopes: OIDC_SCOPES,
          defaultScope: `openid ${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`,
          metadata: { scopes_supported: OIDC_SCOPES },
        },
      } as Parameters<typeof mcp>[0] & { metadata: { scopes_supported: string[] } })),
    ],
  });
}

export function getAuth(env: Env): AuthInstance {
  if (!_auth) _auth = buildAuth(env);
  return _auth;
}

export type Auth = AuthInstance;
