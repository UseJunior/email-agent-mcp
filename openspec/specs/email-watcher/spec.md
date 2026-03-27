---
epic: Agent Integration
feature: Email Arrival Detection
---

## Purpose

Defines the email watcher that monitors configured mailboxes for new emails and triggers agent wake via authenticated webhook POST. Supports dual mode per provider: Graph Delta Query polling + webhook, Gmail history.list polling + Pub/Sub. Monitors all configured mailboxes and includes mailbox email address in wake payloads. Wake payloads use text-only format for OpenClaw `/hooks/wake` compatibility. The watcher implements Delta Query sync protocol with baseline sync, paging, tombstone filtering, and resync on state expiry.

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

The wake payload SHALL be text-only `{text, mode}` for OpenClaw `/hooks/wake` compatibility. OpenClaw's `normalizeWakePayload` strips everything except `text` and `mode`; structured fields are ignored. The `text` field SHALL be self-contained: it MUST include the receiving mailbox email address, sender with display name, full to/cc recipient list, subject, and attachment indicator. The `mode` SHALL be `"now"`.

#### Scenario: Multi-mailbox wake
- **WHEN** a new email arrives at `steven@usejunior.com` from Alice Smith &lt;alice@corp.com&gt; with subject "Contract Review", to steven@usejunior.com and bob@corp.com, cc team@corp.com, with attachments
- **THEN** the wake payload is `{text: "New email to steven@usejunior.com from Alice Smith <alice@corp.com>: Contract Review\nTo: steven@usejunior.com, bob@corp.com\nCc: team@corp.com\nAttachments: yes", mode: "now"}`

#### Scenario: Wake payload without attachments
- **WHEN** a new email arrives at `steven@usejunior.com` from bob@corp.com with subject "Quick question", no cc, no attachments
- **THEN** the wake payload text does NOT include an "Attachments:" line

#### Scenario: No structured email object in payload
- **WHEN** the system constructs a wake payload
- **THEN** the payload contains only `text` and `mode` keys at the top level — no `email`, `metadata`, or other structured objects

### Requirement: Delta Query Sync Protocol

The watcher SHALL implement a correct Delta Query sync protocol with the following phases: baseline sync on first run (consume all pages silently without waking), subsequent polls using the saved `deltaLink`, `@odata.nextLink` paging, `@removed` tombstone filtering, and `410 Gone` resync.

#### Scenario: Baseline sync on first run
- **WHEN** the watcher starts for a mailbox with no saved delta state
- **THEN** it consumes ALL pages (following `@odata.nextLink`) silently without sending any wake POSTs
- **AND** saves the final `@odata.deltaLink` for subsequent polls

#### Scenario: Subsequent poll with deltaLink
- **WHEN** the watcher polls after baseline sync
- **THEN** it uses the saved `deltaLink` to fetch only new changes since the last poll
- **AND** sends wake POSTs only for genuinely new messages

#### Scenario: Paging with @odata.nextLink
- **WHEN** a delta response includes `@odata.nextLink`
- **THEN** the system follows the link to fetch the next page of results before processing

#### Scenario: Tombstone filtering
- **WHEN** a delta response includes items with `@removed` (deleted or moved messages)
- **THEN** those items are filtered out and do NOT trigger wake POSTs

#### Scenario: 410 Gone resync
- **WHEN** a delta request returns `410 Gone` or `syncStateNotFound`
- **THEN** the system discards the stale `deltaLink` and performs a full baseline resync (silent, no wakes)

### Requirement: Per-Mailbox Delta State Persistence

The watcher SHALL persist delta state (including `deltaLink`) per mailbox in `~/.agent-email/state/{mailbox-id}.delta.json`. This ensures the watcher survives restarts without reprocessing old messages.

#### Scenario: Delta state persisted across restart
- **WHEN** the watcher is stopped and restarted
- **THEN** it loads the saved `deltaLink` from `~/.agent-email/state/` and resumes polling without a full baseline resync

#### Scenario: Delta state file per mailbox
- **WHEN** two mailboxes are configured (`steven@usejunior.com` and `alice@corp.com`)
- **THEN** two separate delta state files exist: `steven-usejunior-com.delta.json` and `alice-corp-com.delta.json`

### Requirement: Per-Mailbox Lock File

The watcher SHALL create a lock file per mailbox at `~/.agent-email/state/{mailbox-id}.watcher.lock` to prevent duplicate watcher instances for the same mailbox.

#### Scenario: Lock prevents duplicate watcher
- **WHEN** a watcher is already running for `steven@usejunior.com`
- **AND** a second watcher attempts to start for the same mailbox
- **THEN** the second watcher exits with an error indicating the mailbox is already being watched

#### Scenario: Lock released on shutdown
- **WHEN** the watcher shuts down gracefully (SIGINT/SIGTERM)
- **THEN** the lock file is removed

### Requirement: Receive Allowlist Gating

The watcher SHALL gate each new message against a receive allowlist BEFORE sending a wake POST. If no allowlist is configured, the default behavior is to accept all senders (wildcard `*`), but a warning SHALL be logged.

#### Scenario: Allowed sender triggers wake
- **WHEN** a new email arrives from `alice@corp.com`
- **AND** `alice@corp.com` is on the receive allowlist
- **THEN** the wake POST is sent

#### Scenario: Non-allowed sender blocked
- **WHEN** a new email arrives from `spam@evil.com`
- **AND** `spam@evil.com` is NOT on the receive allowlist
- **THEN** no wake POST is sent and the skip is logged

#### Scenario: No allowlist configured defaults to accept all
- **WHEN** no receive allowlist is configured
- **THEN** all senders are accepted
- **AND** a warning is logged: "No receive allowlist configured — accepting all senders"

### Requirement: Deduplication

The system SHALL NOT re-wake for already-processed emails. Delta can return duplicates — the system SHALL deduplicate by message ID.

#### Scenario: Duplicate suppression
- **WHEN** the same email ID is detected twice (e.g., due to polling overlap or delta replay)
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
- **WHEN** `steven@usejunior.com` (Graph) and `steven@gmail.com` (Gmail) are configured
- **THEN** the watcher monitors both and wakes with the appropriate mailbox email address in the text payload
