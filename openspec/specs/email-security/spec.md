---
epic: Security
feature: Email Security Controls
---

## Purpose

Defines security controls for email operations: send allowlist (gates all outbound including replies), receive allowlist (gates watcher triggers), delete policy, anti-spoofing (SPF/DKIM/DMARC), and rate limiting. Security-first defaults: all outbound blocked until explicitly configured.

### Requirement: Send Allowlist

The system SHALL gate ALL outbound email (both `send_email` and `reply_to_email`) against a configurable allowlist. The allowlist supports exact email addresses, domain wildcards (`*@example.com`), or both. Default is EMPTY — blocks all outbound until configured.

#### Scenario: Empty allowlist blocks all outbound
- **WHEN** no send allowlist is configured
- **THEN** all send and reply attempts return an error with a clear message that outbound email is disabled
- **AND** `get_mailbox_status` includes a warning that outbound is disabled

#### Scenario: Domain wildcard match
- **WHEN** `*@lawfirm.com` is in the send allowlist
- **AND** `reply_to_email` targets `partner@lawfirm.com`
- **THEN** the reply is allowed

#### Scenario: Wildcard allows all
- **WHEN** `*` is in the send allowlist
- **THEN** all outbound email is allowed (user's explicit choice)

### Requirement: Allowlist Protection

The allowlist file SHALL be loaded at startup from a path set via environment variable or CLI config. The MCP server SHALL NOT expose any tool to modify the allowlist. The agent has no mechanism to change its own permissions.

#### Scenario: Agent cannot modify allowlist
- **WHEN** the agent attempts to write to the allowlist file path
- **THEN** no MCP tool exists for this purpose — the attempt fails at the agent level

#### Scenario: NemoClaw read-only storage
- **WHEN** running in NemoClaw sandbox
- **THEN** the allowlist is stored in `/sandbox/.openclaw` (read-only filesystem policy)

### Requirement: Receive Allowlist

The system SHALL provide a receive allowlist that controls which inbound emails trigger the watcher. Default is accept all (wildcard `*`). Same format as send allowlist.

#### Scenario: Accept all by default
- **WHEN** no receive allowlist is configured
- **THEN** all inbound emails trigger the watcher

### Requirement: Delete Policy

Delete SHALL be disabled by default. When enabled via configuration, the agent MUST pass `user_explicitly_requested_deletion: true`. Default to soft delete (move to Trash). No bulk delete.

#### Scenario: Soft delete
- **WHEN** delete is enabled and `user_explicitly_requested_deletion: true` is passed
- **THEN** the email is moved to Trash (soft delete)

#### Scenario: Hard delete requires explicit flag
- **WHEN** `hard_delete: true` is also passed
- **THEN** the email is permanently deleted

### Requirement: Anti-Spoofing

The system SHALL check email authentication headers on inbound emails. Configurable strictness: strict (require SPF+DKIM), relaxed (require either), off (skip).

#### Scenario: Graph anti-spoofing
- **WHEN** an inbound email arrives via Graph API
- **THEN** the system checks `authenticationResults` header and rejects spoofed external emails
- **AND** internal M365 emails are allowed through (detected via `x-ms-exchange-organization-authas`)

#### Scenario: Gmail anti-spoofing
- **WHEN** an inbound email arrives via Gmail
- **THEN** the system checks `Authentication-Results` header from raw message headers

### Requirement: Rate Limiting

The system SHALL enforce configurable rate limits on outbound operations (max sends per time window).

#### Scenario: Rate limit exceeded
- **WHEN** the agent exceeds the configured send rate
- **THEN** the system returns an error with retry-after guidance
