import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMcpRequest } from "../src/httpHandler.js";

/**
 * Vercel serverless function: the hosted MCP endpoint at /api/mcp.
 *
 * Vercel invokes this with Node's (req, res) and pre-parses a JSON body onto
 * req.body. All real logic lives in src/httpHandler.ts so local and hosted
 * behave identically. (This file is built by Vercel, not by our tsc.)
 */
export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  await handleMcpRequest(req, res, req.body);
}
