#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * Local entrypoint. Speaks MCP over stdio (stdin/stdout) — this is the process
 * that Claude Desktop / Cursor launch and talk to as a child process.
 *
 * THE ONE RULE OF STDIO: stdout is the protocol channel. Never write anything
 * to stdout except MCP messages (the SDK handles those). Diagnostics go to
 * stderr via console.error, or the client's JSON parser chokes.
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[binnenvaart-mcp] stdio server ready");
}

main().catch((error) => {
  console.error("[binnenvaart-mcp] fatal:", error);
  process.exit(1);
});
