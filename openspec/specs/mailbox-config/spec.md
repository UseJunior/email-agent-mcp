---
epic: Configuration
feature: Mailbox Management
---

## Purpose

Defines multi-mailbox configuration: connecting named mailboxes to providers, setting defaults, listing status, and provider discovery via dynamic import. Supports simultaneous Graph + Gmail connections.

### Requirement: Configure Mailbox

The system SHALL provide a `configure_mailbox` action that connects a named mailbox to a provider with credentials.

#### Scenario: Add work mailbox
- **WHEN** `configure_mailbox` is called with `{name: "work", provider: "microsoft", credentials: {...}, default: true}`
- **THEN** the system connects to the Microsoft Graph API and marks "work" as the default mailbox

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

The system SHALL provide a `list_mailboxes` action that returns all configured mailboxes with their status.

#### Scenario: List all mailboxes
- **WHEN** `list_mailboxes` is called
- **THEN** the system returns `[{name: "work", provider: "microsoft", isDefault: true, status: "connected"}, ...]`

### Requirement: Mailbox Status

The system SHALL provide a `get_mailbox_status` action returning connection state, unread count, provider type, subscription status, and warnings (e.g., "outbound disabled — no send allowlist configured").

#### Scenario: Status with warning
- **WHEN** `get_mailbox_status` is called and no send allowlist is configured
- **THEN** the result includes `warnings: ["Outbound email disabled — configure send allowlist to enable replies and sends"]`

### Requirement: Provider Discovery

The system SHALL detect installed provider packages (`@usejunior/provider-microsoft`, `@usejunior/provider-gmail`) via dynamic import and suggest installation if a requested provider is missing.

#### Scenario: Provider not installed
- **WHEN** `configure_mailbox` is called with `{provider: "gmail"}` but `@usejunior/provider-gmail` is not installed
- **THEN** the system returns: "Provider 'gmail' not available. Install: npm install @usejunior/provider-gmail"
