import { describe, expect, it } from 'vitest';
import { getAuth } from '../auth';
import type { Env } from '../../env';

const env: Env = {
  PORT: 8787,
  APP_ENV: 'development',
  DATABASE_URL: 'postgres://seedkeep:test@localhost:5432/seedkeep',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_BUCKET: 'test-bucket',
  S3_FORCE_PATH_STYLE: false,
  BETTER_AUTH_SECRET: 'test-better-auth-secret-16',
  APPLE_CLIENT_ID: 'com.example.seedkeep',
  APPLE_CLIENT_SECRET: 'test-apple-client-secret',
  ANTHROPIC_API_KEY: undefined,
  APPLE_IAP_SHARED_SECRET: undefined,
  ASSISTANT_KEY_MASTER: undefined,
  ADMIN_SECRET: undefined,
  DEFAULT_VISION_MODEL: 'test-vision',
  DEFAULT_REVIEW_MODEL: 'test-review',
  GARDEN_TOOLS_ENABLED: true,
};

describe('MCP OAuth discovery metadata', () => {
  it('advertises Seedkeep scopes in both OAuth discovery documents', async () => {
    const auth = getAuth(env);

    for (const path of [
      '/api/auth/.well-known/oauth-authorization-server',
      '/api/auth/.well-known/oauth-protected-resource',
    ]) {
      const response = await auth.handler(new Request(`http://localhost:8787${path}`));
      expect(response.status, path).toBe(200);
      const body = await response.json() as { scopes_supported?: string[] };
      expect(body.scopes_supported, path).toEqual(expect.arrayContaining([
        'seedkeep:read',
        'seedkeep:write',
      ]));
    }
  });
});
