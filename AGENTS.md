# Agent Email — AI Agent Instructions

## OpenSpec Instructions

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

## Project Conventions

- TypeScript ESM with explicit `.js` import suffixes
- snake_case for MCP tool/action names, PascalCase for types/interfaces
- All email actions defined in `packages/email-core/src/actions/` — the single source of truth
- MCP server and CLI are thin adapters — never put business logic in transport layers
- Zod v4 schemas as single source of truth for tool input validation
- Tests: Vitest with spec traceability
- Logging: ALWAYS to stderr, NEVER stdout (corrupts MCP stdio transport)
