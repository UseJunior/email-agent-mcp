## MODIFIED Requirements

### Requirement: Message Mapping

The system SHALL map Gmail message format to the common `EmailMessage` type, including labels, thread IDs, and attachment metadata.

The system SHALL derive `isDraft` from the presence of the `DRAFT` label, and SHALL map that label to the `drafts` folder. `DRAFT` SHALL be checked before `INBOX`/`SENT`: an unsent draft reply carries neither of those labels, so without an explicit branch a draft reported no folder at all and nothing in the mapped message marked it unsent.

#### Scenario: Gmail message to EmailMessage
- **WHEN** a Gmail message is fetched
- **THEN** it is mapped to `EmailMessage` with `threadId`, labels, and standard fields

#### Scenario: Gmail DRAFT label maps to isDraft and the drafts folder
- **WHEN** a Gmail message carrying the `DRAFT` label is fetched
- **THEN** the mapped `EmailMessage` has `isDraft: true`
- **AND** its `folder` is `drafts`

#### Scenario: a delivered Gmail message maps to isDraft false
- **WHEN** a Gmail message without the `DRAFT` label is fetched
- **THEN** the mapped `EmailMessage` has `isDraft: false`
