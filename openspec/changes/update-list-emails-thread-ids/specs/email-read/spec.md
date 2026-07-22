## MODIFIED Requirements

### Requirement: List Emails

The system SHALL provide a `list_emails` action that returns recent emails filtered by unread status, sender, date range, folder (inbox, sent, drafts, junk), and configurable limit with sensible defaults.

Each returned row SHALL also carry the provider-native conversation handle when the provider populates it — `conversationId` for Microsoft Graph, `threadId` for Gmail — matching the shape `search_emails` returns, so a client can group a listing by conversation without a follow-up `get_thread` call. Both fields are optional and SHALL be omitted rather than emptied when the provider does not supply them.

#### Scenario: List unread emails from inbox
- **WHEN** `list_emails` is called with `{unread: true, limit: 10}`
- **THEN** the system returns up to 10 unread emails from the default mailbox inbox
- **AND** each email includes id, subject, from, receivedAt, isRead, and hasAttachments

#### Scenario: List from specific mailbox
- **WHEN** `list_emails` is called with `{mailbox: "work", folder: "sent"}`
- **THEN** the system returns emails from the "work" mailbox's sent folder

#### Scenario: Default limit applied
- **WHEN** `list_emails` is called with no `limit` parameter
- **THEN** a sensible default limit (e.g., 25) is applied to prevent unbounded queries

#### Scenario: Listed rows carry the provider conversation handle
- **WHEN** `list_emails` returns messages from a Microsoft Graph mailbox
- **THEN** each row includes `conversationId` as returned by the provider
- **AND** the equivalent Gmail listing includes `threadId`
