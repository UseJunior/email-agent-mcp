## ADDED Requirements

### Requirement: Draft Status on Read Results

Read actions return unsent drafts alongside delivered mail. Every message row returned by `list_emails` and `search_emails`, and the `read_email` response, SHALL carry an `isDraft` boolean.

The field SHALL always be present — `true` for an unsent draft, `false` otherwise — and SHALL NOT be omitted when false, so a caller can distinguish "this message was really sent" from "draft status was not reported." Providers that cannot determine draft status SHALL yield `false`.

A row with `isDraft: true` describes a message that has **not** been sent. Its `receivedAt` is the draft's creation or last-modification time, not a delivery time. The tool descriptions for these actions SHALL state this, so a consuming agent does not report a draft as a sent or received email.

This is a labeling change only: drafts SHALL continue to be returned by listing and search exactly as before.

#### Scenario: Search results label a draft
- **WHEN** `search_emails` matches an unsent draft reply in the mailbox owner's own name
- **THEN** the returned row includes `isDraft: true`
- **AND** rows for delivered messages in the same result set include `isDraft: false`

#### Scenario: Listed rows report draft status explicitly
- **WHEN** `list_emails` returns messages from any folder
- **THEN** every row includes an `isDraft` key
- **AND** the key is present with value `false` for non-draft messages rather than omitted

#### Scenario: Reading a draft reports it as unsent
- **WHEN** `read_email` is called with the id of a draft message
- **THEN** the response includes `isDraft: true`
- **AND** reading a delivered message returns `isDraft: false`

#### Scenario: Provider that does not report draft status defaults to false
- **WHEN** a provider returns a message with no draft indication
- **THEN** the row reports `isDraft: false` rather than omitting the field
