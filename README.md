# binnenvaart-mcp

**Official inland-shipping data — water levels, routes, locks, bridges, and notices to skippers — in any LLM chat tool. Open data, no API key.**

`binnenvaart-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that brings live [EuRIS](https://www.eurisportal.eu) open data into Claude, Cursor, or any MCP-capable chat tool. Ask _"what's the water level at Kaub?"_ or _"plan a route from Nijmegen to Gorinchem for a ship with 3.50 m draught"_ and get answers grounded in the official European River Information Services — across the Netherlands, Belgium, the German Rhine and France.

It runs two ways: as a **hosted URL** you add to your chat tool (nothing to install), or **locally over stdio** for developers.

## Why this exists

As a captain I want ChatGPT to answer the typical questions you have when sailing, like: 
- I heard lock Evergem is partly closed, is this true?
- Are there any other issues on my route to Duinkerke?
- When is it high tide in Dordrecht?
- How long is a trip from Duinkerke to Lochem?
- What is the minimal draft on the Ijssel?

To answer these questions correctly the LLM needs the correct data, which it gets from [EuRIS](https://www.eurisportal.eu) via this MCP.

## What it does

| Tool | Returns |
| --- | --- |
| `waterstand` | Current water level for a place or fairway (EuRIS Hydrometeo `WAL`), always named against its reference datum (NAP / TAW / ZPG). |
| `euris_zoek` | Resolves a place or object name to ISRS codes — locks, bridges, berths, reporting points — so the model can pin an exact start/end and ask which one you mean. |
| `euris_route` | A voyage between two points for your ship's dimensions: distance, sailing time, the locks and bridges en route, tide-dependence, and fastest/shortest alternatives — honouring operating hours, tides and active notices. |
| `euris_berichten` | Current Notices to Skippers (closures, cautions, works) for a fairway and/or country. |

The tools speak Dutch (the skipper's language); the model translates as needed.

## Use it

### Hosted — no install

Add this remote MCP server to a client that supports custom/remote connectors (Streamable HTTP):

```
https://binnenvaart-mcp.vercel.app/api/mcp
```

For clients configured by file, that's roughly:

```json
{
  "mcpServers": {
    "binnenvaart": { "url": "https://binnenvaart-mcp.vercel.app/api/mcp" }
  }
}
```

Open data — no key required.

### Local — stdio

```bash
git clone https://github.com/dhrstrijker/binnenvaart-mcp.git
cd binnenvaart-mcp
npm install        # builds automatically
```

Then point your MCP client at the built entrypoint. For Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "binnenvaart": {
      "command": "node",
      "args": ["/absolute/path/to/binnenvaart-mcp/dist/stdio.js"]
    }
  }
}
```

(stdout carries only the protocol; logs go to stderr.)

## How it answers: data, not advice

Every tool returns **normalized data plus its provenance and its gaps**, never a finished verdict:

- `bronregels` — where each value came from (which EuRIS service, observed when), so the model can cite it;
- `datagaten` — honest "this is missing / stale / ambiguous" markers instead of an invented number.

A water level is always reported **against its datum** — a datum is not a live level. A route makes clear it was computed **for the dimensions you gave** (and says so when you gave none). This is source data to reason with — **not binding nautical advice.** The skipper and the official sources decide.

See [`docs/adr/`](docs/adr) for the decisions behind this (notably ADR-0004, _tools return data primitives_).

## Data source & attribution

All data comes from **[EuRIS](https://www.eurisportal.eu)** (European River Information Services) open-data endpoints — Hydrometeo (water levels), the RIS Index (objects), RouteCalculatorV2 (voyages) and Notices to Skippers. This project is not affiliated with or endorsed by EuRIS; it simply reads their public open data.

## Develop

```bash
npm test            # Vitest — offline, mocked fetch, deterministic
npm run typecheck   # tsc --strict (covers src, tests and the Vercel function)
npm run lint        # ESLint + Prettier checks
npm run dev:http    # local HTTP server at /api/mcp
```

CI (GitHub Actions) runs format, lint, typecheck, tests and build on Node 20 & 22 for every push and PR.

## License

[MIT](LICENSE) © Dylan Strijker
