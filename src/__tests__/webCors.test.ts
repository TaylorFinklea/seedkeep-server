import { describe, expect, it } from 'vitest';
import { createApp } from '../index';
import type { Env } from '../env';

const env = (overrides: Partial<Env> = {}): Env => ({
  PORT: 8787, APP_ENV: 'development', DATABASE_URL: 'postgres://seedkeep:test@localhost/seedkeep',
  S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'test-key', S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_BUCKET: 'test-bucket', S3_FORCE_PATH_STYLE: false, BETTER_AUTH_SECRET: 'test-secret-at-least-16',
  APPLE_CLIENT_ID: 'client', APPLE_CLIENT_SECRET: 'secret', DEFAULT_VISION_MODEL: 'vision',
  DEFAULT_REVIEW_MODEL: 'review', GARDEN_TOOLS_ENABLED: false, ANTHROPIC_API_KEY: undefined,
  APPLE_IAP_SHARED_SECRET: undefined, ASSISTANT_KEY_MASTER: undefined, ADMIN_SECRET: undefined, ...overrides,
});

async function preflight(appEnv: Env, origin?: string) {
  const headers = new Headers({ 'Access-Control-Request-Method': 'PUT' });
  if (origin !== undefined) headers.set('Origin', origin);
  return createApp(appEnv).request('/api/households', { method: 'OPTIONS', headers }, appEnv);
}

describe('web CORS policy', () => {
  it('passes no-Origin native preflights without an allow-origin header', async () => {
    const response = await preflight(env());
    expect(response.status).toBe(204);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });

  it('echoes configured origins with credentials and the household selection headers', async () => {
    const response = await preflight(env({ APP_ORIGINS: 'https://app.example.test' }), 'https://app.example.test');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.test');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-household-id');
  });

  it('allows loopback in development but refuses it in production and refuses foreign origins', async () => {
    expect((await preflight(env(), 'http://localhost:5173')).headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect((await preflight(env({ APP_ENV: 'production' }), 'http://localhost:5173')).headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect((await preflight(env(), 'https://evil.test')).headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
});
