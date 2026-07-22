---
epic: Email Operations
feature: Read Actions
---

## Purpose

Defines read-only email operations: listing, reading, and searching emails across one or more configured mailboxes. All actions accept an optional `mailbox` parameter that defaults to the default mailbox or searches across all if omitted.
## Requirements
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

The response SHALL surface recipient topology — `to`, `cc`, and `bcc` — as explicit arrays of `Name <email>` strings, returning an empty array `[]` (never a missing key) when a field has no recipients, so a caller can distinguish "no Cc recipients" from "Cc not reported." `bcc` is only populated on the sender's own copy of a message and is otherwise `[]`.

#### Scenario: Read email with body and metadata
- **WHEN** `read_email` is called with `{id: "msg123"}`
- **THEN** the system returns the full email body as token-efficient markdown, sender, recipients, subject, timestamp, and attachment list

#### Scenario: Cc and Bcc recipients are always reported
- **WHEN** `read_email` is called for a message with Cc (and, on the sender's copy, Bcc) recipients
- **THEN** the response includes `cc` (and `bcc`) as arrays of `Name <email>` entries
- **AND** when a message has no Cc or Bcc recipients, `cc` and `bcc` are returned as empty arrays `[]` rather than omitted

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

### Requirement: Optional Quoted-History Stripping

The `read_email` action SHALL accept an optional `strip_quoted_history` boolean parameter. When `true`, the system SHALL detect a terminal quoted-history block — Gmail/Apple "On … wrote:" preambles, Outlook `From:/Sent:/Date:/To:/Subject:` header clusters, an Outlook-2003 `-----Original Message-----` separator followed by an Outlook header cluster, or a terminal run of `>`-prefix lines — and replace it with a single short marker (e.g. `[...prior thread truncated]`). The candidate block SHALL only be stripped when it is genuinely terminal: an inline `On … wrote:` quote followed by user-authored prose SHALL NOT be stripped. When omitted or `false`, the body SHALL be returned unchanged from current behavior. Inline blockquotes appearing within the latest reply SHALL be preserved; only a terminal quoted-history block SHALL be stripped.

The detector is English-only: localized "On … wrote:" preambles (German "Am … schrieb …", French "Le … a écrit", Japanese "送信者:" headers, etc.) are NOT matched. Threads from non-English clients SHALL be returned with full quoted history.

#### Scenario: Strip quoted history when flag is true
- **WHEN** `read_email` is called with `{id: "msg123", strip_quoted_history: true}` and the email body contains a Gmail "On … wrote:" preamble followed by a multi-line `>`-prefix quoted reply
- **THEN** the returned body has the preamble and quoted reply replaced with the marker `[...prior thread truncated]`
- **AND** the latest reply text and any non-quoted user content above the preamble are preserved

#### Scenario: Default behavior is unchanged
- **WHEN** `read_email` is called with `{id: "msg123"}` (flag omitted) on the same email
- **THEN** the returned body is identical to current behavior — full quoted history is included

#### Scenario: Inline blockquote in latest reply is preserved
- **WHEN** `read_email` is called with `{id: "msg123", strip_quoted_history: true}` on an email whose latest reply contains a markdown blockquote (`> note:` line) followed by more user-authored text and no terminal quoted-history block
- **THEN** the returned body is unchanged and no marker is inserted

#### Scenario: Inline "On … wrote:" with user prose after is preserved
- **WHEN** `read_email` is called with `{id: "msg123", strip_quoted_history: true}` on a body that contains an `On … wrote:` preamble and `>`-quoted block in the middle, followed by additional user-authored prose
- **THEN** the returned body is unchanged and no marker is inserted

