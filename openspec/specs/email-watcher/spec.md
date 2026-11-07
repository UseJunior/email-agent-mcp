---
epic: Agent Integration
feature: Email Arrival Detection
---

## Purpose

Defines the email watcher that monitors configured mailboxes for new emails and triggers agent wake via authenticated webhook POST. Uses timestamp-based polling to detect new messages. Monitors all configured mailboxes and includes mailbox email address in wake payloads. Wake payloads use text-only format for OpenClaw `/hooks/wake` compatibility. The watcher uses `receivedDateTime ge {since}` filtering with a checkpoint that advances only after a successful wake POST.
## Requirements
### Requirement: Timestamp-Based Polling Protocol

The watcher SHALL use Microsoft timestamp polling; Gmail, webhook and Pub/Sub execution are not implemented by this watch command. On first run, absence alone initializes the checkpoint to now without historical backfill. Every poll captures an end timestamp before fetching and retrieves every nextLink in the inclusive interval `[saved watermark, poll start]`. Repeated links, more than 1000 pages, malformed pages, errors and cancellation SHALL fail the whole retrieval. The checkpoint SHALL advance to the captured end only after every eligible wake succeeds and atomic persistence succeeds. Wake delivery is at-least-once across crashes and ambiguous responses.

#### Scenario: First run sets checkpoint to now
- **WHEN** the watcher starts for a mailbox with no saved state
- **THEN** it sets the checkpoint to the current time without processing any historical messages
- **AND** no wake POSTs are sent during the first poll

#### Scenario: Subsequent poll uses receivedDateTime filter
- **WHEN** the watcher polls after the first run
- **THEN** it queries messages with `receivedDateTime ge {since}` where `{since}` is the saved checkpoint
- **AND** includes messages equal to the checkpoint and no messages beyond the captured poll start

#### Scenario: Checkpoint advances only after successful wake
- **WHEN** a new email is detected and the wake POST succeeds
- **THEN** the checkpoint advances to the captured poll start after successful persistence
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

The watcher SHALL persist `{version:1,kind:"timestamp",lastUpdated:ISO_timestamp}` per mailbox in `~/.email-agent-mcp/state/{mailbox-id}.delta.json` using a same-directory exclusive temporary file, mode 0600, and rename. Failed writes SHALL clean temporary files and retain the old checkpoint. Memory SHALL advance only after persistence. The reader SHALL accept legacy `{deltaLink,lastUpdated}` with a valid ISO timestamp, and SHALL stop the mailbox on malformed existing state or read errors other than ENOENT. The exported delta-shaped reader and legacy save input remain compatibility adapters; delta cursors are unused.

#### Scenario: Checkpoint persisted across restart
- **WHEN** the watcher is stopped and restarted
- **THEN** it loads the saved checkpoint from `~/.email-agent-mcp/state/` and resumes polling from where it left off

#### Scenario: Checkpoint file per mailbox
- **WHEN** two mailboxes are configured (`test-user@example.com` and `alice@corp.com`)
- **THEN** two separate checkpoint files exist: `test-user-example-com.delta.json` and `alice-corp-com.delta.json`

### Requirement: Per-Mailbox Lock File

The watcher SHALL acquire an exclusive per-mailbox lease at `~/.email-agent-mcp/state/{mailbox-id}.watcher.lock.lease` using atomic directory creation, a 60-second stale threshold and 10-second heartbeat. It SHALL retain the acquired release handle rather than unlinking paths by PID. Compromise SHALL invalidate the lease and prevent further mailbox side effects. Existing live, malformed or permission-indeterminate legacy `.watcher.lock` records SHALL block acquisition; legacy watchers MUST stop before upgrade because mixed-version exclusion is not guaranteed.

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

The system SHALL suppress already-processed emails in its bounded process-local dedup cache, keyed by provider, stable mailbox identity and message ID. Failed wakes SHALL remain eligible for retry. Inclusive timestamp boundaries SHALL preserve equal-timestamp arrivals. Restart or eviction can cause duplicate wakes; exactly-once delivery is not guaranteed. Existing single-ID dedup exports remain deprecated compatibility adapters; the runner always supplies the namespace.

