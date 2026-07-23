## ADDED Requirements

### Requirement: Deferred Delivery via Graph Extended Property

The Microsoft provider SHALL implement scheduled delivery with MAPI `PidTagDeferredSendTime`, exposed through Graph as the single-value extended property `{ id: "SystemTime 0x3FEF", value: "<UTC timestamp>" }`.

For a new message it SHALL create a draft carrying the property and then POST `/messages/{id}/send`. For an existing draft it SHALL PATCH the property first and then POST `/messages/{id}/send`. It SHALL NOT use `/sendMail` for deferred delivery. The returned pending handle SHALL be the original draft id.

#### Scenario: New scheduled message uses draft then send
- **WHEN** the provider schedules a new message
- **THEN** it POSTs `/messages` with the deferred property before POSTing `/messages/{id}/send`
- **AND** recipients, rendered body, and attachments are preserved in the draft payload

#### Scenario: Existing draft is patched before send
- **WHEN** the provider schedules an existing draft
- **THEN** it PATCHes `/messages/{id}` with the deferred property before POSTing `/messages/{id}/send`

#### Scenario: Send failure leaves a recoverable draft handle
- **WHEN** draft creation succeeds but the subsequent `/send` POST fails
- **THEN** the result is unsuccessful and includes the created draft `messageId`
- **AND** the error states that the unsent draft remains available

### Requirement: Graph Scheduled Send Inspection and Cancellation

The Microsoft provider SHALL list scheduled sends only from Drafts and SHALL recognize the deferred property id case-insensitively because Graph normalizes the proptag hex casing. Before cancellation it SHALL fetch and verify both `isDraft: true` and the deferred property, then DELETE the encoded message path.

Listing SHALL follow Graph `@odata.nextLink` pages with a finite loop/page guard and SHALL fail explicitly rather than silently returning a partial list. A missing item before verification or between verification and DELETE SHALL return `NOT_SCHEDULED`.

#### Scenario: Scheduled send listing follows Graph pagination
- **WHEN** Graph returns scheduled drafts across more than one Drafts page
- **THEN** the provider follows `@odata.nextLink` and returns the scheduled drafts from every page

#### Scenario: Delivered handle is no longer scheduled
- **WHEN** cancellation receives a handle that is missing before verification or disappears before DELETE
- **THEN** it returns `NOT_SCHEDULED`

#### Scenario: Deferred property casing is normalized
- **WHEN** Graph returns `SystemTime 0x3fef`
- **THEN** listing recognizes it as `SystemTime 0x3FEF`
- **AND** returns the property value as `scheduledSendAt`

#### Scenario: Cancellation verifies before delete
- **WHEN** the requested Graph item is a draft carrying the deferred property
- **THEN** the provider DELETEs that encoded message path
- **AND** when either condition is absent it returns `NOT_SCHEDULED` without DELETE
