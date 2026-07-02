# binnenvaart-mcp

**Official inland-shipping data — water levels, routes, locks, bridges, and notices to skippers — as callable tools for any MCP-capable LLM. Open data, no API key.**

`binnenvaart-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that brings live [EuRIS](https://www.eurisportal.eu) open data into Claude, Cursor, or any MCP-capable chat tool. Ask _"what's the water level at Kaub?"_ or _"plan a route from Nijmegen to Gorinchem for a ship with 3.50 m draught"_ and get answers grounded in the official European River Information Services — across the Netherlands, Belgium, the German Rhine and France.

> **Who this is for.** This is **developer infrastructure, not a consumer app.** Using it means adding an MCP server to a tool like Claude Desktop or Cursor, or wiring it into something you build — a technical step today. A non-technical skipper won't (and shouldn't have to) add an MCP server to their phone; this repo is the open **data layer** for builders and the ecosystem. A skipper-facing product is a separate effort.

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
| `euris_waterinfo` | Any Hydrometeo grootheid for a place or fairway — water level (`WAL`), least sounded depth (`LSD` / minst gepeilde diepte), vertical clearance (`VER` / doorvaarthoogte) or discharge (`DIS` / afvoer) — with its unit and reference datum (or an honest gap when missing). |
| `euris_objectstatus` | Live operational status of a lock or bridge (open / closed / locking / out of service), with the timestamp it was last read — and a gap when the object has no telemetry or the reading is stale. |
| `euris_bedieningstijden` | Operating / service times of a lock or bridge for a day or the coming week (when it is and isn't operated). |
| `euris_zoek` | Resolves a place or object name to ISRS codes — locks, bridges, berths, reporting points — so the model can pin an exact start/end and ask which one you mean. |
| `euris_route` | A voyage between two points for your ship's dimensions: distance, sailing time, the locks and bridges en route, tide-dependence, and fastest/shortest alternatives — honouring operating hours, tides and active notices. |
| `tide_departure_window` | Non-binding departure-window assessment for the focused tide/current question: broad planning anchors like Europoort, Rotterdam, Amsterdam, Antwerp, Harlingen or Terschelling; draft + margin; route/depth evidence where available; and explicit blockers when official current direction/speed, high-water extrema or depth basis is missing. Returns `verdict`, `summary`, `route_assumptions`, `candidate_windows`, `current_assessment`, `depth_assessment`, `sources`, `bronregels` and `datagaten`. |
| `euris_berichten` | Current Notices to Skippers (closures, cautions, works) for a fairway and/or country. |
| `euris_objectberichten` | Notices to Skippers tied to one specific object (lock, bridge, reporting point) — active and upcoming only. |
| `euris_routeimpact` | Active NtS impacts geo-anchored to objects (points) and stretches (lines) on a fairway and/or in a country, each with its impact type and any limit value. |
| `euris_ligplaatsen` | Berths / mooring places by name, with the waterway, bank, occupancy band and whether dangerous goods (ADN) are allowed. |
| `euris_brug` | Registered bridge dimensions — clearance width and height with its datum (for live clearance use `euris_waterinfo`; for open/closed use `euris_objectstatus`). |
| `euris_haveninfo` | Port or terminal facility info — waterway, function, and for terminals the cargo types, transhipment and whether bunker fuel is available. |

The tools speak Dutch (the skipper's language); the model translates as needed.

## Use it

> **Reality check.** Adding an MCP server is a developer step. For the **hosted** endpoint, most chat tools require a **paid plan**, you set it up in the **web/desktop app (not on mobile)**, and ChatGPT additionally needs **Developer Mode** enabled.

### Hosted — HTTP

Add this remote MCP server to a client that supports custom / remote connectors (Streamable HTTP):

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

### Local — stdio (developers)

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

`tide_departure_window` also returns a structured non-binding `verdict` because departure-window questions need one backend status for the client to explain. It still stays source-grounded: water level is not compared directly with draft, and missing current direction/current speed is a blocker rather than an estimate.

## Data source & attribution

All data comes from **[EuRIS](https://www.eurisportal.eu)** (European River Information Services) open-data APIs — Hydrometeo (water levels), the RIS Index (objects), RouteCalculatorV2 (voyages) and Notices to Skippers. Per EuRIS's terms, the data is **incorporated from EuRIS (eurisportal.eu), Copyright © EuRIS**. This project is independent — **not affiliated with or endorsed by EuRIS** — and reads only their public open data (no GDPR-protected personal data).

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
