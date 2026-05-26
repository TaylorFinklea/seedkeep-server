// Phase 4 E — MCP server adapter.
//
// Exposes the same 24-tool registry that powers in-app Sprout (BYOK) as
// a Model Context Protocol server. Users connect from Claude Desktop /
// claude.ai by pasting a bearer token issued from the iOS app.
//
// All tool calls go through the existing `executeTool` from
// `executor.ts`. For destructive ops (status: 'proposed'), we
// immediately apply the change in MCP context — the user is driving
// their Claude chat by hand, so there's no separate in-app confirm
// step to pause for. The tool definitions are surfaced verbatim to the
// LLM via Claude's tool_use blocks, so the user sees what's about to
// run before Claude commits.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Sql } from 'postgres';
import { TOOL_REGISTRY } from './tools';
import { executeTool, executeProposedChange } from './executor';

/**
 * Build a fully-configured MCP server scoped to a single household.
 *
 * A new instance is constructed per HTTP request so the database
 * handle + household are baked in and can't bleed across users.
 */
export function buildMcpServer(args: {
  sql: Sql;
  householdId: string;
}): McpServer {
  const { sql, householdId } = args;

  const server = new McpServer(
    { name: 'seedkeep', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Seedkeep is a personal gardening companion. Tools read and write the household\'s seed library, garden beds, planting events, journal entries, catalog, and recommendations. Destructive operations (delete, update, change home ZIP) apply immediately when invoked — review the tool_use block before authorizing.',
    },
  );

  for (const def of Object.values(TOOL_REGISTRY)) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: zodSchemaShape(def.schema),
      },
      async (rawArgs: unknown) => {
        const ctx = { sql, householdId };
        const result = await executeTool(def.name, rawArgs, ctx);

        // Destructive op? In-app the user gets a Confirm/Cancel card.
        // In MCP we apply immediately — the user already authorized
        // the tool_use by letting Claude run it in their chat.
        if (result.status === 'proposed') {
          const applied = await executeProposedChange(def.name, rawArgs, ctx);
          return mcpResponse(applied);
        }
        return mcpResponse(result);
      },
    );
  }

  return server;
}

/// MCP `tools/call` expects a `content` array. We serialize the
/// executor result as a single JSON text block so the LLM gets the
/// full structured payload. Errors set `isError: true` per the MCP
/// spec, which makes Claude show the failure inline.
function mcpResponse(result: Awaited<ReturnType<typeof executeTool>>) {
  if (result.status === 'failed' && result.error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: result.error }, null, 2),
        },
      ],
      isError: true,
    };
  }
  const payload =
    result.status === 'proposed'
      ? { proposed_change: result.proposed_change }
      : { result: result.result };
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/// Extract a zod object's `.shape` for the MCP SDK. The registry
/// stores schemas as `z.ZodObject<...>`, so `.shape` is always defined.
/// Falls back to an empty shape for safety.
function zodSchemaShape(schema: unknown): z.ZodRawShape {
  if (schema && typeof schema === 'object' && 'shape' in schema) {
    const shape = (schema as { shape: unknown }).shape;
    if (shape && typeof shape === 'object') {
      return shape as z.ZodRawShape;
    }
  }
  return {};
}
