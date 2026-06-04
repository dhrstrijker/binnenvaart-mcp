# Stack: official MCP SDK, one server / two transports, hosted on Vercel

## Decision

- Build on **`@modelcontextprotocol/sdk`** (v1.29.x) using the high-level `McpServer` with **Zod** input schemas.
- Keep a single place that registers tools (`src/tools/registry.ts`), wrapped by a transport-agnostic `createServer()`, fed by two thin entrypoints: **`src/stdio.ts`** (`StdioServerTransport`, local) and **`api/mcp.ts`** (HTTP).
- For HTTP, use the SDK's own **`StreamableHTTPServerTransport`** in **stateless** mode (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) — a fresh server + transport per request, which suits ephemeral serverless functions. Deploy `api/mcp.ts` as a **Vercel** function. Keyless by default; an optional `EURIS_TOKEN` may be set on the hosted instance for rate-limit / good-citizen identification.

## Considered Alternatives

- **`mcp-handler`** (Vercel's MCP adapter — the path the original plan named). Rejected after inspection: it hard-pins `@modelcontextprotocol/sdk@1.26.0` (forcing us to *downgrade* the SDK) and pulls `redis` + `commander` as hard dependencies for SSE/session features our stateless, read-only server never uses. The SDK already ships `StreamableHTTPServerTransport`, so we get HTTP with **zero new dependencies**, keep the current SDK, and stay transparent. We can revisit `mcp-handler` if we ever want its built-in OAuth (`withMcpAuth`) or session handling.
- **Keep hand-rolling the protocol.** Good for learning (we did it once in a throwaway slice), wrong for a public repo: more to maintain, and we'd reimplement the transport the SDK already provides.
- **A long-running Node/Express host instead of Vercel serverless.** Heavier to operate; a Vercel function on the free tier is the lower-friction path.

## Consequences

- Tool schemas are Zod (typed, self-documenting); the SDK handles the handshake and both transports.
- HTTP hosting adds **no dependency** beyond the SDK; the local dev server (`src/httpDev.ts`) and the Vercel function (`api/mcp.ts`) share one `handleMcpRequest`, so local behaviour matches production.
- The hosted server is stateless serverless — fine for these read-only tools; real rate-limiting / auth can be layered on later.
- One set of tools, two ways to reach them: a developer install and a public URL.
