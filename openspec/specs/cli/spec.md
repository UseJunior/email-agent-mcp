---
epic: Agent Integration
feature: Command-Line Interface
---

## Purpose

Defines the CLI entry point with subcommands: `serve` (MCP server), `watch` (email monitor), and `configure` (setup wizard). Includes NemoClaw-specific setup variant for egress policy bootstrap.

### Requirement: Serve Subcommand

The system SHALL provide a `serve` subcommand that starts the MCP server on stdio transport.

#### Scenario: Start MCP server
- **WHEN** `npx @usejunior/agent-email serve` is run
- **THEN** the MCP server starts on stdio and lists all 14 email tools

### Requirement: Watch Subcommand

The system SHALL provide a `watch` subcommand that monitors all configured mailboxes for new emails and POSTs to a configurable wake URL.

#### Scenario: Watch with wake URL
- **WHEN** `agent-email watch --wake-url http://localhost:18789/hooks/wake` is run
- **THEN** the watcher monitors all mailboxes and sends authenticated wake POSTs on new email

### Requirement: Configure Subcommand

The system SHALL provide a `configure` subcommand with an interactive setup wizard: select provider, enter credentials, test connection, set default.

#### Scenario: Interactive setup
- **WHEN** `agent-email configure` is run
- **THEN** the system prompts for provider (microsoft/gmail), credentials, and tests the connection

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
