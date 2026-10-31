import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { createApp } from '../index';

describe('browser CORS configuration', () => {
  const env = {
    APP_ENV: 'production',
    WEB_ORIGINS: 'https://garden.example',
  } as Env;

  it('allows configured credentials, write methods and the web client headers', async () => {
    const response = await createApp(env).request('/api/me', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://garden.example',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,x-household-id,if-match',
      },
    }, env);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://garden.example');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods')).toContain('PUT');
    const allowedHeaders = response.headers.get('access-control-allow-headers')?.toLowerCase();
    expect(allowedHeaders).toContain('x-household-id');
    expect(allowedHeaders).toContain('if-match');
  });

  it('does not grant an unconfigured browser origin', async () => {
    const response = await createApp(env).request('/api/me', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://attacker.invalid',
        'access-control-request-method': 'POST',
      },
    }, env);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('marks cookie-authenticated API responses non-cacheable', async () => {
    const response = await createApp(env).request('/api/me', {
      headers: { origin: 'https://garden.example' },
    }, env);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
