import { describe, expect, it } from 'vitest';
import { getKysely, getOTPLockSql, getSql } from '../client';
import type { Env } from '../../env';

const env = (databaseURL: string): Env => ({
  PORT: 8787,
  APP_ENV: 'development',
  DATABASE_URL: databaseURL,
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_BUCKET: 'test-bucket',
  S3_FORCE_PATH_STYLE: false,
  BETTER_AUTH_SECRET: 'test-better-auth-secret-16',
  APPLE_CLIENT_ID: 'test-client',
  APPLE_CLIENT_SECRET: 'test-secret',
  ANTHROPIC_API_KEY: undefined,
  APPLE_IAP_SHARED_SECRET: undefined,
  ASSISTANT_KEY_MASTER: undefined,
  ADMIN_SECRET: undefined,
  DEFAULT_VISION_MODEL: 'test-vision',
  DEFAULT_REVIEW_MODEL: 'test-review',
  GARDEN_TOOLS_ENABLED: true,
});

describe('database client caches', () => {
  it('reuses clients per DATABASE_URL and isolates different databases', () => {
    const first = env('postgres://seedkeep:test@localhost:5432/seedkeep_first');
    const second = env('postgres://seedkeep:test@localhost:5432/seedkeep_second');

    expect(getSql(first)).toBe(getSql({ ...first }));
    expect(getSql(first)).not.toBe(getSql(second));
    expect(getKysely(first)).toBe(getKysely({ ...first }));
    expect(getKysely(first)).not.toBe(getKysely(second));
    expect(getOTPLockSql(first)).toBe(getOTPLockSql({ ...first }));
    expect(getOTPLockSql(first)).not.toBe(getOTPLockSql(second));
    expect(getOTPLockSql(first).options.max).toBe(5);
  });
});
