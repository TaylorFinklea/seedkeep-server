import { Hono } from 'hono';
import type { AppEnv } from '../index';

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/health', (c) => {
  return c.json({ ok: true, data: { status: 'healthy', env: c.env.APP_ENV } });
});
