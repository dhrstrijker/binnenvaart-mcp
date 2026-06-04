# EuRIS notices (NtS): server-side OData filtering + fairway disambiguation

## Decision

- Use the consolidated OData list endpoint **`GET /api/v3/nts`** for notices, filtering **server-side** on `fairways`, `countryCode` and validity.
- **Active by default.** Always constrain `dateEnd ge <today>T00:00:00Z`. The filter value must be a *full datetime literal* — a bare date (`dateEnd ge 2026-06-04`) returns HTTP 500, and only the documented filterable fields work at all (`title`, for instance, is not filterable). `eq` is case-insensitive.
- **Fairway disambiguation in the conversation.** Fairway names are exact and obscure (the Rhine is `Boven-Rijn` / `Waal` / … , not "Rijn"). On a miss we consult **`/api/v3/nts/filters/FAIRWAY`** (fetched once, cached) and return candidate names in a datagat — the same "return candidates, let the LLM ask" pattern as routing (ADR-0005).
- **Minimal normalized output** per notice: Dutch title (from `multilanguageTitles`), fairways, type, limitation codes, validity dates, number, organisation, country. Capped at 25, with the true total reported.

## Considered Alternatives

- **ArcGIS spatial feature services** (envelope / geometry queries). Powerful — query notices intersecting a map rectangle — but heavy: web-mercator envelopes, geometry handling, a different response shape. Overkill for "notices on a fairway." Deferred.
- **`/api/v3/nts/objects/{isrs}`** (per-object notices). Useful, and a natural pairing with `euris_zoek` (resolve an object → its notices). Deferred to a later iteration to keep the tool surface small.
- **Client-side filtering over a recent window** (the first cut, before the docs arrived). Fragile: the page cap is 100, and ordering by "most recently issued" buries long-running structural notices — e.g. a 2025-01 open-ended clearance-height limit on the Waal that is still in force. Rejected the moment server-side validity filtering proved to work (with the datetime literal).
- **Translating limitation codes** via `/filters/LIMITATION` (`obstru` → "blockage"). The human-readable title already describes the limitation, so codes are returned raw for now. Can be layered on later.

## Consequences

- Notices are filtered precisely and cheaply at the source: no missed long-running notices, no "only the most recent N were scanned" caveat.
- Two real EuRIS quirks are encapsulated here and documented: the **datetime-literal** requirement for date filters, and the **exact-fairway** constraint (handled by catalogue-backed suggestions).
- Route-specific closures remain the job of `euris_route` — EuRIS computes `Blocked` notices along the actual path. `euris_berichten` is the area / fairway browse, not a route check.
- The fairway catalogue (661 names) is cached per process; a cold serverless invocation pays one extra request only when a fairway lookup misses.
