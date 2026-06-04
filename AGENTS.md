# binnenvaart-mcp

Open MCP server that brings official **EuRIS** inland-shipping data (water levels, routes, locks, bridges, notices) into any LLM chat tool. TypeScript on `@modelcontextprotocol/sdk`; runs locally over stdio and hosted over HTTP.

## Agent skills

### Issue tracker

Issues live as GitHub issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily by `/grill-with-docs`). See `docs/agents/domain.md`.
