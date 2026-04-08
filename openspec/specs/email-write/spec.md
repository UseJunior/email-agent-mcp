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

The system SHALL accept an optional `body_file` parameter (local file path) as an alternative to the `body` string. File resolution and security validation SHALL occur in email-core action logic, not the MCP transport layer. When the file is markdown, the system SHALL render it to HTML before sending (see Body Rendering).

#### Scenario: Compose from markdown file
- **WHEN** `send_email` is called with `{body_file: "draft.md", to: "..."}`
- **THEN** the system reads the file, renders the markdown to HTML, and ships both the raw source (as plain-text fallback) and the rendered HTML to the provider

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

#### Scenario: Frontmatter format override
- **WHEN** `body_file` frontmatter declares `format: text`
- **THEN** the system sends the body as plain text without rendering, preserving newlines verbatim

### Requirement: Body Rendering

The `send_email`, `create_draft`, `update_draft`, and `reply_to_email` actions SHALL accept an optional `format` parameter — one of `"markdown" | "html" | "text"`, defaulting to `"markdown"` — and an optional `force_black` boolean defaulting to `true`. When `format` is `"markdown"`, the system SHALL render the body as GitHub Flavored Markdown with single-newline-to-`<br>` conversion. When `format` is `"html"`, the system SHALL treat the body as pre-rendered HTML and pass it through. When `format` is `"text"`, the system SHALL send the body as plain text with no rendering. For `"markdown"` and `"html"`, the rendered output SHALL be wrapped in `<div style="color: #000000;">…</div>` by default so Outlook dark mode does not invert body text to unreadable white-on-white; callers SHALL be able to opt out via `force_black: false`.

#### Scenario: Markdown rendering by default
- **WHEN** `send_email` is called with `body: "### Header\n\n**bold** text"` and no `format` parameter
- **THEN** the recipient sees `Header` rendered as an `<h3>` and `bold` in bold, not as literal `###` and `**`
- **AND** the raw markdown is preserved in the provider's plain-text body field

#### Scenario: Single newlines preserved as line breaks
- **WHEN** `send_email` is called with `body: "line one\nline two\nline three"`
- **THEN** the recipient sees each line on its own line (rendered as `<br>`-separated content, not a single collapsed paragraph)

#### Scenario: GFM tables render
- **WHEN** `send_email` is called with a body containing a markdown pipe-table
- **THEN** the recipient sees a rendered HTML `<table>`

#### Scenario: format text bypasses rendering
- **WHEN** `send_email` is called with `{body: "### Literal", format: "text"}`
- **THEN** the recipient sees the characters `### Literal` verbatim as plain text

#### Scenario: format html passthrough
- **WHEN** `send_email` is called with `{body: "<h1>Pre-rendered</h1>", format: "html"}`
- **THEN** the system ships the HTML without re-rendering

#### Scenario: Raw HTML embedded in markdown is preserved
- **WHEN** `send_email` is called with a markdown body containing `<a href="https://example.com">link</a>`
- **THEN** the rendered output preserves the anchor tag verbatim

#### Scenario: force_black wrapper default
- **WHEN** any write action renders a body to HTML and `force_black` is unset
- **THEN** the rendered HTML is wrapped in `<div style="color: #000000;">…</div>`

#### Scenario: force_black opt-out
- **WHEN** any write action is called with `force_black: false`
- **THEN** the rendered HTML is NOT wrapped in the force-black div

#### Scenario: Frontmatter format is authoritative
- **WHEN** `body_file` frontmatter contains `format: text` and the action call contains `format: markdown`
- **THEN** the system uses `text` (frontmatter overrides action parameters)

#### Scenario: reply_to_email also renders
- **WHEN** `reply_to_email` is called with a markdown body
- **THEN** the reply is sent with the markdown rendered to HTML, matching `send_email` behavior

#### Scenario: create_draft and update_draft also render
- **WHEN** `create_draft` or `update_draft` is called with a markdown body
- **THEN** the draft stored on the provider contains the rendered HTML and can be sent later without re-rendering

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
