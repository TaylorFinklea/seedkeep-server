/**
 * Bun entrypoint. Loads validated env, builds the Hono app, and starts
 * `Bun.serve`. Workers / Node deployments would replace this file with
 * their own entry; the rest of the codebase stays runtime-agnostic.
 */

import { loadEnv } from './env';
import { createApp } from './index';
import { closeDb } from './db/client';

const env = loadEnv();
const app = createApp(env);

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

console.log(`seedkeep-server listening on http://localhost:${server.port} (env=${env.APP_ENV})`);

const shutdown = async (signal: string) => {
  console.log(`\n→ ${signal} received, draining…`);
  server.stop();
  await closeDb();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
