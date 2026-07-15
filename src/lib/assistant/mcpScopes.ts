export const MCP_READ_SCOPE = 'seedkeep:read' as const;
export const MCP_WRITE_SCOPE = 'seedkeep:write' as const;

export type McpScope = typeof MCP_READ_SCOPE | typeof MCP_WRITE_SCOPE;

export function parseOAuthScopes(value: string): ReadonlySet<string> {
  return new Set(value.split(/\s+/).filter(Boolean));
}

/** Personal MCP tokens omit scopes and retain unrestricted read/write access. */
export function isMcpToolAllowed(
  requiredScope: McpScope,
  grantedScopes?: ReadonlySet<string>,
): boolean {
  return !grantedScopes || grantedScopes.has(requiredScope);
}
