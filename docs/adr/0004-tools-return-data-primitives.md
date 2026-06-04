# Tools return data primitives, not answers

An MCP tool could either return a finished, human-facing answer, or return raw, normalized **data** and let the client's model compose the answer.

## Decision

Every tool returns **data only**: a normalized result plus **provenance** (a source line — `bronregel`) and honest **data-gaps** (`datagat`) in one envelope (`SourceResult`). No pre-computed verdicts, no skipper-facing prose inside tool output. The client's LLM reasons over the primitives. Any tool that surfaces a measurement always names its **reference datum** (NAP / TAW / …), because a datum is not a current water level.

## Considered Alternatives

- **Return finished answers / advice.** Rejected: it bakes our judgement into the data, hides sources, and fights the agentic model that is actually holding the conversation. It also drifts toward giving binding nautical advice, which we must not do.

## Consequences

- Transparent and citeable: the model can show where every number came from and admit when data is missing.
- Composable: new questions are answered by the model combining primitives, not by us adding bespoke calculators.
- Tool **descriptions** carry the behavioural guidance (they are the model's instructions) and stay data-focused.
