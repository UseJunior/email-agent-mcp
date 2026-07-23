## ADDED Requirements

### Requirement: Provider-Held Scheduled Delivery

The `send_email` and `send_draft` actions SHALL accept an optional `scheduled_send_at` ISO 8601 timestamp with an explicit timezone. The system SHALL reject invalid timestamps and timestamps that are not in the future before issuing a provider write, normalize accepted timestamps to UTC, and preserve all existing send-allowlist and rate-limit enforcement.

When scheduling is requested, the system SHALL use a provider-held scheduling capability that survives process exit. It SHALL NOT implement delivery with an in-process timer. Immediate-send behavior SHALL remain unchanged when `scheduled_send_at` is omitted. `send_email` SHALL reject the contradictory combination of `draft: true` and `scheduled_send_at`.

#### Scenario: New email is held for future delivery
- **WHEN** `send_email` is called with an allowed recipient and a future `scheduled_send_at`
- **THEN** the provider schedules the message and returns the pending provider `messageId`
- **AND** the response includes the normalized UTC `scheduledSendAt`

#### Scenario: Existing draft is held for future delivery
- **WHEN** `send_draft` is called with a valid draft id and a future `scheduled_send_at`
- **THEN** the provider schedules that draft instead of sending it immediately
- **AND** recipient allowlist and rate-limit checks run exactly as they do for immediate draft send

#### Scenario: Invalid scheduled time causes no provider write
- **WHEN** either send action receives a missing-timezone, invalid, present-time, or past `scheduled_send_at`
- **THEN** it returns `INVALID_SCHEDULED_SEND_AT`
- **AND** it makes no send, draft-create, patch, or delete provider call

#### Scenario: Draft mode and scheduling are mutually exclusive
- **WHEN** `send_email` is called with both `draft: true` and `scheduled_send_at`
- **THEN** it returns `INVALID_SCHEDULED_SEND_MODE`
- **AND** no provider write occurs

#### Scenario: Ambiguous provider submission is not retried
- **WHEN** a provider response is lost after scheduled-send submission may have been accepted
- **THEN** the action returns `SCHEDULE_SEND_STATUS_UNKNOWN` with the pending `messageId`
- **AND** marks the result non-recoverable so callers do not create a duplicate

### Requirement: Scheduled Send Management

The system SHALL provide `list_scheduled_sends` and `cancel_scheduled_send` actions. Listing SHALL return pending provider-held items with `messageId`, subject, recipients, and `scheduledSendAt`. Cancellation SHALL accept the pending `message_id` and cancel only an item the provider verifies is still a scheduled draft.

The pending `messageId` SHALL be documented as a pre-delivery handle. The system SHALL NOT promise that it remains valid after delivery.

#### Scenario: Pending scheduled sends can be listed
- **WHEN** `list_scheduled_sends` is called for a Microsoft mailbox with held messages
- **THEN** it returns only drafts carrying the deferred-send property
- **AND** every returned timestamp is normalized to UTC

#### Scenario: Pending scheduled send can be cancelled
- **WHEN** `cancel_scheduled_send` is called with the id of a held scheduled draft
- **THEN** the provider deletes that held item and returns success

#### Scenario: Cancellation cannot delete an arbitrary draft
- **WHEN** `cancel_scheduled_send` is called with an item that lacks the deferred-send property or is not a draft
- **THEN** it returns `NOT_SCHEDULED`
- **AND** performs no delete

### Requirement: Unsupported Scheduled Send Providers

When the selected provider does not implement scheduled sending, every scheduled-send surface SHALL return a structured `NOT_SUPPORTED` error with `recoverable: false` and SHALL make no send or mutation request.

#### Scenario: Gmail rejects scheduled delivery clearly
- **WHEN** `send_email`, `send_draft`, `list_scheduled_sends`, or `cancel_scheduled_send` requests scheduling on a Gmail mailbox
- **THEN** the action returns `NOT_SUPPORTED`
- **AND** immediate Gmail sending remains unchanged
