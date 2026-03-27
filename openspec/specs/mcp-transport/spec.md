---
epic: Agent Integration
feature: MCP Server Adapter
---

## Purpose

Defines the thin MCP transport adapter that maps the email-core action registry to MCP tools. Uses stdio transport. Auto-registers actions — adding a new action in email-core auto-exposes it as an MCP tool. The adapter is ~100 lines and contains no business logic.

### Requirement: Action to Tool Mapping

The system SHALL iterate the action registry and generate an MCP tool for each action, using Zod v4's built-in JSON Schema generation for input schemas.

#### Scenario: Auto-registration
- **WHEN** a new action is added to `EMAIL_ACTIONS` in email-core
- **THEN** it automatically appears as an MCP tool in the `tools/list` response

### Requirement: stdio Transport

The system SHALL use stdio transport (stdin/stdout) as the standard for OpenClaw, Claude Code, Gemini CLI, and other MCP clients.

#### Scenario: MCP handshake
- **WHEN** an MCP client connects via stdio
- **THEN** the server completes the MCP initialize handshake and lists all available tools

### Requirement: Zod Schema Constraints

The system SHALL NOT use Zod transforms, effects, or runtime checks at tool boundaries, as these are not representable in JSON Schema.

#### Scenario: Schema compatibility
- **WHEN** generating JSON Schema from Zod
- **THEN** all tool input schemas are valid JSON Schema objects with no custom extensions

### Requirement: Tool Annotations

Each tool SHALL include `readOnlyHint` and `destructiveHint` annotations matching the action's nature.

#### Scenario: Read action annotations
- **WHEN** `list_emails` tool is registered
- **THEN** it has `readOnlyHint: true, destructiveHint: false`

### Requirement: Server Discovery

The system SHALL provide a `server.json` manifest following the MCP server discovery specification for registry listing (Smithery, MCP Registry, MCPB).

#### Scenario: server.json content
- **WHEN** `server.json` is read
- **THEN** it contains name, version, description, and npm package transport configuration
