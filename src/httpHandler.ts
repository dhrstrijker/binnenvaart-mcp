import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

/**
 * Handle one MCP request over HTTP, statelessly.
 *
 * Serverless functions are ephemeral, so we make a fresh server + transport per
 * request (`sessionIdGenerator: undefined`) and answer with plain JSON
 * (`enableJsonResponse`) instead of an SSE stream — the simplest thing that
 * works for read-only tools. Both the Vercel function (api/mcp.ts) and the local
 * dev server (httpDev.ts) funnel through here, so local == hosted.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
): Promise<void> {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}
