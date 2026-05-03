---
epic: Agent Integration
feature: Command-Line Interface
---

## Purpose

Defines the CLI entry point with subcommands: `serve` (MCP server), `watch` (email monitor), `configure`/`setup` (setup wizard), and `status` (account health). Includes TTY-aware default behavior, interactive wizard with provider picker, and config persistence at `~/.email-agent-mcp/config.json`. Includes NemoClaw-specific setup variant for egress policy bootstrap.

### Requirement: TTY-Aware Default Behavior

The system SHALL detect whether it is running in a TTY and adjust default behavior accordingly when invoked with no subcommand.

#### Scenario: No args in non-TTY defaults to serve
- **WHEN** `email-agent-mcp` is run with no arguments in a non-TTY context (e.g., piped from an MCP client)
- **THEN** the system behaves as if `serve` was specified and starts the MCP server on stdio

#### Scenario: No args in TTY without config starts setup wizard
- **WHEN** `email-agent-mcp` is run with no arguments in a TTY
- **AND** no configuration exists at `~/.email-agent-mcp/config.json`
- **THEN** the system launches the interactive setup wizard

#### Scenario: No args in TTY with config shows interactive menu
- **WHEN** `email-agent-mcp` is run with no arguments in a TTY
- **AND** a valid configuration exists at `~/.email-agent-mcp/config.json`
- **THEN** the system shows an interactive menu with options (serve, watch, status, configure)

### Requirement: Serve Subcommand

The system SHALL provide a `serve` subcommand that starts the MCP server on stdio transport.

#### Scenario: Start MCP server
- **WHEN** `npx email-agent-mcp serve` is run
- **THEN** the MCP server starts on stdio and lists all 15 email tools

### Requirement: Watch Subcommand

The system SHALL provide a `watch` subcommand that monitors all configured mailboxes for new emails and POSTs to a configurable wake URL.

#### Scenario: Watch with wake URL
- **WHEN** `email-agent-mcp watch --wake-url http://localhost:18789/hooks/wake` is run
- **THEN** the watcher monitors all mailboxes and sends authenticated wake POSTs on new email

### Requirement: Configure Subcommand

The system SHALL provide a `configure` subcommand (aliased as `setup`) with an interactive setup wizard: provider picker, credentials entry, connection test, and config persistence.

#### Scenario: Interactive setup
- **WHEN** `email-agent-mcp configure` is run
- **THEN** the system launches the interactive wizard with a provider picker (Outlook, Gmail coming soon) and tests the connection

#### Scenario: Setup alias
- **WHEN** `email-agent-mcp setup` is run
- **THEN** the system behaves identically to `email-agent-mcp configure`

### Requirement: Interactive Wizard

The interactive wizard SHALL guide the user through provider selection, credential entry, and connection verification. It uses a provider picker presenting available options.

#### Scenario: Provider picker shows available providers
- **WHEN** the interactive wizard starts
- **THEN** it presents a provider picker with "Outlook" as available and "Gmail (coming soon)" as disabled

#### Scenario: Wizard persists config on success
- **WHEN** the wizard completes successfully (credentials validated, connection tested)
- **THEN** it writes the configuration to `~/.email-agent-mcp/config.json`
- **AND** the configured email address is auto-added to the send allowlist

### Requirement: Status Subcommand

The system SHALL provide a `status` subcommand showing account health, token age, and allowlist summary.

#### Scenario: Status output
- **WHEN** `email-agent-mcp status` is run
- **THEN** the system displays the configured account email, token age/validity, send allowlist entries, and receive allowlist entries

#### Scenario: Status with no config
- **WHEN** `email-agent-mcp status` is run with no configuration
- **THEN** the system prints a message indicating no accounts are configured and suggests running `email-agent-mcp setup`

### Requirement: Config Persistence

The system SHALL persist CLI configuration at `~/.email-agent-mcp/config.json` including wakeUrl, hooksToken, and pollIntervalSeconds.

#### Scenario: Config file written
- **WHEN** the user completes setup
- **THEN** `~/.email-agent-mcp/config.json` contains the provider, account email, wakeUrl, hooksToken, and pollIntervalSeconds

#### Scenario: Config file read on startup
- **WHEN** any subcommand is run
- **THEN** the system reads `~/.email-agent-mcp/config.json` for default values (overridable by CLI flags and env vars)

### Requirement: NemoClaw Setup

The system SHALL provide a `configure --nemoclaw` variant that bootstraps egress policy for required domains and runs a preflight connectivity check.

#### Scenario: NemoClaw bootstrap
- **WHEN** `email-agent-mcp configure --nemoclaw` is run
- **THEN** the system adds `graph.microsoft.com`, `login.microsoftonline.com`, `gmail.googleapis.com`, `oauth2.googleapis.com` to the sandbox egress policy
- **AND** tests connectivity to each domain before proceeding

### Requirement: Version and Help

The system SHALL provide `--version` and `--help` flags with diagnostic output.

#### Scenario: Version output
- **WHEN** `email-agent-mcp --version` is run
- **THEN** the system prints the package version

### Requirement: Call Subcommand

The system SHALL provide a `call` subcommand that invokes a single MCP tool in a one-shot CLI process. Each invocation runs in a fresh process so source-code changes take effect without restarting any long-lived MCP host. Tool input may be supplied as inline JSON, a file path, or stdin.

#### Scenario: call invokes a tool with --args JSON and prints raw result to stdout
- **WHEN** `email-agent-mcp call <tool> --args '<json>'` is run
- **THEN** the system eagerly initializes the provider, dispatches to the tool via the same `executeTool` primitive used by `serve`, and prints the raw action result as JSON on stdout
- **AND** the result is NOT wrapped in any MCP transport envelope

#### Scenario: call --list enumerates available tools
- **WHEN** `email-agent-mcp call --list` is run
- **THEN** the system prints a JSON array of `{name, description, annotations}` for every registered tool

#### Scenario: call <tool> --schema prints input schema
- **WHEN** `email-agent-mcp call <tool> --schema` is run
- **THEN** the system prints the input JSON Schema for that tool (the same schema returned by MCP `tools/list`)

#### Scenario: call exits with 2 on invalid args / unknown tool
- **WHEN** `email-agent-mcp call` is invoked with an unknown tool name, malformed JSON args, or schema validation failure
- **THEN** the process exits with code 2 and writes a clear error message to stderr

#### Scenario: call exits with 3 on tool failure
- **WHEN** the dispatched tool throws or returns a typed failure object (`{ success: false, error: ... }`)
- **THEN** the process exits with code 3 (distinct from CLI/argument errors at code 2)

#### Scenario: call output is pretty-printed to TTY and compact when piped
- **WHEN** the result is written to stdout
- **AND** stdout is a TTY (human session)
- **THEN** the JSON is pretty-printed with 2-space indentation
- **WHEN** stdout is piped (not a TTY)
- **THEN** the JSON is emitted compactly so downstream tools like `jq` consume it cleanly

### Requirement: Exit Codes

The system SHALL use standard exit codes: 0 for success, 1 for runtime errors (e.g., serve startup failure), 2 for usage / invalid-argument errors, and 3 for `call` tool-failure results.

#### Scenario: Configuration error
- **WHEN** `email-agent-mcp serve` fails due to missing configuration
- **THEN** the process exits with code 1 and a clear error message on stderr
