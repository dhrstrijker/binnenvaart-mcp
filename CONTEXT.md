# binnenvaart-mcp — Context

## What this is

An open, public **Model Context Protocol (MCP)** server that brings official **EuRIS** inland-shipping data — water levels, routes, locks, bridges, and notices to skippers — into any LLM chat tool (Claude Desktop, ChatGPT, Cursor, …). It runs locally over **stdio** and is hosted over **HTTP** so anyone can add it by URL..

## Scope

- **In:** open EuRIS data exposed as MCP tools (water level, object search, routing, notices), runnable locally and hosted.
- **Out:** personal / vessel data — owned & followed AIS tracks and voyages. Those require EuRIS OAuth + the operator's consent. See `docs/adr/0001-open-data-only.md`.

## Domain glossary (ubiquitous language)

- **binnenvaart** — inland shipping / inland navigation.
- **vaarweg** — waterway (river or canal); **sluis** — lock; **brug** — bridge.
- **EuRIS** — European River Information Services; the corridor-wide portal and API.
- **RIS** — River Information Services. **NtS** — Notices to Skippers (stremmingen / closures; avis à la batellerie).
- **Hydrometeo** — EuRIS's measurement family. Parameter codes: **WAL** = water level, **VER** = vertical clearance (doorvaarthoogte), **LSD** = least sounded depth (minst gepeilde diepte), **DIS** = discharge (afvoer).
- **waterstand / pegel** — water level / gauge. **Reference datum** — the vertical reference a level is measured against (e.g. **NAP**, **TAW**); a datum is *not* the live level.
- **bronregel** — a source-attribution line carried with every result (what was read, from where, when).
- **datagat** — a data-gap marker: an explicit, honest "this is missing or stale" instead of a guess.
- **MCP** — Model Context Protocol. **tool** — a named function the AI may call. **transport** — how client and server exchange messages (**stdio** locally, **Streamable HTTP** when hosted). **host / client** — the chat tool; **server** — this process.
- **data primitive** — a tool that returns normalized data + provenance, not a finished answer.

## Invariants

- **Keyless by default.** The public server needs no per-user credentials (open data only).
- **Tools return data, not answers.** Provenance (`bronregel`) and gaps (`datagat`) travel with every result. Always name the reference datum. See `docs/adr/0004-tools-return-data-primitives.md`.
- **No binding nautical advice.** Provide source-backed data; the skipper and official sources decide.
- **stdio hygiene.** Over stdio, stdout carries only protocol messages; all logs go to stderr.
- **No secrets in the repo.** It is public; the hosted instance receives any optional token via environment variables.

## Decisions

Architectural decisions live in `docs/adr/`:

- `0001` — open-data-only scope; personal/AIS data is out of scope.
- `0002` — EuRIS as the single data source for v1.
- `0003` — stack: official MCP SDK, one server / two transports, hosted on Vercel via mcp-handler.
- `0004` — tools return data primitives, not answers.
