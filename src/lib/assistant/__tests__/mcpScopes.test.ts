import { describe, expect, it } from 'vitest';
import {
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  hasMcpAccessScope,
  isMcpToolAllowed,
  parseOAuthScopes,
} from '../mcpScopes';
import { buildMcpServer, executeMcpTool } from '../mcpServer';
import { TOOL_REGISTRY } from '../tools';

describe('MCP OAuth scopes', () => {
  it('parses a space-separated OAuth scope claim', () => {
    expect(parseOAuthScopes(`openid  ${MCP_READ_SCOPE} ${MCP_READ_SCOPE}`)).toEqual(
      new Set(['openid', MCP_READ_SCOPE]),
    );
  });

  it('admits either Seedkeep capability scope at the MCP transport boundary', () => {
    expect(hasMcpAccessScope(parseOAuthScopes(`${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`))).toBe(true);
    expect(hasMcpAccessScope(parseOAuthScopes(MCP_READ_SCOPE))).toBe(true);
    expect(hasMcpAccessScope(parseOAuthScopes(MCP_WRITE_SCOPE))).toBe(true);
    expect(hasMcpAccessScope(parseOAuthScopes('openid'))).toBe(false);
  });

  it('allows only tools covered by a scoped OAuth token', () => {
    const readOnly = parseOAuthScopes(MCP_READ_SCOPE);
    expect(isMcpToolAllowed(MCP_READ_SCOPE, readOnly)).toBe(true);
    expect(isMcpToolAllowed(MCP_WRITE_SCOPE, readOnly)).toBe(false);
  });

  it('leaves personal MCP tokens unrestricted', () => {
    expect(isMcpToolAllowed(MCP_READ_SCOPE)).toBe(true);
    expect(isMcpToolAllowed(MCP_WRITE_SCOPE)).toBe(true);
  });

  it('blocks a write callback even when invoked outside tool discovery', async () => {
    const result = await executeMcpTool({
      def: TOOL_REGISTRY.create_journal_entry,
      rawArgs: { occurred_on: '2026-07-15', body: 'not authorized' },
      ctx: { sql: null as never, householdId: 'hh-1' },
      scopes: parseOAuthScopes(MCP_READ_SCOPE),
      gardenToolsEnabled: true,
    });

    expect(result).toEqual({
      status: 'failed',
      error: { code: 'insufficient_scope', message: 'OAuth token does not grant seedkeep:write' },
    });
  });

  it('registers only read tools for a read-only OAuth token', () => {
    const server = buildMcpServer({
      sql: null as never,
      householdId: 'hh-1',
      scopes: parseOAuthScopes(MCP_READ_SCOPE),
      gardenToolsEnabled: true,
    });
    const registered = (server as unknown as {
      _registeredTools: Record<string, unknown>;
    })._registeredTools;

    expect(Object.keys(registered)).toContain('list_seeds');
    expect(Object.keys(registered)).not.toContain('create_journal_entry');
  });

  it('registers all tools for a personal MCP token', () => {
    const server = buildMcpServer({ sql: null as never, householdId: 'hh-1', gardenToolsEnabled: true });
    const registered = (server as unknown as {
      _registeredTools: Record<string, unknown>;
    })._registeredTools;

    expect(Object.keys(registered)).toHaveLength(25);
  });
});

describe('R1 garden-tool kill switch (umbrella ADR 2026-07-16)', () => {
  it('registers zero tools when garden tools are disabled, even for a personal MCP token', () => {
    const server = buildMcpServer({ sql: null as never, householdId: 'hh-1', gardenToolsEnabled: false });
    const registered = (server as unknown as {
      _registeredTools: Record<string, unknown>;
    })._registeredTools;

    expect(Object.keys(registered)).toHaveLength(0);
  });

  it('double-gates executeMcpTool: returns capability_unavailable when invoked while disabled', async () => {
    const result = await executeMcpTool({
      def: TOOL_REGISTRY.list_seeds,
      rawArgs: {},
      ctx: { sql: null as never, householdId: 'hh-1' },
      gardenToolsEnabled: false,
    });

    expect(result).toEqual({
      status: 'failed',
      error: {
        code: 'capability_unavailable',
        message: 'Garden tools are unavailable during the CloudKit transition.',
      },
    });
  });
});