#### Scenario: Duplicate suppression
- **WHEN** the same email ID is detected twice (e.g., due to polling overlap or delta replay)
- **THEN** the second detection is silently skipped

### Requirement: Multi-Mailbox Monitoring

The watch command SHALL monitor configured Microsoft mailboxes with independent serial poll runners and appropriate receiving mailbox identity. Other providers and push modes require separate implementation.

#### Scenario: Two mailboxes
- **WHEN** two Microsoft mailboxes are configured
- **THEN** the watcher monitors both and wakes with the appropriate mailbox email address in the text payload

### Requirement: Mailbox Run Lifecycle

The runner SHALL own bootstrapping, idle, polling, delivering, checkpointing, backoff, stopping and stopped transitions. Polls SHALL never overlap for one mailbox. A failed poll, wake, checkpoint write or authentication request SHALL retain the saved watermark and retry with exponential backoff starting at the configured interval and capped at five minutes; success resets the delay. Lease compromise SHALL cancel work and prevent further side effects. Ownership SHALL be asserted before network dispatch and checkpoint publication. Setup failure SHALL release the acquired lease after setup cleanup.

#### Scenario: Every page in a bounded window
- **WHEN** 51 or more messages arrive in a polling window
- **THEN** all pages are fetched before delivery and checkpointing

#### Scenario: Later page failure retains checkpoint
- **WHEN** a later page fails
- **THEN** no partial retrieval is delivered or checkpointed and retry uses the same lower bound

#### Scenario: Equal timestamps remain eligible
- **WHEN** another message appears at the saved watermark timestamp
- **THEN** an inclusive subsequent poll can deliver it

#### Scenario: Wake and checkpoint failures retain the watermark
- **WHEN** wake delivery or persistence fails
- **THEN** memory and disk retain the watermark until a complete successful poll

#### Scenario: Mailbox and provider dedup namespaces
- **WHEN** different mailboxes or providers return the same message ID
- **THEN** each namespace can trigger its own wake

#### Scenario: Backoff grows and resets after success
- **WHEN** polling repeatedly fails and then succeeds
- **THEN** retry delay grows to at most five minutes and resets on success

#### Scenario: Runner bootstraps now and restarts from committed disk
- **WHEN** the runner starts without state and later restarts
- **THEN** bootstrap starts now and restart reads the committed checkpoint

#### Scenario: Legacy checkpoint migrates through the runner
- **WHEN** valid legacy timestamp state exists
- **THEN** the next successful runner checkpoint writes version 1

#### Scenario: Malformed existing state stops the mailbox
- **WHEN** existing state is torn, invalid or an unsupported version
- **THEN** the mailbox stops with an actionable error without overwriting state

#### Scenario: Atomic write failure retains disk and cleans temporary files
- **WHEN** publication fails after writing a temporary checkpoint
- **THEN** the old state remains and the temporary file is removed

#### Scenario: No overlapping polls
- **WHEN** a poll takes longer than the configured interval
- **THEN** another poll cannot start before it settles

### Requirement: Draining Shutdown

The first SIGINT or SIGTERM SHALL stop scheduling and allow active setup, poll, wake or checkpoint work to drain for a shared 15-second deadline. At the deadline cancellation SHALL propagate to Azure token requests, Graph requests and wakes. Cleanup SHALL wait for cancellation settlement before releasing ownership or closing shared resources. The second signal SHALL exit immediately. Shutdown during setup SHALL prevent subsequent polling and clean any acquired handles.

#### Scenario: Shutdown during setup retains ownership until setup settles
- **WHEN** shutdown begins during setup
- **THEN** ownership remains until setup settles and no poll begins

#### Scenario: Failed setup releases its lease
- **WHEN** setup fails
- **THEN** its acquired lease is released after cleanup

#### Scenario: Drain deadline aborts work before lease release
- **WHEN** active work has not settled after 15 seconds of draining
- **THEN** it is aborted and ownership remains until cancellation cleanup finishes

#### Scenario: Second shutdown signal exits immediately
- **WHEN** another signal arrives while draining
- **THEN** the process exits immediately

#### Scenario: Lease loss cancels work and prevents wakes and checkpointing
- **WHEN** a mailbox lease is compromised
- **THEN** active work is cancelled and cannot publish additional side effects
