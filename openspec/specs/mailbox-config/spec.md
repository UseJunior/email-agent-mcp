---
epic: Configuration
feature: Mailbox Management
---

## Purpose

Defines multi-mailbox configuration: connecting named mailboxes to providers, setting defaults, listing status, and provider discovery via dynamic import. Supports simultaneous Graph + Gmail connections. Each mailbox is canonically identified by its email address, with an optional user-defined alias for convenience.

### Requirement: Mailbox Canonical Identity

The canonical ID of a mailbox SHALL be its email address (e.g., `test-user@example.com`). The user MAY provide an optional alias (e.g., "work") for convenience. Tool inputs that accept a mailbox identifier SHALL accept either the email address or the alias, resolving to the same mailbox.

#### Scenario: Identify mailbox by email address
- **WHEN** a tool input specifies `mailbox: "test-user@example.com"`
- **THEN** the system resolves it to the mailbox configured with that email address

#### Scenario: Identify mailbox by alias
- **WHEN** a tool input specifies `mailbox: "work"` and the alias "work" maps to `test-user@example.com`
- **THEN** the system resolves it to the mailbox configured with email `test-user@example.com`

#### Scenario: Ambiguous identifier rejected
- **WHEN** a tool input specifies a string that matches neither a configured email address nor an alias
- **THEN** the system returns an error listing available mailboxes

### Requirement: Filesystem-Safe Storage Key

Mailbox metadata files SHALL be stored using a filesystem-safe derived key from the email address: lowercase, with all non-alphanumeric characters replaced by `-`. The raw email address SHALL be stored inside the JSON metadata, not in the filename.

#### Scenario: Derived filename from email
- **WHEN** a mailbox is configured for `test-user@example.com`
- **THEN** the metadata file is stored as `test-user-example-com.json`
- **AND** the JSON content includes `"emailAddress": "test-user@example.com"`

#### Scenario: Filename avoids special characters
- **WHEN** a mailbox is configured for `Alice.O'Brien+tag@corp.co.uk`
- **THEN** the metadata file is stored as `alice-o-brien-tag-corp-co-uk.json`

### Requirement: Configure Mailbox

The system SHALL provide a `configure_mailbox` action that connects a named mailbox to a provider with credentials. The resulting metadata SHALL include the `emailAddress` field fetched from the provider during configuration.

#### Scenario: Add work mailbox
- **WHEN** `configure_mailbox` is called with `{name: "work", provider: "microsoft", credentials: {...}, default: true}`
- **THEN** the system connects to the Microsoft Graph API, fetches the email address, and marks "work" as the default mailbox
- **AND** the stored metadata includes `emailAddress`

### Requirement: Default Mailbox

One mailbox SHALL be marked as default. If only one is configured, it is default automatically. If multiple are configured, the user sets the default via the `default: true` flag.

#### Scenario: Single mailbox auto-default
- **WHEN** only one mailbox ("personal") is configured
- **THEN** "personal" is automatically the default for all actions

### Requirement: Remove Mailbox

The system SHALL provide a `remove_mailbox` action that disconnects a named mailbox.

#### Scenario: Remove old account
- **WHEN** `remove_mailbox` is called with `{name: "old-account"}`
- **THEN** the system disconnects and removes the mailbox configuration

### Requirement: List Mailboxes

The system SHALL provide a `list_mailboxes` action that returns all configured mailboxes with their status, including the `emailAddress` field.

#### Scenario: List all mailboxes
- **WHEN** `list_mailboxes` is called
- **THEN** the system returns `[{name: "work", emailAddress: "test-user@example.com", provider: "microsoft", isDefault: true, status: "connected"}, ...]`

### Requirement: Mailbox Status

The system SHALL provide a `get_mailbox_status` action returning connection state, unread count, provider type, subscription status, `emailAddress`, and warnings (e.g., "outbound disabled — no send allowlist configured").

#### Scenario: Status with warning
- **WHEN** `get_mailbox_status` is called and no send allowlist is configured
- **THEN** the result includes `emailAddress` and `warnings: ["Outbound email disabled — configure send allowlist to enable replies and sends"]`

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

### Requirement: Provider Discovery

The system SHALL detect installed provider packages (`@usejunior/provider-microsoft`, `@usejunior/provider-gmail`) via dynamic import and suggest installation if a requested provider is missing.

#### Scenario: Provider not installed
- **WHEN** `configure_mailbox` is called with `{provider: "gmail"}` but `@usejunior/provider-gmail` is not installed
- **THEN** the system returns: "Provider 'gmail' not available. Install: npm install @usejunior/provider-gmail"
