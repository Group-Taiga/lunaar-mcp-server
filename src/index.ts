#!/usr/bin/env node
/**
 * MCP server entry point. Speaks stdio (the format every MCP host — Claude Desktop,
 * Cursor, Windsurf, Continue — supports out of the box). HTTP/SSE transport is
 * intentionally NOT wired here: stdio keeps the install one line of config and
 * avoids exposing ports the host has to manage.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { LunaarClient } from "./client.js";
import { registerAllTools } from "./tools.js";

async function main(): Promise<void> {
  const client = new LunaarClient();

  const server = new McpServer({
    name: "lunaar",
    version: "0.1.0",
  });

  registerAllTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Stderr (not stdout) — stdout is reserved for the JSON-RPC channel; emitting
  // anything else there would break the host's parser.
  console.error("[lunaar-mcp-server] fatal error:", err);
  process.exit(1);
});
