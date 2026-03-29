---
epic: Agent Integration
feature: Command-Line Interface
---

## Purpose

Defines the CLI entry point with subcommands: `serve` (MCP server), `watch` (email monitor), `configure`/`setup` (setup wizard), and `status` (account health). Includes TTY-aware default behavior, interactive wizard with provider picker, and config persistence at `~/.agent-email/config.json`. Includes NemoClaw-specific setup variant for egress policy bootstrap.

### Requirement: TTY-Aware Default Behavior

The system SHALL detect whether it is running in a TTY and adjust default behavior accordingly when invoked with no subcommand.

#### Scenario: No args in non-TTY defaults to serve
- **WHEN** `agent-email` is run with no arguments in a non-TTY context (e.g., piped from an MCP client)
- **THEN** the system behaves as if `serve` was specified and starts the MCP server on stdio

#### Scenario: No args in TTY without config starts setup wizard
- **WHEN** `agent-email` is run with no arguments in a TTY
- **AND** no configuration exists at `~/.agent-email/config.json`
- **THEN** the system launches the interactive setup wizard

#### Scenario: No args in TTY with config shows interactive menu
- **WHEN** `agent-email` is run with no arguments in a TTY
- **AND** a valid configuration exists at `~/.agent-email/config.json`
- **THEN** the system shows an interactive menu with options (serve, watch, status, configure)

### Requirement: Serve Subcommand

The system SHALL provide a `serve` subcommand that starts the MCP server on stdio transport.

#### Scenario: Start MCP server
- **WHEN** `npx @usejunior/agent-email serve` is run
- **THEN** the MCP server starts on stdio and lists all 15 email tools

### Requirement: Watch Subcommand

The system SHALL provide a `watch` subcommand that monitors all configured mailboxes for new emails and POSTs to a configurable wake URL.

#### Scenario: Watch with wake URL
- **WHEN** `agent-email watch --wake-url http://localhost:18789/hooks/wake` is run
- **THEN** the watcher monitors all mailboxes and sends authenticated wake POSTs on new email

### Requirement: Configure Subcommand

The system SHALL provide a `configure` subcommand (aliased as `setup`) with an interactive setup wizard: provider picker, credentials entry, connection test, and config persistence.

#### Scenario: Interactive setup
- **WHEN** `agent-email configure` is run
- **THEN** the system launches the interactive wizard with a provider picker (Outlook, Gmail coming soon) and tests the connection

#### Scenario: Setup alias
- **WHEN** `agent-email setup` is run
- **THEN** the system behaves identically to `agent-email configure`

### Requirement: Interactive Wizard

The interactive wizard SHALL guide the user through provider selection, credential entry, and connection verification. It uses a provider picker presenting available options.

#### Scenario: Provider picker shows available providers
- **WHEN** the interactive wizard starts
- **THEN** it presents a provider picker with "Outlook" as available and "Gmail (coming soon)" as disabled

#### Scenario: Wizard persists config on success
- **WHEN** the wizard completes successfully (credentials validated, connection tested)
- **THEN** it writes the configuration to `~/.agent-email/config.json`
- **AND** the configured email address is auto-added to the send allowlist

### Requirement: Status Subcommand

The system SHALL provide a `status` subcommand showing account health, token age, and allowlist summary.

#### Scenario: Status output
- **WHEN** `agent-email status` is run
- **THEN** the system displays the configured account email, token age/validity, send allowlist entries, and receive allowlist entries

#### Scenario: Status with no config
- **WHEN** `agent-email status` is run with no configuration
- **THEN** the system prints a message indicating no accounts are configured and suggests running `agent-email setup`

### Requirement: Config Persistence

The system SHALL persist CLI configuration at `~/.agent-email/config.json` including wakeUrl, hooksToken, and pollIntervalSeconds.

#### Scenario: Config file written
- **WHEN** the user completes setup
- **THEN** `~/.agent-email/config.json` contains the provider, account email, wakeUrl, hooksToken, and pollIntervalSeconds

#### Scenario: Config file read on startup
- **WHEN** any subcommand is run
- **THEN** the system reads `~/.agent-email/config.json` for default values (overridable by CLI flags and env vars)

### Requirement: NemoClaw Setup

The system SHALL provide a `configure --nemoclaw` variant that bootstraps egress policy for required domains and runs a preflight connectivity check.

#### Scenario: NemoClaw bootstrap
- **WHEN** `agent-email configure --nemoclaw` is run
- **THEN** the system adds `graph.microsoft.com`, `login.microsoftonline.com`, `gmail.googleapis.com`, `oauth2.googleapis.com` to the sandbox egress policy
- **AND** tests connectivity to each domain before proceeding

### Requirement: Version and Help

The system SHALL provide `--version` and `--help` flags with diagnostic output.

#### Scenario: Version output
- **WHEN** `agent-email --version` is run
- **THEN** the system prints the package version

### Requirement: Exit Codes

The system SHALL use standard exit codes: 0 for success, 1 for errors, 2 for usage errors.

#### Scenario: Configuration error
- **WHEN** `agent-email serve` fails due to missing configuration
- **THEN** the process exits with code 1 and a clear error message on stderr
