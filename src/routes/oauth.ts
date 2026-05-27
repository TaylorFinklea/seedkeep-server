// Phase 4 E (continued) — OAuth 2.1 surface for MCP / claude.ai.
//
// Pieces in this file:
//
// 1. **Well-known proxies** — claude.ai expects the OAuth metadata at
//    the root of the resource server (per RFC 8414 / RFC 9728). Our
//    better-auth handler answers under `/api/auth/...`, so we proxy
//    the canonical paths to the better-auth handler.
//
// 2. **Pairing-code flow** — bridges an iOS session to a browser
//    session. iOS posts to `/api/web_pairing_codes` and gets back a
//    short alphanumeric code. The user opens claude.ai's connect-MCP
//    flow, which redirects them through our `/oauth/pair` HTML page.
//    They type the code, we mint a real better-auth web session, then
//    redirect them back into the OAuth authorize flow.
//
// 3. **Consent HTML** — the page better-auth renders when it asks the
//    user to authorize a client. We supply our own HTML so it reads
//    in the herbarium voice.

import { Hono } from 'hono';
import { z } from 'zod';
import { serializeSignedCookie } from 'better-call';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbGet, dbRun } from '../db/helpers';
import { getSql } from '../db/client';
import { getAuth } from '../lib/auth';

export const oauthRoutes = new Hono<AppEnv>();

// ── Well-known metadata proxies ──────────────────────────────────────
// These rewrite to /api/auth/<same> and call better-auth's handler.

function proxyToBetterAuth(targetPath: string) {
  return async (c: { env: AppEnv['Bindings']; req: { raw: Request } }) => {
    const auth = getAuth(c.env);
    const url = new URL(c.req.raw.url);
    url.pathname = targetPath;
    const proxied = new Request(url.toString(), c.req.raw);
    return auth.handler(proxied);
  };
}

oauthRoutes.get('/.well-known/oauth-authorization-server',
  proxyToBetterAuth('/api/auth/.well-known/oauth-authorization-server'));
oauthRoutes.get('/.well-known/oauth-protected-resource',
  proxyToBetterAuth('/api/auth/.well-known/oauth-protected-resource'));
oauthRoutes.get('/.well-known/openid-configuration',
  proxyToBetterAuth('/api/auth/.well-known/openid-configuration'));

// ── OAuth endpoint proxies ───────────────────────────────────────────
// Claude.ai's MCP client expects authorize / token / register at the
// canonical paths the metadata document points to. We make those work
// at root and at the better-auth basePath.

oauthRoutes.all('/oauth2/authorize', proxyToBetterAuth('/api/auth/oauth2/authorize'));
oauthRoutes.all('/oauth2/token',     proxyToBetterAuth('/api/auth/oauth2/token'));
oauthRoutes.all('/oauth2/register',  proxyToBetterAuth('/api/auth/oauth2/register'));
oauthRoutes.all('/oauth2/userinfo',  proxyToBetterAuth('/api/auth/oauth2/userinfo'));

/// POST /oauth2/consent — bridge from the HTML consent form to
/// better-auth's JSON-only consent endpoint. Reads accept +
/// consent_code from urlencoded form data, re-POSTs as JSON, and
/// follows the returned redirectURI back to the OAuth client.
oauthRoutes.post('/oauth2/consent', async (c) => {
  const auth = getAuth(c.env);
  const formData = await c.req.formData();
  const accept = String(formData.get('accept') ?? 'false') === 'true';
  const consentCode = formData.get('consent_code')
    ? String(formData.get('consent_code'))
    : undefined;

  const url = new URL(c.req.raw.url);
  url.pathname = '/api/auth/oauth2/consent';
  const proxied = new Request(url.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: c.req.header('cookie') ?? '',
    },
    body: JSON.stringify({ accept, consent_code: consentCode }),
  });
  const response = await auth.handler(proxied);

  if (!response.ok) {
    const errBody = await response.text();
    return c.html(consentErrorHTML(errBody), { status: response.status as 400 | 401 | 403 | 500 });
  }
  const body = await response.json() as { redirectURI?: string };
  if (!body.redirectURI) {
    return c.html(consentErrorHTML('Consent succeeded but the auth server did not return a redirect URL.'), 500);
  }
  return c.redirect(body.redirectURI, 302);
});

// ── Pairing-code: iOS → web bridge ───────────────────────────────────

const PairingCodeAuth = [requireAuth(), requireHousehold()] as const;

/// Generates a friendly short code: 8 chars from a Crockford-style
/// alphabet (no 0/O/1/I to avoid type-it-wrong-in-a-browser frustration).
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generatePairingCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join('');
}

