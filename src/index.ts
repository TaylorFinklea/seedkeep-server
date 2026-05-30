import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';
import { envelope } from './middleware/envelope';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { householdRoutes } from './routes/households';
import { locationRoutes } from './routes/locations';
import { tagRoutes } from './routes/tags';
import { seedRoutes } from './routes/seeds';
import { randomRoutes } from './routes/random';
import { photoRoutes } from './routes/photos';
import { catalogRoutes } from './routes/catalog';
import { extractionRoutes } from './routes/extractions';
import { subscriptionRoutes } from './routes/subscriptions';
import { bedRoutes } from './routes/beds';
import { plantingEventRoutes } from './routes/planting-events';
import { recommendationRoutes } from './routes/recommendations';
import { journalRoutes } from './routes/journal';
import { assistantRoutes } from './routes/assistant';
import { mcpTokenRoutes, mcpTransportRoutes } from './routes/mcp';
import { oauthPublicRoutes, oauthApiRoutes } from './routes/oauth';

/**
 * Hono app shape. Bindings carry the validated `Env`; per-request
 * variables are populated by middleware (`requireAuth` sets `userId`,
 * `requireHousehold` sets `householdId`).
 */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
    householdId: string;
  };
};

export function createApp(env: Env): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Inject env into context so route handlers can read it via c.env.
  app.use('*', async (c, next) => {
    Object.assign(c.env, env);
    await next();
  });

  // Native iOS clients send no Origin header so they bypass the CORS gate.
  // Allow localhost dev hosts for the eventual web companion; refuse the rest.
  app.use('*', cors({
    origin: (origin) => {
      if (!origin) return origin;
      if (origin.startsWith('http://localhost:')) return origin;
      return null;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['x-request-id'],
  }));

  app.use('*', envelope());

  // Public + auth-handler routes (no auth middleware required for these).
  app.route('/api', healthRoutes);
  app.route('/api', authRoutes);

  // Household-scoped routes. Each route file applies `requireAuth()` and
  // `requireHousehold()` internally. Mounting order matters for two cases:
  // `/seeds/random` MUST mount before `/seeds/:id`, and `/photos/:id`
  // sits next to per-seed photo routes.
  app.route('/api', randomRoutes);
  app.route('/api', seedRoutes);
  app.route('/api', householdRoutes);
  app.route('/api', locationRoutes);
  app.route('/api', tagRoutes);
  app.route('/api', photoRoutes);
  app.route('/api', catalogRoutes);
  app.route('/api', extractionRoutes);
  app.route('/api', subscriptionRoutes);
  app.route('/api', bedRoutes);
  app.route('/api', plantingEventRoutes);
  app.route('/api', recommendationRoutes);
  app.route('/api/journal', journalRoutes);
  app.route('/api/assistant', assistantRoutes);

  // MCP surface — split into two routers so each mounts at exactly
  // one path: token CRUD under /api, the wire-protocol endpoint at
  // root (per RFC 9728 the resource URL is canonical there).
  app.route('/api', mcpTokenRoutes);
  app.route('/', mcpTransportRoutes);

  // OAuth 2.1 surface — split for the same reason. Browser-facing
  // pages + well-known metadata + endpoint proxies + pairing-code
  // POST sit at root; the placeholder /api router stays here in case
  // we add iOS-only OAuth endpoints later.
  app.route('/', oauthPublicRoutes);
  app.route('/api', oauthApiRoutes);

  app.notFound((c) =>
    c.json({ ok: false, error: { code: 'not_found', message: 'Route not found' } }, 404),
  );

  return app;
}
