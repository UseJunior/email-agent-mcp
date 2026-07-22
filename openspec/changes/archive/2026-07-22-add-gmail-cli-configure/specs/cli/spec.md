## MODIFIED Requirements

### Requirement: Configure Subcommand

The system SHALL provide a `configure` subcommand (aliased as `setup`) with an interactive setup wizard: provider picker, credentials entry, connection test, and config persistence.

#### Scenario: Interactive setup
- **WHEN** `email-agent-mcp configure` is run
- **THEN** the system launches the interactive wizard with a provider picker for Outlook and Gmail and tests the selected connection

#### Scenario: Direct Gmail configure
- **WHEN** `email-agent-mcp configure --provider gmail` is run
- **THEN** the system starts the Gmail OAuth flow
- **AND** persists mailbox metadata after the callback completes successfully

#### Scenario: Setup alias
- **WHEN** `email-agent-mcp setup` is run
- **THEN** the system behaves identically to `email-agent-mcp configure`

### Requirement: Interactive Wizard

The interactive wizard SHALL guide the user through provider selection, credential entry, and connection verification. It uses a provider picker presenting available options.

#### Scenario: Provider picker shows available providers
- **WHEN** the interactive wizard starts
- **THEN** it presents a provider picker with both Outlook and Gmail as selectable providers

#### Scenario: Wizard persists config on success
- **WHEN** the wizard completes successfully (credentials validated, connection tested)
- **THEN** it writes the configuration to `~/.email-agent-mcp/config.json`
- **AND** the configured email address is auto-added to the send allowlist
