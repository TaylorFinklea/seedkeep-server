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
  GARDEN_TOOLS_ENABLED: true,
} as Env;

describe('MCP OAuth transport authorization', () => {
  beforeEach(() => {
    dbGet.mockReset();
  });

  it('rejects an OAuth token without any Seedkeep scope before household resolution', async () => {
    dbGet.mockResolvedValue({
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
      scopes: 'openid profile',
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
        message: 'OAuth token must grant seedkeep:read or seedkeep:write',
      },
    });
    expect(dbGet).toHaveBeenCalledTimes(1);
  });

  it('admits a read-only OAuth token and reaches MCP initialization', async () => {
    dbGet
      .mockResolvedValueOnce({
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
        scopes: 'openid seedkeep:read',
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ household_id: 'hh-1' });

    const response = await mcpTransportRoutes.request(
      new Request('https://seedkeep.test/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-read-only',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'scope-test', version: '1.0.0' },
          },
        }),
      }),
      {},
      env,
    );

    expect(response.status).toBe(200);
    expect(dbGet).toHaveBeenCalledTimes(3);
  });
});

describe('R1 garden-tool kill switch (umbrella ADR 2026-07-16)', () => {
  const disabledEnv = {
    DATABASE_URL: 'postgres://test',
    GARDEN_TOOLS_ENABLED: false,
  } as Env;

  beforeEach(() => {
    dbGet.mockReset();
  });

  it('still initializes and lists zero tools when garden tools are disabled', async () => {
    dbGet
      .mockResolvedValueOnce({
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
        scopes: 'openid seedkeep:read',
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ household_id: 'hh-1' });

    const initResponse = await mcpTransportRoutes.request(
      new Request('https://seedkeep.test/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-read-only',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'kill-switch-test', version: '1.0.0' },
          },
        }),
      }),
      {},
      disabledEnv,
    );
    expect(initResponse.status).toBe(200);

    dbGet
      .mockResolvedValueOnce({
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
        scopes: 'openid seedkeep:read',
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ household_id: 'hh-1' });

    const listResponse = await mcpTransportRoutes.request(
      new Request('https://seedkeep.test/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-read-only',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      }),
      {},
      disabledEnv,
    );
    expect(listResponse.status).toBe(200);
    const body = await listResponse.json() as { result?: { tools?: unknown[] } };
    expect(body.result?.tools).toEqual([]);
  });
});
