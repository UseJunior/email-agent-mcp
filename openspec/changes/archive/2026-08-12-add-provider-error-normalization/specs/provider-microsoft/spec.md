## MODIFIED Requirements

### Requirement: Draft-Then-Send via createReplyAll

The system SHALL use `createReplyAll` for replies. `createReplyAll` preserves embedded images, CID references, and thread metadata. The system merges Graph's auto-quoted body with caller content rather than overwriting it. When `createReplyAll` or the body merge PATCH fails, `replyToMessage` SHALL return a structured `{ success: false, error: { code: 'REPLY_FAILED', recoverable: false } }` rather than silently falling back to `sendMail` — a `sendMail`-based message would lack `In-Reply-To` / `References` headers and so would not thread on the recipient side.

The final `/send` POST is distinguished from draft preparation because only it can leave delivery in doubt. When the `/send` POST fails, `replyToMessage` SHALL classify the failure: a response proving Graph rejected the request is terminal and carries the classified code; a failure whose outcome cannot be proven SHALL return `SEND_STATUS_UNKNOWN` naming the prepared draft so the caller can determine whether the reply was delivered. In no case SHALL `replyToMessage` fall back to `sendMail`.

#### Scenario: Reply preserves Graph auto-quoted thread (plain text)
- **WHEN** the original email has prior thread history
- **AND** the system replies via `createReplyAll` with plain-text content
- **THEN** the resulting draft preserves Graph's auto-generated quoted thread divider and prior-message header block alongside the caller content

#### Scenario: cid: references survive the merge unchanged
- **WHEN** the original email contains embedded images referenced via `cid:` URLs in Graph's quoted body
- **AND** the system replies via `createReplyAll`
- **THEN** the merged draft body retains every `cid:` reference intact

#### Scenario: Reply preparation failure is terminal, not ambiguous
- **WHEN** `createReplyAll` or the body-merge PATCH throws
- **THEN** `replyToMessage` returns `{ success: false, error: { code: 'REPLY_FAILED', recoverable: false } }`
- **AND** the message does not suggest the reply may have been delivered
- **AND** does not call `sendMail`

#### Scenario: Reply dispatch of unknown outcome reports SEND_STATUS_UNKNOWN
- **WHEN** the reply draft is created and the final `/send` POST fails without proving Graph rejected it
- **THEN** `replyToMessage` returns `{ success: false, error: { code: 'SEND_STATUS_UNKNOWN', recoverable: false } }`
- **AND** the message instructs the caller not to resend automatically and names the prepared draft to inspect
- **AND** does not call `sendMail`

#### Scenario: Reply dispatch rejected by Graph is terminal
- **WHEN** the reply draft is created and the final `/send` POST is rejected with a 4xx response
- **THEN** `replyToMessage` returns the classified terminal code with `recoverable: false`
- **AND** the message does not suggest the reply may have been delivered

#### Scenario: update_draft preserves Graph auto-quoted thread
- **WHEN** `update_draft` is called with a new body on a draft that contains Graph's auto-quoted thread (divider + `From:/Sent:/To:/Subject:` block)
- **THEN** the resulting PATCH replaces only the caller content above the divider
- **AND** preserves the divider, header block, and prior message body intact

#### Scenario: update_draft on a fresh draft replaces body wholesale
- **WHEN** `update_draft` is called on a draft with no quoted-thread marker
- **THEN** the body is PATCHed wholesale via `buildGraphBody` (existing behavior unchanged)

## ADDED Requirements

### Requirement: Graph Delivery Failure Classification

The Microsoft provider SHALL classify failures of its delivery operations (`sendMessage`, `replyToMessage`, `sendDraft`) by whether Graph can be proven not to have accepted the message.

A response with a 4xx status proves Graph received and rejected the request, so nothing was delivered: the failure is terminal. A response with a 5xx status proves receipt but not action. A transport failure is treated as proving non-delivery only when its error code can only arise before request bytes are written; every other transport failure, and every unrecognized failure, SHALL be treated as of unknown outcome.

Failures of unknown outcome SHALL be reported as `SEND_STATUS_UNKNOWN` with `recoverable: false`, and the message SHALL instruct the caller not to resend automatically and name a concrete artifact — a tracking id or draft id — by which the caller can determine what actually happened. Local failures occurring before dispatch (payload construction, recipient parsing, attachment encoding) SHALL NOT be reported as of unknown outcome.

When Graph supplies a `Retry-After` header the system SHALL surface its value as `retryAfter`.

#### Scenario: Graph 4xx on delivery is terminal
- **WHEN** a delivery operation's dispatch is rejected with a 4xx response
- **THEN** the result carries the classified terminal code with `recoverable: false`
- **AND** the message does not suggest the message may have been delivered

#### Scenario: Graph 5xx after submission reports SEND_STATUS_UNKNOWN with a handle
- **WHEN** a delivery operation's dispatch fails with a 5xx response
- **THEN** the result carries `SEND_STATUS_UNKNOWN` with `recoverable: false`
- **AND** the message instructs the caller not to resend automatically and names the tracking id or draft id to inspect

#### Scenario: Pre-dispatch construction failure is not reported as a possible delivery
- **WHEN** a delivery operation fails while building its request, before any dispatch is attempted
- **THEN** the failure is terminal and is not reported as `SEND_STATUS_UNKNOWN`
