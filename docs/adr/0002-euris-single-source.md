# EuRIS as the single data source for v1

## Decision

v1 of `binnenvaart-mcp` uses **EuRIS only**. No separate WSV or RWS adapters. One adapter (`src/sources/euris.ts`) backs every tool.

## Considered Alternatives

- **Port all four sources** (as the reference app has). Rejected for v1: four adapters' worth of surface and upkeep for a public server whose first job is to exist and be understood. Premature.
- **RWS/WSV for their home regions, EuRIS elsewhere**. Rejected for v1: more complexity than the open MCP needs.

## Consequences

- One adapter to build, understand, and maintain; one auth model (keyless).
- **Risk:** EuRIS coverage or latency for a specific NL or German-Rhine station may be coarser than the national source. We validate this in M1 — confirm a live value for a German Rhine pegel (e.g. Kaub) and an NL station. If a needed station is ever missing or stale in EuRIS, add that national source then, not preemptively.

## Validation (M1, 2026-06-04)

Confirmed live and keyless: EuRIS Hydrometeo returns current water levels for the German Rhine (Kaub — 127 cm t.o.v. ZPG, provider "NtS WRM - WSV"), the Netherlands (Lobith 761 / Nijmegen / Tiel, t.o.v. NAP), and Belgium (Antwerpen tij/Zeeschelde — t.o.v. TAW). Units and datums vary by country (cm/ZPG, cm/NAP, m/TAW), so tools keep `value` + `unit` + `referenceLevel` raw rather than pre-formatting. Coverage is station-level, not every town (e.g. "Wijk bij Duurstede" returns nothing), which the `datagat` reports honestly. The single-source bet holds for v1.
