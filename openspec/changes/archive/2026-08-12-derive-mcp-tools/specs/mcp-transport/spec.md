## MODIFIED Requirements

### Requirement: Action to Tool Mapping

The system SHALL derive MCP tools by iterating `EMAIL_ACTIONS` and generating an MCP tool for every action using Zod v4's built-in JSON Schema generation for input schemas. A tool may be explicitly overridden when the MCP server requires state-aware behavior, or explicitly excluded when it is a credential-management action unsuitable for agent-facing MCP access.

#### Scenario: Auto-registration
- **WHEN** a new action is added to `EMAIL_ACTIONS` in email-core
- **THEN** it automatically appears as an MCP tool in the `tools/list` response unless it is explicitly overridden or excluded

#### Scenario: Registry parity
- **WHEN** the full-scope MCP tool list is built
- **THEN** every canonical action is represented by exactly one derived tool, explicit override, or explicit exclusion