/**
 * POST /api/web_pairing_codes
 *
 * iOS-only. Returns a short code the user types into the browser to
 * authorize MCP. Code expires in 10 min; single-use.
 */
oauthRoutes.post('/web_pairing_codes', ...PairingCodeAuth, async (c) => {
  const sql = getSql(c.env);
  const userId = c.get('userId') as string;
  const householdId = c.get('householdId') as string;
  const code = generatePairingCode();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  await dbRun(
    sql,
    `INSERT INTO web_pairing_codes (code, user_id, household_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [code, userId, householdId, expiresAt],
  );
  return c.json({ ok: true, data: { code, expires_at: expiresAt } });
});

// ── /oauth/pair HTML page ────────────────────────────────────────────
//
// When better-auth's OIDC provider needs the user to authenticate, it
// redirects here (we set this URL as loginPage). The user types the
// pairing code from their iOS app; we exchange it for a real session
// cookie and bounce them back into the OAuth flow.
//
// better-auth appends the original authorize query string when it
// redirects, so we capture EVERYTHING on the GET (every search param)
// and re-attach it to the authorize endpoint after a successful pair.
// When the user lands on /oauth/pair standalone (no upstream flow),
// the post-pair redirect goes to a friendly "you're paired" page.

const AUTHORIZE_ENDPOINT = '/api/auth/mcp/authorize';

oauthRoutes.get('/oauth/pair', async (c) => {
  const url = new URL(c.req.raw.url);
  const params = new URLSearchParams(url.search);
  const error = params.get('error') ?? '';
  params.delete('error');
  // Detect whether an OAuth flow is actually in-progress. The
  // presence of client_id is the canonical signal — better-auth
  // always passes it when redirecting to loginPage.
  const inOAuthFlow = params.has('client_id');
  return c.html(loginPageHTML({
    inOAuthFlow,
    originalParams: params.toString(),
    error,
  }));
});

const PairBody = z.object({
  code: z.string().min(6).max(16),
  oauthParams: z.string().optional(),
});

oauthRoutes.post('/oauth/pair', async (c) => {
  const sql = getSql(c.env);
  const formData = await c.req.formData();
  const parsed = PairBody.safeParse({
    code: String(formData.get('code') ?? '').toUpperCase(),
    oauthParams: formData.get('oauthParams') ? String(formData.get('oauthParams')) : undefined,
  });
  const oauthParams = parsed.success ? (parsed.data.oauthParams ?? '') : '';
  const inOAuthFlow = oauthParams.length > 0 && new URLSearchParams(oauthParams).has('client_id');

  if (!parsed.success) {
    return c.html(loginPageHTML({
      inOAuthFlow,
      originalParams: oauthParams,
      error: 'Enter the 8-character code from your Seedkeep app.',
    }), 400);
  }
  const now = Date.now();
  const row = await dbGet<{ code: string; user_id: string; household_id: string; expires_at: number; used_at: number | null }>(
    sql,
    `SELECT code, user_id, household_id, expires_at, used_at
       FROM web_pairing_codes WHERE code = $1 LIMIT 1`,
    [parsed.data.code],
  );
  if (!row || row.used_at !== null || row.expires_at < now) {
    return c.html(loginPageHTML({
      inOAuthFlow,
      originalParams: oauthParams,
      error: row?.used_at ? 'That code has already been used. Generate a fresh one in the app.'
        : 'That code is expired or unrecognized. Generate a fresh one.',
    }), 400);
  }
  await dbRun(sql, `UPDATE web_pairing_codes SET used_at = $1 WHERE code = $2`, [now, parsed.data.code]);

  // Mint a real better-auth session via the internal adapter.
  const auth = getAuth(c.env);
  const internal = (auth as unknown as {
    $context: Promise<{ internalAdapter: { createSession: (userId: string, ctx?: unknown) => Promise<{ token: string; id: string; expiresAt: Date | string | number } | null> } }>;
  }).$context;
  const session = await (await internal).internalAdapter.createSession(row.user_id);
  if (!session) {
    return c.html(loginPageHTML({
      inOAuthFlow,
      originalParams: oauthParams,
      error: 'Could not establish a web session. Please try again.',
    }), 500);
  }
  // Better-auth expects the session cookie to be SIGNED (HMAC-SHA256
  // against the BETTER_AUTH_SECRET). It also prepends `__Secure-` to
  // the cookie name when the baseURL is HTTPS. Use better-call's
  // `serializeSignedCookie` to match better-auth's format exactly —
  // a plain hono setCookie produces an unsigned value that better-
  // auth rejects, kicking the user back into the loginPage loop.
  const isHttps = c.env.APP_ENV === 'production';
  const cookieName = `${isHttps ? '__Secure-' : ''}better-auth.session_token`;
  const cookieValue = await serializeSignedCookie(
    cookieName,
    session.token,
    c.env.BETTER_AUTH_SECRET,
    {
      path: '/',
      httpOnly: true,
      secure: isHttps,
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * 30,
    },
  );
  c.header('Set-Cookie', cookieValue);

  // If a real OAuth flow is in progress, replay the authorize request
  // with the original query string — better-auth picks up the now-valid
  // session cookie and proceeds to consent. Otherwise show a friendly
  // success page.
  if (inOAuthFlow) {
    return c.redirect(`${AUTHORIZE_ENDPOINT}?${oauthParams}`, 302);
  }
  return c.html(pairSuccessHTML());
});

// ── /oauth/consent HTML page ────────────────────────────────────────

oauthRoutes.get('/oauth/consent', async (c) => {
  const consentCode = c.req.query('consent_code') ?? '';
  const clientId = c.req.query('client_id') ?? '(unknown client)';
  const scope = c.req.query('scope') ?? '';
  return c.html(consentPageHTML({ consentCode, clientId, scopes: scope.split(' ').filter(Boolean) }));
});

// ── HTML templates ──────────────────────────────────────────────────

const HERBARIUM_STYLES = `
  :root {
    --vellum: #EFE5CC;
    --vellum-hi: #F5EDD8;
    --vellum-lo: #E2D3AE;
    --ink: #2A1A0C;
    --ink-soft: rgba(42,26,12,0.70);
    --ink-faint: rgba(42,26,12,0.32);
    --sepia: #6E4A22;
    --sage: #7A8A66;
    --rose: #B05246;
    --ochre: #C7912F;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: 'Spectral', 'New York', Georgia, serif;
    background: radial-gradient(140% 100% at 50% 0%, var(--vellum-hi), var(--vellum) 60%, var(--vellum-lo) 100%);
    color: var(--ink);
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 48px 20px;
  }
  .page {
    max-width: 460px;
    width: 100%;
  }
  .folio {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 11px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--sepia);
    margin-bottom: 24px;
  }
  .folio em { font-style: italic; color: var(--ink-soft); letter-spacing: 1px; text-transform: none; }
  h1 {
    font-style: italic;
    font-weight: 300;
    font-size: 38px;
    line-height: 1;
    margin: 0 0 6px;
  }
  .subtitle {
    font-style: italic;
    color: var(--ink-soft);
    margin: 0 0 24px;
    font-size: 14px;
  }
  hr.rule {
    border: 0;
    height: 0.5px;
    background: var(--ink-faint);
    margin: 18px 0;
    position: relative;
  }
  hr.rule::after {
    content: '◆ ◇ ◆';
    position: absolute;
    left: 50%;
    top: -10px;
    transform: translateX(-50%);
    background: var(--vellum);
    padding: 0 8px;
    color: var(--sepia);
    font-size: 10px;
    letter-spacing: 4px;
  }
  label {
    display: block;
    font-size: 10px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--sepia);
    margin-bottom: 6px;
  }
  input[type="text"] {
    width: 100%;
    padding: 12px 14px;
    font-size: 22px;
    font-family: ui-monospace, SFMono-Regular, monospace;
    letter-spacing: 4px;
    text-align: center;
    text-transform: uppercase;
    background: var(--vellum-hi);
    border: 0.5px solid var(--ink-faint);
    color: var(--ink);
    border-radius: 0;
    outline: none;
  }
  input[type="text"]:focus { border-color: var(--sepia); }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 20px;
  }
  button, .btn {
    flex: 1;
    padding: 14px 18px;
    font-family: 'IM Fell English SC', 'Spectral', serif;
    font-size: 11px;
    letter-spacing: 2px;
    text-transform: uppercase;
    border: 0.5px solid var(--ink-faint);
    background: transparent;
    color: var(--ink);
    cursor: pointer;
    border-radius: 0;
  }
  button.primary, .btn.primary {
    background: var(--sepia);
    color: var(--vellum-hi);
    border-color: var(--sepia);
  }
  button.danger { color: var(--rose); border-color: var(--rose); }
  .error {
    background: rgba(176,82,70,0.10);
    border: 0.5px solid var(--rose);
    color: var(--rose);
    padding: 10px 12px;
    font-style: italic;
    font-size: 13px;
    margin-bottom: 16px;
  }
  .scopes {
    background: var(--vellum-hi);
    border: 0.5px solid var(--ink-faint);
    padding: 12px 14px;
    margin: 12px 0;
  }
  .scopes li {
    font-style: italic;
    margin-bottom: 4px;
    color: var(--ink);
  }
  .help {
    color: var(--ink-soft);
    font-style: italic;
    font-size: 13px;
    line-height: 1.5;
    margin: 16px 0 0;
  }
