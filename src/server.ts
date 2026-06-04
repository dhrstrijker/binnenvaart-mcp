import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/registry.js";

export const SERVER_INFO = { name: "binnenvaart-mcp", version: "0.1.0" } as const;

/**
 * Build the MCP server with every tool registered.
 *
 * Transport-agnostic on purpose: the local entrypoint (stdio.ts) and the hosted
 * entrypoint (api/mcp.ts → httpHandler.ts) both call this, so both expose the
 * exact same tools. See docs/adr/0003-stack-mcp-sdk-two-transports-vercel.md.
 */
export function createServer(): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerTools(server);
  return server;
}
