---
epic: Agent Integration
feature: Email Arrival Detection
---

## Purpose

Defines the email watcher that monitors configured mailboxes for new emails and triggers agent wake via authenticated webhook POST. Supports dual mode per provider: Graph Delta Query polling + webhook, Gmail history.list polling + Pub/Sub. Monitors all configured mailboxes and includes mailbox name in wake payloads.

### Requirement: Dual Mode Per Provider

The system SHALL support two detection modes per provider, selectable via configuration.

#### Scenario: Graph Delta Query (default for local)
- **WHEN** Graph provider is configured without a public webhook URL
- **THEN** the watcher uses Delta Query polling at a configurable interval (default 30s)

#### Scenario: Graph Webhook (production)
- **WHEN** Graph provider is configured with a public HTTPS webhook URL
- **THEN** the watcher registers for Graph change notifications

#### Scenario: Gmail history.list (default for local)
- **WHEN** Gmail provider is configured without Pub/Sub
- **THEN** the watcher polls `history.list` at a configurable interval (default 30s)

#### Scenario: Gmail Pub/Sub (production)
- **WHEN** Gmail Pub/Sub is configured
- **THEN** the watcher registers for push notifications with auto-renewal every 7 days

### Requirement: Authenticated Wake POST

The system SHALL POST to the configured wake URL with authentication. Default URL: OpenClaw `/hooks/wake`.

#### Scenario: Wake with token
- **WHEN** a new email is detected
- **THEN** the system POSTs to the wake URL with `Authorization: Bearer {token}` header
- **AND** the token is read from `OPENCLAW_HOOKS_TOKEN` env var or `~/.openclaw/` config

### Requirement: Wake Payload

The payload SHALL include an email summary with the originating mailbox name.

#### Scenario: Multi-mailbox wake
- **WHEN** a new email arrives in the "work" mailbox from alice@corp.com with subject "Contract Review"
- **THEN** the wake payload is `{text: "[work] New email from alice@corp.com: Contract Review", mode: "now"}`

### Requirement: Deduplication

The system SHALL NOT re-wake for already-processed emails.

#### Scenario: Duplicate suppression
- **WHEN** the same email ID is detected twice (e.g., due to polling overlap)
- **THEN** the second detection is silently skipped

### Requirement: Subscription Lifecycle

The system SHALL auto-renew provider subscriptions before expiry and handle renewal failures gracefully.

#### Scenario: Graph subscription renewal
- **WHEN** a Graph webhook subscription approaches expiry
- **THEN** the system verifies it exists (zombie check) and renews it

#### Scenario: Gmail watch renewal
- **WHEN** the Gmail Pub/Sub watch approaches 7-day expiry
- **THEN** the system re-calls `users.watch()` to renew

### Requirement: Multi-Mailbox Monitoring

The system SHALL monitor all configured mailboxes simultaneously.

#### Scenario: Two mailboxes
- **WHEN** "work" (Graph) and "personal" (Gmail) are configured
- **THEN** the watcher monitors both and wakes with the appropriate mailbox name
