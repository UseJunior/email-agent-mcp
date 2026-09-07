## ADDED Requirements

### Requirement: Duplicate Delivery Guard

Delivery operations (`send_email`, `reply_to_email`, `send_draft`) SHALL record each
dispatch attempt in a send ledger keyed by a stable fingerprint of the delivery
(mailbox, action, normalized recipients, subject, rendered body and bodyHtml,
attachment digests, `scheduled_send_at`, and the reply parent id or draft id). The
record SHALL be written BEFORE the provider is invoked and settled after it returns.

When a delivery request's fingerprint matches a live ledger record, the system SHALL
NOT invoke the provider and SHALL return a structured error naming the prior attempt's
state: `DUPLICATE_SEND_IN_FLIGHT` when the prior attempt has not returned,
`DUPLICATE_SEND_BLOCKED` when it was delivered (carrying the prior `messageId`), and
`DUPLICATE_SEND_UNRESOLVED` when its outcome was ambiguous.

A delivery outcome that PROVES nothing was delivered — any 4xx-derived code, a 429, a
connect-failure, or an unsupported-capability rejection — SHALL release the
fingerprint, so a resend after a rejection is permitted. Any other outcome, including
an unrecognized provider code, SHALL be held as unresolved.

The guard SHALL be active without embedder configuration. Callers MAY bypass it for a
single request with `allow_duplicate: true`. Operators MAY tune the retention window
with `AGENT_EMAIL_DUPLICATE_SEND_WINDOW_MS`, where `0` disables the guard.

The ledger is per-process and in-memory; it SHALL NOT be presented as surviving a
restart of the server.

#### Scenario: Replay after successful delivery is blocked
- **WHEN** `send_email` succeeds and an identical `send_email` is called again within the window
- **THEN** the provider is not invoked a second time
- **AND** the system returns `{success: false, error: {code: "DUPLICATE_SEND_BLOCKED", recoverable: false}}` carrying the `messageId` of the first delivery

#### Scenario: Replay after ambiguous outcome is blocked
- **WHEN** a send fails with `SEND_STATUS_UNKNOWN` and an identical send is called again within the window
- **THEN** the provider is not invoked a second time
- **AND** the system returns `DUPLICATE_SEND_UNRESOLVED` with guidance to check Sent Items before resending

#### Scenario: Concurrent identical send is blocked while in flight
- **WHEN** an identical send is issued while a prior attempt with the same fingerprint has not yet returned
- **THEN** the second call returns `DUPLICATE_SEND_IN_FLIGHT` without invoking the provider

#### Scenario: Resend after a proven rejection is allowed
- **WHEN** a send fails with a code that proves the provider rejected it (for example `INVALID_REQUEST` or `RATE_LIMITED`)
- **AND** the same send is issued again
- **THEN** the fingerprint has been released and the provider is invoked

#### Scenario: Unrecognized failure code is held as unresolved
- **WHEN** a send fails with a provider code that is not on the proven-unsent list
- **AND** the same send is issued again within the window
- **THEN** the system returns `DUPLICATE_SEND_UNRESOLVED` rather than delivering again

#### Scenario: A different message is not blocked
- **WHEN** a send succeeds and a send differing in any fingerprinted field is issued
- **THEN** the provider is invoked normally

#### Scenario: Explicit duplicate override delivers
- **WHEN** an identical send is issued with `allow_duplicate: true` after a prior delivery
- **THEN** the provider is invoked and the ledger record is replaced by the new attempt

#### Scenario: Guard is active without embedder wiring
- **WHEN** a delivery action runs with an ActionContext that supplies no send ledger
- **THEN** the process-default ledger is used and an identical replay is still refused

#### Scenario: Replayed draft send reports the duplicate, not a stale draft lookup
- **WHEN** `send_draft` succeeds and the same `draft_id` is sent again
- **THEN** the system returns `DUPLICATE_SEND_BLOCKED`
- **AND** it does not report a draft-lookup failure caused by the provider having consumed the draft on the first send

#### Scenario: A bail-out before dispatch does not block the corrected call
- **WHEN** a delivery is refused after the ledger record is written but before the provider is invoked (draft lookup failure, empty recipients, allowlist refusal, rate limit)
- **THEN** the record is released
- **AND** a corrected delivery with the same fingerprint is dispatched normally

#### Scenario: Guard disabled by window of zero
- **WHEN** `AGENT_EMAIL_DUPLICATE_SEND_WINDOW_MS` is `0`
- **THEN** identical repeated sends are dispatched without duplicate checking
