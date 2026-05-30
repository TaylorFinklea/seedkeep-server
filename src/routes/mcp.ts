// Phase 4 E — Personal MCP token management + the MCP transport.
//
// Two surface areas in this file:
//
// 1. Token CRUD (`/api/mcp/tokens`) — authenticated with the user's
//    normal session. Creates / lists / revokes the bearer tokens that
//    a user pastes into Claude Desktop's MCP config.
//
// 2. The MCP transport (`/mcp`) — accepts JSON-RPC MCP requests from
//    Claude clients, authenticated via the bearer token. Streams
//    responses back over standard streamable HTTP.

import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { createHash, randomBytes } from 'node:crypto';
import type { AppEnv } from '../index';
import { requireAuth } from '../middleware/auth';
import { requireHousehold } from '../middleware/household';
import { dbAll, dbGet, dbRun } from '../db/helpers';
import { getSql } from '../db/client';
import { WebStandardStreamableHTTPServerTransport } from
  '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from '../lib/assistant/mcpServer';

// Two routers from one file — token CRUD lives under /api/mcp/tokens
// while the MCP wire-protocol endpoint lives at /mcp at the root.
// Splitting them avoids mounting one router at both `/` and `/api`,
// which previously created four valid URL aliases per endpoint.
export const mcpTokenRoutes = new Hono<AppEnv>();
export const mcpTransportRoutes = new Hono<AppEnv>();

/// Compute the public-facing origin behind Fly's TLS proxy. Fly
/// rewrites the URL to internal HTTP, so `req.url` shows http://...
/// — we sniff X-Forwarded-Proto + Host to reconstruct the
/// client-visible https URL.
function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = req.headers.get('host') ?? url.host;
  return `${proto}://${host}`;
}

// ── Token CRUD ───────────────────────────────────────────────────────

const tokenAuth = [requireAuth(), requireHousehold()] as const;

const CreateTokenBody = z.object({
  label: z.string().min(1).max(64).optional(),
});

interface MCPTokenRow {
  id: string;
  household_id: string;
  user_id: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/**
 * POST /api/mcp/tokens — issue a new bearer token.
 * Body: { label?: string }
 * Response: { id, label, token, created_at }
 *
 * The raw `token` is returned ONCE. We persist only its SHA-256 hash.
 * Tokens are namespaced `mcp_<id>.<secret>` so the server can short-
 * circuit the hash lookup by the id before verifying the secret.
 */
mcpTokenRoutes.post('/mcp/tokens', ...tokenAuth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const userId = c.get('userId') as string;

  let parsed: z.infer<typeof CreateTokenBody>;
  try {
    parsed = CreateTokenBody.parse(await c.req.json().catch(() => ({})));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid body';
    return c.json({ ok: false, error: { code: 'bad_request', message } }, 400);
  }

  const id = nanoid(12);
  const secret = randomBytes(32).toString('base64url');
  const token = `mcp_${id}.${secret}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const label = parsed.label ?? 'Untitled';

  await dbRun(
    sql,
    `INSERT INTO mcp_tokens
        (id, household_id, user_id, label, token_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, householdId, userId, label, tokenHash, now],
  );

  return c.json({ ok: true, data: { id, label, token, created_at: now } });
});

/**
 * GET /api/mcp/tokens — list non-revoked tokens for this household.
 * The raw token value is never returned — only the metadata.
 */
