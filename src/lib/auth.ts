import { betterAuth } from 'better-auth';
import { emailOTP, mcp } from 'better-auth/plugins';
import { APIError } from 'better-auth/api';
import { getKysely } from '../db/client';
import type { Env } from '../env';
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from './assistant/mcpScopes';
import { getMailer } from './mail';
import { appOrigins } from './web/origins';

/// Public-facing host that OAuth issuers/metadata + redirect URIs use.
/// This must match the hostname clients (Claude.ai) actually hit.
export function publicBaseURL(env: Env): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL;
  if (env.APP_ENV === 'staging') throw new Error('PUBLIC_BASE_URL is required in staging');
  return env.APP_ENV === 'production' ? 'https://seedkeep-server.fly.dev' : `http://localhost:${env.PORT}`;
}

export function validateWebConfig(env: Env): void {
  if (env.APP_ENV === 'staging' && (!env.PUBLIC_BASE_URL || !env.APP_ORIGINS?.trim())) {
    throw new Error('Staging requires PUBLIC_BASE_URL and APP_ORIGINS');
  }
  if (env.APP_ENV !== 'development' && env.APP_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean).some((origin) => {
    try { return new URL(origin).protocol !== 'https:'; } catch { return true; }
  })) {
    throw new Error('APP_ORIGINS must contain only valid https origins outside development');
  }
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

const mailSendFailures = new WeakMap<Request, boolean>();

export function recordMailSendFailure(request: Request, verificationRemoved: boolean): void {
  mailSendFailures.set(request, verificationRemoved);
}

export async function removeFailedOTPVerification(
  request: Request,
  removeVerification: () => Promise<void>,
): Promise<void> {
  recordMailSendFailure(request, false);
  try {
    await removeVerification();
    recordMailSendFailure(request, true);
  } catch {
    // The route wrapper retries invalidation on its reserved DB connection.
  }
}

export function consumeMailSendFailure(request: Request): boolean | null {
  const verificationRemoved = mailSendFailures.get(request);
  mailSendFailures.delete(request);
  return verificationRemoved ?? null;
}

export async function finalizeMailSendFailure(
  request: Request,
  email: string,
  retryVerificationRemoval: (identifier: string) => Promise<unknown>,
): Promise<boolean> {
  const verificationRemoved = consumeMailSendFailure(request);
  if (verificationRemoved === null) return false;
  if (!verificationRemoved) await retryVerificationRemoval(`sign-in-otp-${email}`);
  return true;
}

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
    disabledPaths: [
      '/email-otp/create-verification-otp',
      '/email-otp/get-verification-otp',
      '/email-otp/check-verification-otp',
      '/email-otp/verify-email',
      '/email-otp/request-password-reset',
      '/email-otp/forget-password',
      '/email-otp/reset-password',
      '/email-otp/request-email-change',
      '/email-otp/change-email',
      '/forget-password/email-otp',
    ],
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
      'https://api.seedkeep.app',
      'https://claude.ai',
      'https://*.claude.ai',
      base,
      ...appOrigins(env),
      ...(env.APP_ENV === 'development' ? ['http://localhost:*'] : []),
    ],
    rateLimit: {
      enabled: true,
      customRules: {
        '/email-otp/send-verification-otp': { window: 60, max: 3 },
        '/sign-in/email-otp': { window: 60, max: 10 },
      },
    },
    advanced: {
      crossSubDomainCookies: { enabled: false },
      useSecureCookies: env.APP_ENV !== 'development',
      ipAddress: { ipAddressHeaders: ['fly-client-ip'] },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        async sendVerificationOTP({ email, otp, type }, ctx) {
          if (type !== 'sign-in') throw APIError.from('BAD_REQUEST', { code: 'invalid_otp_type', message: 'Only sign-in codes are supported' });
          const mailer = getMailer(env);
          if (!mailer) throw APIError.fromStatus('SERVICE_UNAVAILABLE', { code: 'mail_not_configured', message: 'Email sign-in is not configured' });
          try {
            await mailer.send({
              to: email,
              subject: 'Your Seedkeep sign-in code',
              text: `Your Seedkeep sign-in code is ${otp}. It expires in 5 minutes. If you didn't ask for it, ignore this email.`,
              html: `<p>Your Seedkeep sign-in code is <strong>${otp}</strong>.</p><p>It expires in 5 minutes. If you didn't ask for it, ignore this email.</p>`,
            });
          } catch {
            if (ctx?.request) {
              await removeFailedOTPVerification(ctx.request, () =>
                ctx.context.internalAdapter.deleteVerificationByIdentifier(`sign-in-otp-${email}`));
            }
            throw APIError.from('BAD_GATEWAY', { code: 'mail_send_failed', message: 'Could not send sign-in code' });
          }
        },
      }),
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

export async function getSessionCookie(env: Env): Promise<{
  name: string;
  attributes: { httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' | 'strict' | 'lax' | 'none'; path: string; domain?: string };
}> {
  const auth = getAuth(env) as unknown as {
    $context: Promise<{
      authCookies: {
        sessionToken: {
          name: string;
          attributes: { httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' | 'strict' | 'lax' | 'none'; path: string; domain?: string };
        };
      };
    }>;
  };
  return (await auth.$context).authCookies.sessionToken;
}

export type Auth = AuthInstance;
