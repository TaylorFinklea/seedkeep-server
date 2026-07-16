import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, _resetEnv } from '../env';

// Minimal set of required env vars so `loadEnv` parses successfully;
// unrelated to GARDEN_TOOLS_ENABLED itself.
const REQUIRED_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_BUCKET: 'test-bucket',
  BETTER_AUTH_SECRET: 'test-better-auth-secret-1234567890',
  APPLE_CLIENT_ID: 'test-apple-client',
  APPLE_CLIENT_SECRET: 'test-apple-secret',
};

describe('GARDEN_TOOLS_ENABLED — R1 CloudKit-cutover kill switch (umbrella ADR 2026-07-16)', () => {
  beforeEach(() => {
    _resetEnv();
  });

  it('defaults to disabled when unset — fails closed', () => {
    const env = loadEnv(REQUIRED_ENV);
    expect(env.GARDEN_TOOLS_ENABLED).toBe(false);
  });

  it('enables when explicitly set to the string "true"', () => {
    const env = loadEnv({ ...REQUIRED_ENV, GARDEN_TOOLS_ENABLED: 'true' });
    expect(env.GARDEN_TOOLS_ENABLED).toBe(true);
  });

  it('stays disabled when explicitly set to the string "false"', () => {
    const env = loadEnv({ ...REQUIRED_ENV, GARDEN_TOOLS_ENABLED: 'false' });
    expect(env.GARDEN_TOOLS_ENABLED).toBe(false);
  });
});
