#!/usr/bin/env node
/**
 * MCP server entry point. Speaks stdio (the format every MCP host — Claude
 * Desktop, Cursor, Windsurf, Continue — supports out of the box).
 *
 * Tool definitions come from a remote manifest (live → on-disk cache →
 * bundled fallback), so adding a new endpoint or extending an existing tool
 * is a server-side deploy with no SDK release. See ./manifest-loader.ts and
 * ./engine.ts for the moving parts.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadManifest } from "./manifest-loader.js";
import { registerManifest } from "./engine.js";

async function main(): Promise<void> {
  const apiKey = process.env.LUNAAR_API_KEY;
  if (!apiKey) {
    throw new Error(
      "LUNAAR_API_KEY env var is required. Get one from https://platform.lunaarvision.com → API Keys."
    );
  }

  const loaded = await loadManifest();
  process.stderr.write(
    `[lunaar-mcp] manifest source=${loaded.source} fetchedAt=${loaded.fetchedAt} tools=${loaded.manifest.tools.length}\n`
  );

  const server = new Server(
    { name: "lunaar", version: process.env.npm_package_version ?? "0.2.0" },
    {
      capabilities: { tools: {} },
      instructions:
        `Lunaar Public API tools, manifest source: ${loaded.source} ` +
        `(fetchedAt: ${loaded.fetchedAt}). ${loaded.manifest.tools.length} tools available.`,
    }
  );

  registerManifest(server, loaded.manifest, {
    apiKey,
    baseUrl: loaded.manifest.baseUrl,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Stderr (not stdout) — stdout is reserved for the JSON-RPC channel.
  console.error("[lunaar-mcp-server] fatal error:", err);
  process.exit(1);
});
