## MODIFIED Requirements

### Requirement: Configure Mailbox

The system SHALL provide a `configure_mailbox` action that connects a named mailbox to a provider with credentials. The resulting metadata SHALL include the `emailAddress` field fetched from the provider during configuration.

#### Scenario: Add work mailbox
- **WHEN** `configure_mailbox` is called with `{name: "work", provider: "microsoft", credentials: {...}, default: true}`
- **THEN** the system connects to the Microsoft Graph API, fetches the email address, and marks "work" as the default mailbox
- **AND** the stored metadata includes `emailAddress`

#### Scenario: Add Gmail mailbox
- **WHEN** `configure_mailbox` is called with `{name: "personal", provider: "gmail", credentials: {...}}`
- **THEN** the system completes the Gmail OAuth exchange, fetches the Gmail account email address, and persists Gmail mailbox metadata under `~/.email-agent-mcp/tokens/`
- **AND** the stored metadata includes `emailAddress`

### Requirement: Convention-Over-Configuration Paths

The system SHALL use `~/.email-agent-mcp/` as the default home directory (overridable via `EMAIL_AGENT_MCP_HOME` env var) with well-known subdirectories and files loaded by convention.

#### Scenario: Default home directory
- **WHEN** `EMAIL_AGENT_MCP_HOME` is not set
- **THEN** the system uses `~/.email-agent-mcp/` as the home directory

#### Scenario: Custom home directory via env var
- **WHEN** `EMAIL_AGENT_MCP_HOME` is set to `/tmp/ae-test`
- **THEN** the system uses `/tmp/ae-test/` as the home directory instead of `~/.email-agent-mcp/`

#### Scenario: Tokens directory for auth metadata
- **WHEN** the system stores authentication metadata (OAuth tokens, refresh tokens)
- **THEN** it writes to `~/.email-agent-mcp/tokens/`

#### Scenario: State directory for watcher state and locks
- **WHEN** the system stores watcher checkpoints or lock files
- **THEN** it writes to `~/.email-agent-mcp/state/`

#### Scenario: Config file for persistent settings
- **WHEN** the system reads or writes persistent configuration
- **THEN** it uses `~/.email-agent-mcp/config.json` containing wakeUrl, hooksToken, and pollIntervalSeconds

#### Scenario: Allowlist files loaded by convention
- **WHEN** the system checks send or receive allowlists
- **THEN** it loads `~/.email-agent-mcp/send-allowlist.json` and `~/.email-agent-mcp/receive-allowlist.json` by convention

#### Scenario: Auto-add email to send allowlist during configure
- **WHEN** a mailbox is successfully configured
- **THEN** the configured email address is automatically added to `send-allowlist.json`
