## ADDED Requirements

### Requirement: Thread Handles on Message Listings

Actions that return message listings — `list_emails` and `search_emails` — SHALL surface the provider-native conversation handle on each row so clients can group messages client-side without a `get_thread` round trip per message. Graph mailboxes SHALL surface `conversationId`; Gmail mailboxes SHALL surface `threadId`.

Both fields SHALL be optional and SHALL be omitted when the provider does not populate them; the system SHALL NOT synthesize a handle, fall back to subject matching, or issue additional provider calls to obtain one. The handles are pass-through identifiers only — this requirement does not promise server-side grouping, and it carries the same caveat as `get_thread`: a Graph `conversationId` can break when a subject changes mid-thread.

#### Scenario: Search and list rows expose the same handle shape
- **WHEN** the same Graph message is returned by both `search_emails` and `list_emails`
- **THEN** both rows carry an identical `conversationId` value under the same field name

#### Scenario: Handle omitted when the provider does not supply one
- **WHEN** a provider returns messages with neither a conversation nor a thread identifier
- **THEN** the returned rows omit `conversationId` and `threadId` entirely rather than returning empty strings or null
- **AND** no additional provider request is made to try to resolve one
