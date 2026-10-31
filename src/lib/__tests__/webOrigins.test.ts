import { describe, expect, it } from 'vitest';
import { getWebOrigins, isWebOriginAllowed } from '../webOrigins';

describe('web origin allowlist', () => {
  it('uses localhost-only defaults in development', () => {
    expect(getWebOrigins({ APP_ENV: 'development', WEB_ORIGINS: undefined })).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  it('requires exact configured origins outside development', () => {
    const env = { APP_ENV: 'production' as const, WEB_ORIGINS: 'https://garden.example, https://admin.example' };
    expect(isWebOriginAllowed(env, 'https://garden.example')).toBe(true);
    expect(isWebOriginAllowed(env, 'https://garden.example.evil.invalid')).toBe(false);
    expect(getWebOrigins({ APP_ENV: 'production', WEB_ORIGINS: undefined })).toEqual([]);
  });

  it.each([
    'https://garden.example/path',
    'https://garden.example/',
    'http://garden.example',
    'https://user@garden.example',
  ])('rejects a non-origin or insecure configured URL: %s', (origin) => {
    expect(() => getWebOrigins({ APP_ENV: 'production', WEB_ORIGINS: origin })).toThrow();
  });
});
