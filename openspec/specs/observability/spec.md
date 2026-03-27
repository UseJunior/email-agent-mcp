---
epic: Infrastructure
feature: Observability & Logging
---

## Purpose

Defines logging, error reporting, optional telemetry, and metrics for the email MCP server. Critical constraint: MUST log to stderr, NEVER stdout (stdout is the MCP stdio transport — logging there corrupts the protocol). Includes error sanitization to prevent exposing internal paths, API keys, or stack traces in MCP tool responses.

### Requirement: Log Destination

The system SHALL log exclusively to stderr. Logging to stdout SHALL be treated as a critical bug.

#### Scenario: MCP mode logging
- **WHEN** running as an MCP server (stdio transport)
- **THEN** all logs go to stderr in structured JSON format

#### Scenario: CLI mode logging
- **WHEN** running `watch` or `configure` (not as MCP child process)
- **THEN** logs go to stderr in human-readable format

### Requirement: Structured Log Format

The system SHALL emit structured JSON logs with: timestamp, level, action, mailbox, duration_ms, error fields.

#### Scenario: Action log entry
- **WHEN** `list_emails` completes in 234ms
- **THEN** a log entry is emitted: `{"ts": "...", "level": "info", "action": "list_emails", "mailbox": "work", "duration_ms": 234}`

### Requirement: Log Levels

The system SHALL support configurable log levels via environment variable (`LOG_LEVEL`) or CLI flag: debug, info, warn, error.

#### Scenario: Debug level
- **WHEN** `LOG_LEVEL=debug` is set
- **THEN** provider API request/response bodies are logged

### Requirement: MCP Client Logging

The system SHALL use the MCP SDK's `server.sendLoggingMessage()` for messages that should be visible to the agent runtime.

#### Scenario: Allowlist warning
- **WHEN** outbound email is disabled (no send allowlist)
- **THEN** a warning is sent via `sendLoggingMessage()` so the agent can inform the user

### Requirement: Error Sanitization

The system SHALL NEVER expose internal file paths, API keys, credentials, or stack traces in MCP tool error responses. Full errors are logged to stderr; sanitized versions are returned to the agent.

#### Scenario: API key in error
- **WHEN** a provider error contains an API key
- **THEN** the MCP response contains `[REDACTED]` in place of the key
- **AND** the full error is logged to stderr for debugging

#### Scenario: File path in error
- **WHEN** an error message contains `/Users/stevenobiajulu/.config/credentials.json`
- **THEN** the MCP response contains `[PATH]` instead

### Requirement: Optional OpenTelemetry

The system SHALL support opt-in OpenTelemetry spans per action for tracing action execution, provider API calls, and content engine processing.

#### Scenario: OTel span
- **WHEN** OTel is enabled and `read_email` is called
- **THEN** a span is created with attributes: action name, mailbox, provider, duration, status

### Requirement: Metrics

The system SHALL track action counts, latency, and error rates, exposed via `get_mailbox_status` or a dedicated metrics action.

#### Scenario: Metrics in status
- **WHEN** `get_mailbox_status` is called
- **THEN** the response includes `{actions_total: 142, errors_total: 3, avg_latency_ms: 180}`