`;

function loginPageHTML(opts: {
  inOAuthFlow: boolean;
  originalParams: string;
  error: string;
}) {
  const subtitle = opts.inOAuthFlow
    ? 'A client is asking to connect to your Seedkeep garden. Type the code your Seedkeep app shows under Settings → Sprout · the scribe → Connect Claude / MCP → Pair browser, then approve the request on the next screen.'
    : 'Type the code your Seedkeep app shows under Settings → Sprout · the scribe → Connect Claude / MCP → Pair browser.';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Seedkeep · Authorize</title>
  <style>${HERBARIUM_STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="folio"><span>Seedkeep</span><em>${opts.inOAuthFlow ? 'authorize' : 'pair browser'}</em></div>
    <h1>Pair your browser</h1>
    <p class="subtitle">${subtitle}</p>
    <hr class="rule">
    ${opts.error ? `<div class="error">${escapeHTML(opts.error)}</div>` : ''}
    <form method="POST" action="/oauth/pair">
      <input type="hidden" name="oauthParams" value="${escapeAttr(opts.originalParams)}">
      <label for="code">Pairing code</label>
      <input id="code" type="text" name="code" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="16" required>
      <div class="actions">
        <button type="submit" class="primary">Pair browser</button>
      </div>
    </form>
    <p class="help">The code is good for ten minutes and can only be used once. Generate a fresh one in the app if it expires.</p>
  </div>
</body>
</html>`;
}

