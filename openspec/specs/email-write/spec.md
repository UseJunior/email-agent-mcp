---
epic: Email Operations
feature: Write Actions
---

## Purpose

Defines outbound email operations: replying to and sending emails. All outbound operations are gated by the send allowlist. Write actions REQUIRE the `mailbox` parameter when multiple mailboxes are configured to prevent accidentally sending from the wrong account. Supports composing from a local file (`body_file`) for iterative draft editing.

### Requirement: Reply to Email

The system SHALL provide a `reply_to_email` action that replies within an existing thread, preserving In-Reply-To headers and threading metadata. The reply recipient MUST be checked against the send allowlist.

#### Scenario: Reply to allowed sender
- **WHEN** `reply_to_email` is called with `{message_id: "abc", body: "Thanks!"}`
- **AND** the original sender is in the send allowlist
- **THEN** the system creates and sends a reply in the existing thread

#### Scenario: Reply blocked by allowlist
- **WHEN** `reply_to_email` is called with a message from a sender not in the send allowlist
- **THEN** the system returns an error: "Recipient not in send allowlist"

#### Scenario: Mailbox required with multiple accounts
- **WHEN** `reply_to_email` is called without a `mailbox` parameter
- **AND** multiple mailboxes are configured
- **THEN** the system returns an error: "mailbox parameter required when multiple mailboxes are configured"

### Requirement: Send Email

The system SHALL provide a `send_email` action that composes and sends a new email. The recipient MUST be checked against the send allowlist (domain or exact email match).

#### Scenario: Send to allowed domain
- **WHEN** `send_email` is called with `{to: "alice@allowed.com", subject: "Hello", body: "..."}`
- **AND** `*@allowed.com` is in the send allowlist
- **THEN** the system sends the email

#### Scenario: Send blocked by empty allowlist
- **WHEN** `send_email` is called and no send allowlist is configured
- **THEN** the system returns an error: "Send allowlist not configured — all outbound email is disabled"

### Requirement: Body File Composition

The system SHALL accept an optional `body_file` parameter (local file path) as an alternative to the `body` string. File resolution and security validation SHALL occur in email-core action logic, not the MCP transport layer.

#### Scenario: Compose from markdown file
- **WHEN** `send_email` is called with `{body_file: "draft.md", to: "..."}`
- **THEN** the system reads the file, converts markdown to HTML, and uses as the email body

#### Scenario: Path traversal rejected
- **WHEN** `body_file` contains `../` or an absolute path outside the working directory
- **THEN** the system rejects with an error: "body_file must be within the working directory"

#### Scenario: Binary file rejected
- **WHEN** `body_file` points to a binary file (image, PDF)
- **THEN** the system rejects with an error: "body_file must be a text file (.md, .html, .txt)"

#### Scenario: Symlink escape rejected
- **WHEN** `body_file` is a symlink pointing outside the working directory
- **THEN** the system rejects with an error: "body_file symlink targets outside working directory"

#### Scenario: File not found
- **WHEN** `body_file` points to a non-existent file
- **THEN** the system rejects with an error: "body_file not found: draft.md"

#### Scenario: Configured safe directory
- **WHEN** a safe directory is configured via `AGENT_EMAIL_SAFE_DIR` env var
- **THEN** `body_file` paths are resolved relative to that directory

### Requirement: Draft Workflow

The system SHALL support a draft-then-send pattern: create a draft, allow review/modification, then send. For Microsoft Graph, this uses `createReplyAll` to preserve embedded images and CID references.

#### Scenario: Create and send draft
- **WHEN** `send_email` is called with draft mode
- **THEN** the system creates a draft, returns the draft ID for review, and sends on confirmation

### Requirement: Delivery Failure Handling

The system SHALL retry with exponential backoff on transient errors (5xx, network failures). On permanent failure, the system SHALL return a structured error so the agent can inform the user.

#### Scenario: Transient error retry
- **WHEN** a send attempt returns 503
- **THEN** the system retries with exponential backoff (1s, 2s, 4s)

#### Scenario: Permanent failure notification
- **WHEN** a send permanently fails (e.g., invalid recipient)
- **THEN** the system returns `{success: false, error: {code: "INVALID_RECIPIENT", message: "...", recoverable: false}}`

### Requirement: Graceful Body Truncation

The system SHALL truncate oversized email bodies with a user-friendly notice instead of failing. For Graph API, the limit is 3.5MB. Truncation SHALL avoid cutting inside HTML tags.

#### Scenario: Body exceeds size limit
- **WHEN** the email body exceeds 3.5MB
- **THEN** the system truncates and appends: "This response was truncated because it exceeded email size limits."
