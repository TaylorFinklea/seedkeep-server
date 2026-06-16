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
  // 16 MB ceiling: large enough for a direct-bytes photo (iOS resizes to
  // well under 10 MB) but well below the 256 MB Fly VM RAM. Without this
  // Bun buffers up to its 128 MB default before the route handler sees
  // the body, making the server trivially OOM-able.
  maxRequestBodySize: 16 * 1024 * 1024,
});

console.log(`seedkeep-server listening on http://localhost:${server.port} (env=${env.APP_ENV})`);

const shutdown = async (signal: string) => {
  console.log(`\n→ ${signal} received, draining…`);
  // Await server stop with a bounded timeout (25s, under fly.toml
  // kill_timeout=120s) so in-flight stream handlers can flush their
  // finally blocks before we close the DB connection.
  await Promise.race([
    server.stop(),
    new Promise<void>((resolve) => setTimeout(resolve, 25_000)),
  ]);
  await closeDb();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