function consentErrorHTML(detail: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Seedkeep · Consent failed</title>
  <style>${HERBARIUM_STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="folio"><span>Seedkeep</span><em>consent failed</em></div>
    <h1>Couldn't finish the connection</h1>
    <p class="subtitle">The authorization server didn't accept the consent submission.</p>
    <hr class="rule">
    <pre style="background: var(--vellum-hi); padding: 12px; border: 0.5px solid var(--ink-faint); white-space: pre-wrap; font-size: 12px; color: var(--ink);">${escapeHTML(detail).slice(0, 1200)}</pre>
    <p class="help">Head back to your client and start the connect flow again. If this keeps happening, the pairing code may have expired before consent — generate a fresh one.</p>
  </div>
</body>
</html>`;
}

function pairSuccessHTML() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Seedkeep · Paired</title>
  <style>${HERBARIUM_STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="folio"><span>Seedkeep</span><em>paired</em></div>
    <h1>Browser paired</h1>
    <p class="subtitle">This browser is now signed in to your Seedkeep account. To grant a Claude.ai or other MCP client access, start the connect flow there and you'll be returned here to approve.</p>
    <hr class="rule">
    <p class="help">If you were already mid-flow in another tab, head back to that tab to continue. You can close this window otherwise.</p>
  </div>
</body>
</html>`;
}

function consentPageHTML(opts: { consentCode: string; clientId: string; scopes: string[] }) {
  const scopeLabels: Record<string, string> = {
    'openid': 'Identify you (read-only)',
    'profile': 'Read your account name',
    'email': 'Read your account email',
    'offline_access': 'Stay connected after you close the browser',
    'seedkeep:read': 'Read your seed library, beds, planting events, journal, and recommendations',
    'seedkeep:write': 'Create + update planting events, journal entries, checklist items, and confirmed destructive changes',
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Seedkeep · Authorize ${escapeHTML(opts.clientId)}</title>
  <style>${HERBARIUM_STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="folio"><span>Seedkeep</span><em>consent</em></div>
    <h1>Connect to ${escapeHTML(opts.clientId)}?</h1>
    <p class="subtitle">This client is asking permission to use the Seedkeep tools on your behalf.</p>
    <hr class="rule">
    <ul class="scopes">
      ${opts.scopes.map((s) => `<li>${escapeHTML(scopeLabels[s] ?? s)}</li>`).join('')}
    </ul>
    <form method="POST" action="/oauth2/consent">
      <input type="hidden" name="consent_code" value="${escapeAttr(opts.consentCode)}">
      <input type="hidden" name="accept" value="true">
      <div class="actions">
        <button type="submit" name="accept" value="false" formaction="/oauth2/consent" class="danger">Cancel</button>
        <button type="submit" name="accept" value="true" formaction="/oauth2/consent" class="primary">Authorize</button>
      </div>
    </form>
    <p class="help">You can revoke this connection at any time from the Seedkeep app under Settings → Sprout · the scribe → Connect Claude / MCP.</p>
  </div>
</body>
</html>`;
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHTML(s);
}
