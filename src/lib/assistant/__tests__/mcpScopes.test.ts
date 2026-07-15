import { describe, expect, it } from 'vitest';
import {
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  isMcpToolAllowed,
  parseOAuthScopes,
} from '../mcpScopes';
import { buildMcpServer } from '../mcpServer';

describe('MCP OAuth scopes', () => {
  it('parses a space-separated OAuth scope claim', () => {
    expect(parseOAuthScopes(`openid  ${MCP_READ_SCOPE} ${MCP_READ_SCOPE}`)).toEqual(
      new Set(['openid', MCP_READ_SCOPE]),
    );
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

  it('registers only read tools for a read-only OAuth token', () => {
    const server = buildMcpServer({
      sql: null as never,
      householdId: 'hh-1',
      scopes: parseOAuthScopes(MCP_READ_SCOPE),
    });
    const registered = (server as unknown as {
      _registeredTools: Record<string, unknown>;
    })._registeredTools;

    expect(Object.keys(registered)).toContain('list_seeds');
    expect(Object.keys(registered)).not.toContain('create_journal_entry');
  });

  it('registers all tools for a personal MCP token', () => {
    const server = buildMcpServer({ sql: null as never, householdId: 'hh-1' });
    const registered = (server as unknown as {
      _registeredTools: Record<string, unknown>;
    })._registeredTools;

    expect(Object.keys(registered)).toHaveLength(25);
  });
});
