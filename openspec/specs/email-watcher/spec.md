---
epic: Agent Integration
feature: Email Arrival Detection
---

## Purpose

Defines the email watcher that monitors configured mailboxes for new emails and triggers agent wake via authenticated webhook POST. Uses timestamp-based polling to detect new messages. Monitors all configured mailboxes and includes mailbox email address in wake payloads. Wake payloads use text-only format for OpenClaw `/hooks/wake` compatibility. The watcher uses `receivedDateTime ge {since}` filtering with a checkpoint that advances only after a successful wake POST.

### Requirement: Timestamp-Based Polling Protocol

The watcher SHALL use timestamp-based polling to detect new emails. On first run, the checkpoint is set to the current time (no historical backfill). Subsequent polls filter messages using `receivedDateTime ge {since}`. The checkpoint advances only after a successful wake POST, ensuring no messages are lost on transient failures.

#### Scenario: First run sets checkpoint to now
- **WHEN** the watcher starts for a mailbox with no saved state
- **THEN** it sets the checkpoint to the current time without processing any historical messages
- **AND** no wake POSTs are sent during the first poll

#### Scenario: Subsequent poll uses receivedDateTime filter
- **WHEN** the watcher polls after the first run
- **THEN** it queries messages with `receivedDateTime ge {since}` where `{since}` is the saved checkpoint
- **AND** sends wake POSTs only for messages newer than the checkpoint

#### Scenario: Checkpoint advances only after successful wake
- **WHEN** a new email is detected and the wake POST succeeds
- **THEN** the checkpoint advances to the `receivedDateTime` of the processed message
- **AND** subsequent polls use the new checkpoint

#### Scenario: Checkpoint unchanged on wake failure
- **WHEN** a new email is detected but the wake POST fails (e.g., network error, 5xx)
- **THEN** the checkpoint remains unchanged
- **AND** the message will be retried on the next poll cycle

### Requirement: Poll Interval Validation

The watcher SHALL validate the poll interval to prevent excessive API usage. Minimum interval is 2 seconds (rejected below), intervals below 5 seconds log a warning, and the default is 10 seconds.

#### Scenario: Default poll interval
- **WHEN** no poll interval is configured
- **THEN** the watcher uses a 10-second poll interval

#### Scenario: Minimum interval enforced
- **WHEN** the poll interval is set below 2 seconds
- **THEN** the watcher rejects the configuration with an error

#### Scenario: Warning for aggressive interval
- **WHEN** the poll interval is set to a value >= 2s but < 5s
- **THEN** the watcher logs a warning that the interval is aggressive and may cause rate limiting

### Requirement: Authenticated Wake POST

The system SHALL POST to the configured wake URL with authentication. Default URL: OpenClaw `/hooks/wake`.

#### Scenario: Wake with token
- **WHEN** a new email is detected
- **THEN** the system POSTs to the wake URL with `Authorization: Bearer {token}` header
- **AND** the token is read from `OPENCLAW_HOOKS_TOKEN` env var or `~/.openclaw/` config

### Requirement: Wake Payload

The wake payload SHALL be text-only `{text, mode}` for OpenClaw `/hooks/wake` compatibility. OpenClaw's `normalizeWakePayload` strips everything except `text` and `mode`; structured fields are ignored. The `text` field SHALL be self-contained: it MUST include the receiving mailbox email address, sender with display name, full to/cc recipient list, subject, and attachment indicator. The `mode` SHALL be `"now"`.

#### Scenario: Multi-mailbox wake
- **WHEN** a new email arrives at `test-user@example.com` from Alice Smith &lt;alice@corp.com&gt; with subject "Contract Review", to test-user@example.com and bob@corp.com, cc team@corp.com, with attachments
- **THEN** the wake payload is `{text: "New email to test-user@example.com from Alice Smith <alice@corp.com>: Contract Review\nTo: test-user@example.com, bob@corp.com\nCc: team@corp.com\nAttachments: yes", mode: "now"}`

#### Scenario: Wake payload without attachments
- **WHEN** a new email arrives at `test-user@example.com` from bob@corp.com with subject "Quick question", no cc, no attachments
- **THEN** the wake payload text does NOT include an "Attachments:" line

#### Scenario: No structured email object in payload
- **WHEN** the system constructs a wake payload
- **THEN** the payload contains only `text` and `mode` keys at the top level — no `email`, `metadata`, or other structured objects

### Requirement: Per-Mailbox Checkpoint Persistence

The watcher SHALL persist the polling checkpoint per mailbox in `~/.email-agent-mcp/state/{mailbox-id}.watcher.json`. This ensures the watcher survives restarts without reprocessing old messages or missing new ones.

#### Scenario: Checkpoint persisted across restart
- **WHEN** the watcher is stopped and restarted
- **THEN** it loads the saved checkpoint from `~/.email-agent-mcp/state/` and resumes polling from where it left off

#### Scenario: Checkpoint file per mailbox
- **WHEN** two mailboxes are configured (`test-user@example.com` and `alice@corp.com`)
- **THEN** two separate checkpoint files exist: `test-user-example-com.watcher.json` and `alice-corp-com.watcher.json`

### Requirement: Per-Mailbox Lock File

The watcher SHALL create a lock file per mailbox at `~/.email-agent-mcp/state/{mailbox-id}.watcher.lock` to prevent duplicate watcher instances for the same mailbox.

#### Scenario: Lock prevents duplicate watcher
- **WHEN** a watcher is already running for `test-user@example.com`
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

The system SHALL NOT re-wake for already-processed emails. Timestamp-based polling can return duplicates across poll cycles — the system SHALL deduplicate by message ID.

#### Scenario: Duplicate suppression
- **WHEN** the same email ID is detected twice (e.g., due to polling overlap or delta replay)
- **THEN** the second detection is silently skipped

### Requirement: Multi-Mailbox Monitoring

The system SHALL monitor all configured mailboxes simultaneously.

#### Scenario: Two mailboxes
- **WHEN** `test-user@example.com` (Graph) and `test-user@gmail.com` (Gmail) are configured
- **THEN** the watcher monitors both and wakes with the appropriate mailbox email address in the text payload
