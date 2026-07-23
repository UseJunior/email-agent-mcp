## MODIFIED Requirements

### Requirement: Configure Subcommand

The system SHALL provide a `configure` subcommand (aliased as `setup`) with an
interactive setup wizard: provider picker, credentials entry, connection test,
and config persistence.

When `configure` or `setup` is run in a TTY without an explicit provider or
mailbox and more than one mailbox is already configured, the system SHALL
present a mailbox picker before authentication. The picker SHALL identify each
mailbox by email address, provider, saved alias, and last-authenticated date,
and SHALL offer an add-new-mailbox choice.

#### Scenario: Interactive setup
- **WHEN** `email-agent-mcp configure` is run
- **THEN** the system launches the interactive wizard with a provider picker for Outlook and Gmail and tests the selected connection

#### Scenario: Ambiguous configure presents saved mailboxes
- **WHEN** `email-agent-mcp configure` or `email-agent-mcp setup` is run in a TTY
- **AND** neither `--provider` nor `--mailbox` is supplied
- **AND** more than one mailbox is configured
- **THEN** the system presents a picker containing each mailbox's email address, provider, exact saved alias, and last-authenticated date
- **AND** the picker includes an option to add a new mailbox

#### Scenario: Existing mailbox selection preserves routing identity
- **WHEN** a user selects an existing mailbox from the configure picker
- **THEN** the system starts authentication with that mailbox's saved provider
- **AND** passes the exact saved mailbox alias rather than substituting its email address

#### Scenario: Add-new selection uses the setup wizard
- **WHEN** a user selects add new mailbox from the configure picker
- **THEN** the system launches the existing provider setup wizard

#### Scenario: Explicit configure intent bypasses the picker
- **WHEN** `configure` or `setup` is run with `--provider` or `--mailbox`
- **THEN** the system skips the mailbox picker
- **AND** runs the existing flag-driven configure behavior

#### Scenario: Automated and specialized configure flows bypass the picker
- **WHEN** `configure` or `setup` is run outside a TTY
- **OR** `configure --nemoclaw` is run
- **THEN** the system skips the mailbox picker
- **AND** runs the existing configure behavior

#### Scenario: Configure picker cancellation
- **WHEN** the user cancels the configure mailbox picker
- **THEN** the system exits successfully without starting authentication

#### Scenario: Direct Gmail configure (broker default)
- **WHEN** `email-agent-mcp configure --provider gmail` is run without `--client-id`, `--client-secret`, or Gmail BYOK env vars, and the mailbox has no prior saved metadata
- **THEN** the system contacts the OAuth broker (default `https://oauth.usejunior.com`, override via `--broker-url` or `AGENT_EMAIL_GMAIL_BROKER_URL`)
- **AND** registers a session at `POST /api/sessions` with a locally-generated `session_id` and the SHA-256 hash of a locally-generated `pickup_secret`
- **AND** opens the broker's authorization URL in the browser, polls `POST /api/tickets/claim` (presenting the raw `pickup_secret` for proof of ownership), and persists mailbox metadata with `source: 'broker'` once consent completes

#### Scenario: Broker URL must be https (or http loopback)
- **WHEN** `--broker-url` or `AGENT_EMAIL_GMAIL_BROKER_URL` is set to a non-https URL that is not `http://localhost`, `http://127.0.0.1`, or `http://[::1]`
- **THEN** the system refuses to use it and surfaces a configuration error

#### Scenario: Direct Gmail configure (BYOK)
- **WHEN** `email-agent-mcp configure --provider gmail` is run with both `--client-id` and `--client-secret` (or both `AGENT_EMAIL_GMAIL_CLIENT_ID` and `AGENT_EMAIL_GMAIL_CLIENT_SECRET`)
- **THEN** the system runs a local-loopback OAuth flow against Google directly using those credentials
- **AND** persists mailbox metadata with `source: 'byok'` containing the supplied client_id and client_secret

#### Scenario: Partial BYOK credentials are rejected
- **WHEN** `email-agent-mcp configure --provider gmail` is run with exactly one of `--client-id` or `--client-secret` (and the corresponding env var for the other half is unset)
- **THEN** the system exits non-zero with a message stating that BYOK requires both halves and that omitting both selects the broker

#### Scenario: Reconfigure preserves saved mode
- **WHEN** `email-agent-mcp configure --provider gmail --mailbox <existing>` is run for a mailbox that already has saved metadata
- **AND** no explicit `--client-id`/`--client-secret`/`--broker-url` flags or env vars are supplied
- **THEN** the system reuses the saved mode and credentials (broker URL or BYOK client_id/client_secret) rather than switching modes
- **AND** existing BYOK users on subsequent reconnects are not silently routed through the broker

#### Scenario: Setup alias
- **WHEN** `email-agent-mcp setup` is run
- **THEN** the system behaves identically to `email-agent-mcp configure`
