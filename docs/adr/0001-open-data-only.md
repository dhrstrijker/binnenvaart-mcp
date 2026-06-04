# Open, public, open-data-only — personal/AIS data is out of scope

`binnenvaart-mcp` is a public MCP server meant to be added by anyone — including non-technical skippers — to their favourite chat tool. That goal only works if the server needs **no per-user credentials**. We verified (against EuRIS's OpenAPI `security` blocks) that EuRIS authorization is **per endpoint**: infrastructure and environmental data (routing, locks, bridges, notices, hydrometeo, and even area AIS such as `tracks/bounding-box`) is free **open data** with no auth, while **personal** data — `tracks/owned`, `tracks/followed`, `voyages` — requires OAuth with the vessel operator's consent.

## Decision

This repo exposes **only open data** and stays **keyless by default**. Personal / vessel data (owned & followed AIS, voyages) is explicitly **out of scope**.

## Considered Alternatives

- **Per-user BYO-key in the MCP.** Unnecessary: the data this server needs is open, so no key is required at all — which is exactly what lets non-technical users add it.

## Consequences

- Anyone can add the server with no signup — the whole point.
- GDPR stays simple: no personal data flows through the public server.
- The genuinely valuable fleet / harbour-fee feature is deferred to a separate authenticated app (recorded here, not built here).
