# EuRIS routing: voyage endpoint, caller-supplied dimensions, candidate disambiguation

## Decision

- **Use the EuRIS *voyage* calculation** (`POST /api/RouteCalculatorV2/Calculate`), not the bare route (`CalculateRoute`). The voyage honours lock/bridge operating hours, tidal windows and active Notices to Skippers, and returns travel time. `ComputationType: "BOTH"` yields the fastest and shortest itineraries as alternatives to pick from.
- **No default ship.** Ship dimensions (draught / height / width / length, in cm) are *optional caller inputs*. When omitted we send no `ShipDimensions` at all and emit a `euris-route-no-dimensions` datagat; the tool description tells the model to ask the skipper. Partial dimensions are sent as-is.
- **Disambiguation lives in the conversation, not the tool.** `euris_zoek` resolves a name to ISRS candidates (`RisIndices_v2`). `euris_route` accepts an ISRS *or* a name; on an ambiguous or unknown name it returns the candidates inside a datagat so the model asks a follow-up question rather than the tool guessing. ISRS detection is a strict pattern (`^[A-Z]{2}[A-Z0-9]{18}$`): match → trust, else → resolve.
- **Minimal output.** Per variant: distance, travel time, lock count, tide-dependence, permissible dimensions, and the locks + bridges along the way (from the structured V2 `Events`). Identical itineraries (EuRIS often returns FASTEST == SHORTEST) are deduped into one labelled variant.

## Considered Alternatives

- **The bare route endpoint.** Simpler, but time-blind — it ignores closures, operating hours and tides. Rejected: a "route" that sends a skipper through a closed lock or a too-low bridge window is wrong, not minimal.
- **Tool-side fuzzy name resolution** (the previous app's `nodeSearchVariants` token-fallback). Fragile and opaque; it guessed. Rejected in favour of returning candidates and letting the LLM ask the skipper.
- **A default ship profile** (the previous app hardcoded CEMT Va, 140 × 22.8 m, 4.0 m draught). Hides an unsafe assumption behind a confident answer. Rejected for an honest "no dimensions" datagat — the absence is surfaced, not papered over.
- **Returning EuRIS's full detail** (geometry, segments, the complete event timeline, via/avoid leg-combining, client-side variant synthesis). Over-built for v1; the chat model needs primitives, not a rendered trip. Dropped — can be re-added as separate tools if a real need appears.

## Consequences

- A correct passability check requires the skipper's draught and air-draught. The tool nudges for them and still answers when absent — but flags the answer as dimension-agnostic via a datagat, so the model never implies a passability guarantee it didn't compute.
- Alternatives are exactly what EuRIS returns (at most two), never synthesized — honest and cheap.
- EuRIS's own error model (`StartNotFound` / `EndNotFound` / `ShipDimensions` / `Blocked` / `NoRoute`) maps directly to actionable datagaten and powers the follow-up loop (e.g. *"too krap: Merwedekanaal, draught 280 cm"*, or *"start ambiguous — pick one of these ISRS codes"*).
- The strict ISRS pattern means a (non-existent) 20-character all-uppercase place name would be trusted as an ISRS and misroute. Acceptable: no such names exist in practice.
- `euris_route` depends on `euris_zoek` for name resolution; the two ship together and share the one EuRIS adapter.
