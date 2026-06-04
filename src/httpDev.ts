import { createServer as createNodeHttpServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { handleMcpRequest } from "./httpHandler.js";

/**
 * A local Node HTTP server that serves the MCP endpoint at /api/mcp — for
 * testing and `npm run dev:http`. On Vercel we use api/mcp.ts instead; both
 * funnel into handleMcpRequest, so what you test locally is what ships.
 */
export function createDevHttpServer(): Server {
  return createNodeHttpServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/api/mcp" && path !== "/mcp") {
      res.statusCode = 404;
      res.end("Not found. Use POST /api/mcp");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = undefined;
        }
      }
      void handleMcpRequest(req, res, body);
    });
    req.on("error", () => {
      res.statusCode = 400;
      res.end();
    });
  });
}

// Run directly (`node dist/httpDev.js`) → start listening. Importing this file
// (e.g. from a test) does NOT auto-listen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createDevHttpServer().listen(port, () => {
    console.error(`[binnenvaart-mcp] HTTP dev server → http://localhost:${port}/api/mcp`);
  });
}
