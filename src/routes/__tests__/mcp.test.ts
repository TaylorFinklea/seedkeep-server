import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../env';

const dbGet = vi.fn();

vi.mock('../../db/client', () => ({
  getSql: vi.fn(() => null),
}));
vi.mock('../../db/helpers', () => ({
  dbAll: vi.fn(),
  dbGet,
  dbRun: vi.fn(),
}));

const { mcpTransportRoutes } = await import('../mcp');

const env = {
  DATABASE_URL: 'postgres://test',
} as Env;

describe('MCP OAuth transport authorization', () => {
  beforeEach(() => {
    dbGet.mockReset();
  });

  it('rejects an OAuth token without both Seedkeep scopes before household resolution', async () => {
    dbGet.mockResolvedValue({
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
      scopes: 'openid seedkeep:read',
    });

    const response = await mcpTransportRoutes.request(
      new Request('https://seedkeep.test/mcp', {
        headers: { authorization: 'Bearer oauth-read-only' },
      }),
      {},
      env,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: 'insufficient_scope',
        message: 'OAuth token must grant seedkeep:read and seedkeep:write',
      },
    });
    expect(dbGet).toHaveBeenCalledTimes(1);
  });
});
