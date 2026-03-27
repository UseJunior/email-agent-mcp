# agent-email — Project Context

## Purpose

Open-source TypeScript monorepo providing portable email connectivity for AI agents. Exposes email operations via MCP (Model Context Protocol) for any MCP-compatible agent runtime — OpenClaw, Claude Code, Gemini CLI, Cursor, Goose, and more. Supports multi-mailbox (Microsoft Graph + Gmail simultaneously) with security-first defaults.

## Tech Stack

- TypeScript 5.4+ (ES2022 target, ESM with explicit `.js` import suffixes)
- npm workspaces monorepo (`packages/*`)
- `@modelcontextprotocol/sdk` — MCP server implementation (stdio transport)
- `@microsoft/microsoft-graph-client` + `@azure/identity` — Microsoft 365 email
- `@googleapis/gmail` — Gmail API (lightweight, ~1.1MB)
- `zod` v4 — Schema validation + built-in JSON Schema generation for MCP tools
- `vitest` — Testing with spec traceability
- Node.js >=20

## Architecture

**Action-Centric Design** — all business logic lives in `email-core`:
- `email-core`: Actions (14 operations), content engine, security (allowlists), provider interface. Zero heavy dependencies.
- `provider-microsoft`: Microsoft Graph API implementation. Heavy deps isolated here.
- `provider-gmail`: Gmail API implementation. Heavy deps isolated here.
- `email-mcp`: MCP server — thin transport adapter (~100 lines) mapping action registry to MCP tools.
- `agent-email`: Distribution wrapper. `npx @usejunior/agent-email serve`.

Adding a new email operation = add one file in `email-core/src/actions/`. It auto-exposes via MCP.

## Code Style

- ESM modules with explicit `.js` suffixes in imports
- Strict TypeScript (`noUnusedLocals`, `noUncheckedIndexedAccess`)
- `snake_case` for MCP tool/action names (e.g., `list_emails`, `reply_to_email`)
- `PascalCase` for types/interfaces (e.g., `EmailMessage`, `EmailProvider`)
- Zod schemas as single source of truth for tool input validation
- No transforms/effects in Zod schemas at tool boundaries (not JSON-Schema-representable)

## Security Defaults

- **Send allowlist**: gates ALL outbound (sends AND replies). Default: EMPTY (blocks all). User must explicitly configure.
- **Receive allowlist**: controls watcher triggers. Default: accept all inbound.
- **Delete**: disabled by default. Requires explicit config + `user_explicitly_requested_deletion: true`.
- **Allowlists**: loaded at startup from config file. No MCP tool to modify them. Agent cannot change its own permissions.
- **Error sanitization**: never expose file paths, API keys, or stack traces in MCP responses.
- **body_file**: restricted to agent's working directory. No path traversal, no symlink escape.

## Multi-Mailbox

All actions accept an optional `mailbox` parameter. Write actions (send, reply) REQUIRE it when >1 mailbox is configured. Read actions default to the default mailbox. One mailbox auto-becomes default.

## Logging

MUST log to stderr, NEVER stdout (stdout is the MCP stdio transport).

## Testing

- Vitest with spec traceability
- Mock provider APIs for unit tests
- MCP SDK test client for integration tests
