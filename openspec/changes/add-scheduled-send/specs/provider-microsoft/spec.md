## ADDED Requirements

### Requirement: Deferred Delivery via Graph Extended Property

The Microsoft provider SHALL implement scheduled delivery with MAPI `PidTagDeferredSendTime`, exposed through Graph as the single-value extended property `{ id: "SystemTime 0x3FEF", value: "<UTC timestamp>" }`.

For a new message it SHALL create a draft, finish attachment preparation, PATCH the property, and then POST `/messages/{id}/send`. For an existing draft it SHALL PATCH the property first and then POST `/messages/{id}/send`. It SHALL NOT use `/sendMail` for deferred delivery. The returned pending handle SHALL be the original draft id.

#### Scenario: New scheduled message uses draft then send
- **WHEN** the provider schedules a new message
- **THEN** it POSTs `/messages`, completes attachment preparation, and PATCHes the deferred property before POSTing `/messages/{id}/send`
- **AND** recipients, rendered body, and attachments are preserved in the draft payload

#### Scenario: Existing draft is patched before send
- **WHEN** the provider schedules an existing draft
- **THEN** it PATCHes `/messages/{id}` with the deferred property before POSTing `/messages/{id}/send`

#### Scenario: Send failure leaves a recoverable draft handle
- **WHEN** draft creation succeeds but the subsequent `/send` POST fails
- **THEN** the result is unsuccessful and includes the created draft `messageId`
- **AND** an explicit rejection reports the retained handle while an ambiguous response warns that delivery may already be scheduled

#### Scenario: Preparation failure never dispatches and retains every known handle
- **WHEN** draft creation or deferred-property preparation fails
- **THEN** no send is attempted and all known draft/message handles are retained
- **AND** no cleanup or replay is attempted, even if the failed write persisted remotely

#### Scenario: Partial upload failure keeps draft without applying deferred property or sending
- **WHEN** one attachment persists and another upload fails
- **THEN** the result retains the draft/message handles and identifies the failed preparation phase
- **AND** it neither applies the deferred marker nor dispatches or deletes the partial draft

#### Scenario: Accepted send with lost response remains unknown without replay or cleanup
- **WHEN** Graph accepts submission but the response is lost
- **THEN** the result is unknown, non-recoverable, and includes every known handle
- **AND** no automatic send replay or draft deletion occurs

### Requirement: Graph Scheduled Send Inspection and Cancellation

The Microsoft provider SHALL list scheduled sends mailbox-wide, narrowed to `isDraft eq true` rather than to a folder, because Outlook's own Schedule send leaves the deferred message outside Drafts (observed in Deleted Items). Listing SHALL return only sends whose deferred time is valid and still in the future, since Outlook leaves the tagged copy behind after delivery. It SHALL recognize the deferred property id case-insensitively because Graph normalizes the proptag hex casing. Before cancellation it SHALL fetch and verify both `isDraft: true` and a valid future deferred timestamp, then DELETE the encoded message path. Past/invalid markers SHALL return `NOT_SCHEDULED` without deletion. Observation and deletion are not remotely atomic; cancellation SHALL NOT promise recall of delivered mail or use an unverified conditional DELETE header.

Listing SHALL follow Graph `@odata.nextLink` pages with a finite loop/page guard and SHALL fail explicitly rather than silently returning a partial list. A missing item before verification or between verification and DELETE SHALL return `NOT_SCHEDULED`.

#### Scenario: Scheduled send listing follows Graph pagination
- **WHEN** Graph returns scheduled drafts across more than one page
- **THEN** the provider follows `@odata.nextLink` and returns the scheduled drafts from every page

#### Scenario: Outlook UI-scheduled message outside Drafts is listed
- **WHEN** a deferred draft sits outside Drafts because Outlook's Schedule send moved it
- **THEN** listing returns it alongside sends scheduled through this server
- **AND** a deferred message whose scheduled time has already passed is omitted

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

#### Scenario: Past and invalid deferred markers are residue, never cancellable
- **WHEN** a draft carries a past, present, invalid, or timezone-less marker
- **THEN** cancellation returns `NOT_SCHEDULED` without DELETE
- **AND** listing omits it and snapshot lifecycle does not mark it deferred

#### Scenario: Delivery wins after cancellation observation without a recall guarantee
- **WHEN** delivery completes after draft verification and DELETE returns not found
- **THEN** cancellation returns `NOT_SCHEDULED` without retry
- **AND** successful deletion also makes no claim to recall any delivered copy