mcpTokenRoutes.get('/mcp/tokens', ...tokenAuth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const rows = await dbAll<MCPTokenRow>(
    sql,
    `SELECT id, household_id, user_id, label, created_at, last_used_at, revoked_at
       FROM mcp_tokens
      WHERE household_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [householdId],
  );
  return c.json({ ok: true, data: { tokens: rows } });
});

/**
 * DELETE /api/mcp/tokens/:id — revoke a token. We mark `revoked_at`
 * rather than deleting so the audit trail survives. The MCP transport
 * checks `revoked_at IS NULL` before accepting a token.
 */
mcpTokenRoutes.delete('/mcp/tokens/:id', ...tokenAuth, async (c) => {
  const sql = getSql(c.env);
  const householdId = c.get('householdId') as string;
  const id = c.req.param('id');
  const now = Date.now();
  const result = await dbRun(
    sql,
    `UPDATE mcp_tokens
        SET revoked_at = $1
      WHERE id = $2 AND household_id = $3 AND revoked_at IS NULL`,
    [now, id, householdId],
  );
  // 0 rows means the id doesn't exist, belongs to another household,
  // or was already revoked. Surface that as 404 instead of a fake
  // success so the iOS UI can distinguish "really revoked" from
  // "nothing to do".
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: { code: 'not_found',
      message: 'Token not found or already revoked' } }, 404);
  }
  return c.json({ ok: true, data: { id, revoked_at: now } });
});

// ── MCP transport ────────────────────────────────────────────────────

/**
 * POST /mcp · GET /mcp · DELETE /mcp — the MCP wire protocol endpoint.
 * Authenticated via Authorization: Bearer <token>. Token format:
 *   mcp_<id>.<secret>
 *
 * The transport is stateless (per-request session) for simplicity —
 * Claude Desktop's MCP client opens a fresh streaming connection per
 * tool invocation cycle.
 */
mcpTransportRoutes.all('/mcp', async (c) => {
  const sql = getSql(c.env);

  // Authenticate. Bearer token in the standard Authorization header.
  const authHeader = c.req.header('authorization') || c.req.header('Authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    // RFC 9728 — point clients at our resource-metadata document so
    // OAuth-aware MCP clients (claude.ai) can begin the OAuth dance.
    const wwwAuth = `Bearer realm="seedkeep", resource_metadata="${publicOrigin(c.req.raw)}/.well-known/oauth-protected-resource"`;
    c.header('WWW-Authenticate', wwwAuth);
    return c.json({ ok: false, error: { code: 'unauthorized',
      message: 'Missing Authorization header. Use Bearer with an MCP token or an OAuth access token.' } }, 401);
  }
  const token = authHeader.slice(7).trim();

  // Resolve to a household_id either via our personal MCP-token format
  // (mcp_<id>.<secret> against `mcp_tokens`) OR via a better-auth
  // OAuth access token (looked up in `oauthAccessToken` and joined to
  // the user's primary household via memberships).
  let householdId: string | null = null;

  if (token.startsWith('mcp_')) {
    const parts = token.split('.');
    if (parts.length === 2) {
      const id = parts[0].slice(4);
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const row = await dbGet<MCPTokenRow>(
        sql,
        `SELECT id, household_id, user_id, label, created_at, last_used_at, revoked_at
           FROM mcp_tokens
          WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL
          LIMIT 1`,
        [id, tokenHash],
      );
      if (row) {
        householdId = row.household_id;
        void dbRun(sql, `UPDATE mcp_tokens SET last_used_at = $1 WHERE id = $2`, [Date.now(), id]);
      }
    }
  } else {
    // OAuth access token from better-auth's OIDC provider.
    const oauth = await dbGet<{ userId: string; expiresAt: Date }>(
      sql,
      `SELECT "userId", "accessTokenExpiresAt" AS "expiresAt"
         FROM "oauthAccessToken"
        WHERE "accessToken" = $1 AND "accessTokenExpiresAt" > NOW()
        LIMIT 1`,
      [token],
    );
    if (oauth?.userId) {
      // Prefer the household the user pinned at pairing time — that's
      // what they intended when they typed the code from iOS. Falls
      // back to memberships with the SAME ordering as `requireHousehold`
      // so OAuth-MCP and iOS-session pick the same household when no
      // pin exists yet.
      const pinned = await dbGet<{ household_id: string }>(
        sql,
        `SELECT ouh.household_id
           FROM oauth_user_household ouh
           JOIN memberships m
             ON m.user_id = ouh.user_id
            AND m.household_id = ouh.household_id
          WHERE ouh.user_id = $1
          LIMIT 1`,
        [oauth.userId],
      );
      if (pinned?.household_id) {
        householdId = pinned.household_id;
      } else {
        const membership = await dbGet<{ household_id: string }>(
          sql,
          `SELECT household_id FROM memberships
            WHERE user_id = $1
            ORDER BY joined_at DESC
            LIMIT 1`,
          [oauth.userId],
        );
        if (membership?.household_id) {
          householdId = membership.household_id;
        }
      }
    }
  }

  if (!householdId) {
    const wwwAuth = `Bearer realm="seedkeep", error="invalid_token", resource_metadata="${publicOrigin(c.req.raw)}/.well-known/oauth-protected-resource"`;
    c.header('WWW-Authenticate', wwwAuth);
    return c.json({ ok: false, error: { code: 'unauthorized', message: 'Invalid, expired, or revoked token' } }, 401);
  }

  // Build a fresh MCP server scoped to this household.
  const server = buildMcpServer({ sql, householdId });

  // Stateless streamable HTTP transport. New session per request, no
  // server-held connection state — fine for Claude Desktop's MCP
  // client, which establishes a fresh stream per turn.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,            // stateless
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
