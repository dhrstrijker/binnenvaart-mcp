# Testing and guardrails

## Decision

- **Vitest** runs the suite (the only test-time dependency).
- **Behaviour tests via a mocked `fetch`.** Tests stub `globalThis.fetch` to return recorded or synthetic EuRIS payloads, then assert the `SourceResult` (data + `datagat` codes) that the public source functions return. This exercises the real pipeline — fetch → normalize → datagaten — without the network and without exporting internals.
- **Recorded fixtures** (`test/fixtures/`): trimmed, verbatim real EuRIS responses, so the parsers are regression-locked against the actual API shapes.
- **Server-boot test** over an in-memory MCP transport asserts all five tools register and list.
- **Handler safety-net** (`guarded`, `src/tools/result.ts`): any unexpected throw inside a tool becomes a blocking `datagat`, never a transport crash.
- **Static guardrails:** `tsc --strict` + `noUncheckedIndexedAccess`; ESLint (typescript-eslint `recommended` + the type-aware `no-floating-promises`); Prettier. `npm run typecheck` covers `src`, `test`, and the Vercel function in `api/`.
- **CI** (GitHub Actions) runs `format:check → lint → typecheck → test → build` on Node 20 and 22 for every push and PR.

## Considered Alternatives

- **Node's built-in `node:test`** (zero dependency, ethos-aligned with ADR-0003). Viable, but Vitest's watch mode, fixtures and matchers won out; one dev dependency is acceptable for the DX.
- **Testing the compiled `dist`.** Tests the shipped artifact but loses fast TS feedback; Vitest resolves the NodeNext `.js` import specifiers to the `.ts` source directly, so testing source is friction-free.
- **ESLint `recommendedTypeChecked`.** Powerful, but noisy against this codebase's intentionally `unknown`-typed JSON parsing (a `no-unsafe-*` avalanche). We took `recommended` plus the one type-aware rule that genuinely prevents bugs here — `no-floating-promises`.
- **Exporting internal helpers to unit-test them in isolation.** Rejected: behaviour tests through the public API are less brittle to refactors and document real behaviour.

## Consequences

- The honesty-layer gaps found in review (ADR-0004; unknown-age / missing-datum / missing-unit; pickBest tier-crossing) are regression-locked — a test fails if any of them silently regresses.
- The suite is deterministic and offline; CI never depends on EuRIS being reachable.
- New tools follow one shape: a source function returning a `SourceResult`, a `guarded` registration, and mocked-fetch behaviour tests — with a fixture when a new EuRIS endpoint is involved.
- Dev tooling needs Node ≥ 20.19 (ESLint/Vitest); the shipped server still runs on Node ≥ 20.
