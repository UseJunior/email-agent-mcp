---
epic: Email Operations
feature: Read Actions
---

## Purpose

Defines read-only email operations: listing, reading, and searching emails across one or more configured mailboxes. All actions accept an optional `mailbox` parameter that defaults to the default mailbox or searches across all if omitted.

### Requirement: List Emails

The system SHALL provide a `list_emails` action that returns recent emails filtered by unread status, sender, date range, folder (inbox, sent, drafts, junk), and configurable limit with sensible defaults.

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

### Requirement: Read Email

The system SHALL provide a `read_email` action that returns the full content of a single email by ID, with the body transformed to token-efficient markdown via the content engine.

#### Scenario: Read email with body and metadata
- **WHEN** `read_email` is called with `{id: "msg123"}`
- **THEN** the system returns the full email body as token-efficient markdown, sender, recipients, subject, timestamp, and attachment list

### Requirement: Search Emails

The system SHALL provide a `search_emails` action that performs full-text search using the provider's native query syntax.

#### Scenario: Search across all mailboxes
- **WHEN** `search_emails` is called with `{query: "contract review", mailbox: null}`
- **THEN** the system searches across all configured mailboxes and returns matching emails with the originating mailbox name

### Requirement: Folder Routing

The system SHALL allow specifying a target folder for list and search operations, defaulting to inbox.

#### Scenario: Include junk folder
- **WHEN** `list_emails` is called with `{folder: "junk"}`
- **THEN** the system returns emails from the junk/spam folder
