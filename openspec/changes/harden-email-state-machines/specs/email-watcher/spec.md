## MODIFIED Requirements

### Requirement: Timestamp-Based Polling Protocol

The watcher SHALL bootstrap an absent checkpoint at the current time without historical backfill. Each subsequent poll SHALL capture an end timestamp before retrieval and read all pages within the inclusive saved-checkpoint-to-end interval. It SHALL advance to that end only after complete retrieval and all eligible wake POSTs succeed. It SHALL atomically persist the checkpoint before updating its in-memory watermark. Wake delivery SHALL remain at-least-once.

#### Scenario: First run sets checkpoint to now
- **WHEN** no checkpoint exists
- **THEN** the watcher SHALL set its initial timestamp to now without historical backfill

#### Scenario: Subsequent poll uses receivedDateTime filter
- **WHEN** a poll begins with a saved checkpoint
- **THEN** it SHALL query the inclusive interval from checkpoint through poll-start time and follow every page

#### Scenario: Checkpoint advances only after successful wake
- **WHEN** all pages and eligible wakes succeed
- **THEN** the poll-end watermark SHALL be persisted atomically before publication in memory

#### Scenario: Checkpoint unchanged on wake failure
- **WHEN** any page or eligible wake fails
- **THEN** the persisted watermark SHALL remain unchanged for retry

#### Scenario: More than one page of arrivals
- **WHEN** more than 50 messages fall in the polling interval
- **THEN** every page SHALL be processed before advancing the watermark


## ADDED Requirements

### Requirement: Watcher Ownership And Checkpoint Lifecycle

The watcher SHALL hold an acquired mailbox lease while processing work, use a 60-second stale threshold and 10-second heartbeat, stop mailbox work on compromise, and release only after work stops. It SHALL reject live or indeterminate legacy lock owners. Mixed-version exclusion is not guaranteed; old watchers MUST stop before upgrade. Dedup keys SHALL include provider, stable mailbox identity and message ID. Checkpoints SHALL use version 1 timestamp records and read valid legacy lastUpdated records. A malformed existing checkpoint SHALL stop the mailbox with an actionable error.

#### Scenario: Concurrent watcher acquisition
- **WHEN** two upgraded processes acquire the same mailbox
- **THEN** at most one SHALL own it

#### Scenario: Malformed persisted checkpoint
- **WHEN** an existing checkpoint fails validation
- **THEN** the mailbox SHALL stop instead of silently resetting its history

#### Scenario: Graceful watcher shutdown
- **WHEN** the first termination signal arrives
- **THEN** scheduling SHALL stop and work SHALL drain for at most 15 seconds before cancellation
- **AND** leases SHALL release only after work stops
- **WHEN** a second signal arrives
- **THEN** the process SHALL exit immediately
