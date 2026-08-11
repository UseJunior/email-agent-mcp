---
epic: Email Operations
feature: Write Actions
---

## Purpose

Defines outbound email operations: replying to and sending emails. All outbound operations are gated by the send allowlist. Write actions REQUIRE the `mailbox` parameter when multiple mailboxes are configured to prevent accidentally sending from the wrong account. Supports composing from a local file (`body_file`) for iterative draft editing.
## Requirements
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

The system SHALL support a draft-then-send pattern: create a draft, allow review/modification, then send. For Microsoft Graph reply drafts, this uses `createReply` or `createReplyAll` according to `reply_all`, preserving embedded images and CID references on either path.

#### Scenario: Create and send draft
- **WHEN** `send_email` is called with draft mode
- **THEN** the system creates a draft, returns the draft ID for review, and sends on confirmation

#### Scenario: Draft-creating tools return a persisted preview
- **WHEN** `create_draft`, `update_draft`, `reply_to_email` (with `draft: true`), or `send_email` (with `draft: true`) successfully creates or updates a draft
- **THEN** the response includes a `preview` block (`{ to, cc, bcc, subject, body, bodyHtml, bodyTruncated, bodyHtmlTruncated, quotedHistoryOmitted }`) sourced by reading the persisted draft back from the provider, so persistence-layer drops are visible to the caller without a separate `read_email` round trip
- **AND** if the read-back fails after one short retry, the response includes `previewError: { code, message }` instead of `preview`; the underlying create/update success flag is unchanged

### Requirement: Delivery Failure Handling

Delivery operations (`send_email`, `reply_to_email`, `send_draft`) are non-idempotent: the underlying provider endpoints (Graph `POST /sendMail`, draft `/send`, Gmail `users.messages.send`) offer no idempotency key, and a transport failure after the provider accepted the message is indistinguishable from one before it. The system SHALL therefore invoke the provider delivery method exactly once per delivery request at the action layer and SHALL NOT automatically retry a failed delivery, regardless of how transient the failure appears. (A transport-level re-issue of a request rejected with an authentication 401 after a token refresh is permitted: a 401-rejected submission was never accepted, so it cannot duplicate delivery.) On failure, the system SHALL return a structured error so the agent can inform the user, who decides whether to resend.

Scheduled-send submission retains its existing treatment: no automatic retry, and ambiguous outcomes are reported as `SCHEDULE_SEND_STATUS_UNKNOWN` with guidance not to schedule a duplicate.

#### Scenario: Transient delivery failure is not retried
- **WHEN** a send attempt fails with a transient-looking error (e.g. 503, network timeout)
- **THEN** the system makes no further dispatch attempts, because the message may already have been accepted and a retry could deliver a duplicate
- **AND** the system returns a structured error identifying the failure

#### Scenario: Deterministic delivery failure fails fast
- **WHEN** a send attempt fails with a deterministic provider rejection (e.g. HTTP 400 invalid recipient)
- **THEN** the system returns a structured error immediately, without backoff delay

#### Scenario: Permanent failure notification
- **WHEN** a send permanently fails (e.g., invalid recipient)
- **THEN** the system returns `{success: false, error: {code, message, recoverable: false}}`
- **AND** when the provider classified the failure (a `ProviderError`), its code (e.g. `INVALID_RECIPIENT`) is preserved; unclassified provider rejections surface the action's fallback code (e.g. `SEND_FAILED`) pending provider-boundary error normalization (#177)

### Requirement: Graceful Body Truncation

The system SHALL truncate oversized email bodies with a user-friendly notice instead of failing. For Graph API, the limit is 3.5MB. Truncation SHALL avoid cutting inside HTML tags.

#### Scenario: Body exceeds size limit
- **WHEN** the email body exceeds 3.5MB
- **THEN** the system truncates and appends: "This response was truncated because it exceeded email size limits."

### Requirement: Recoverable Mailbox-Required Error

When a write action (`send_email`, `reply_to_email`, `create_draft`, `update_draft`, or `send_draft`) cannot proceed because more than one mailbox is available for action dispatch and no `mailbox` selector was supplied, the returned `MAILBOX_REQUIRED` error SHALL identify the mailbox names that may be used to correct that input.

The payload SHALL include:

- `availableMailboxes`: the `MailboxEntry.name` values represented in the action context, each of which is accepted by the `mailbox` selector. This reflects the mailboxes available for dispatch, which is not necessarily every mailbox on disk — the MCP wrapper supplies only connected mailboxes.
- `defaultMailbox`: the `name` of the entry marked default, omitted when no entry is marked default.
- `recoverable: true`: supplying one of the listed names resolves the `MAILBOX_REQUIRED` condition and allows normal processing to continue. It does not guarantee that the operation will pass unrelated validation, allowlist, or provider checks.

The `code` SHALL remain `MAILBOX_REQUIRED` and the message SHALL remain `mailbox parameter required when multiple mailboxes are configured`, so callers matching on either continue to work. All new fields are additive.

#### Scenario: Mailbox-required error enumerates available mailbox names
- **WHEN** `send_email` is called without `mailbox` and the action context contains available mailboxes named "work" and "personal"
- **THEN** `availableMailboxes` contains "work" and "personal" exactly once each
- **AND** no ordering guarantee is imposed
- **AND** the code and message remain unchanged

#### Scenario: Mailbox-required error is reported as recoverable
- **WHEN** `create_draft` returns `MAILBOX_REQUIRED`
- **THEN** the payload sets `recoverable: true`
- **AND** this means the mailbox-selection error can be corrected, not that all subsequent processing must succeed

#### Scenario: Mailbox-required error names the marked default
- **WHEN** `reply_to_email` returns `MAILBOX_REQUIRED` and "work" is marked default
- **THEN** the payload includes `defaultMailbox: "work"`
- **AND** when no entry is marked default, `defaultMailbox` is omitted

### Requirement: Reply Scope Control

Every reply-producing surface SHALL let the caller choose between a reply-all and a sender-only reply through the same `reply_all` boolean parameter, defaulting to `true`.

This applies to `reply_to_email` (both its send and `draft: true` paths) and to `create_draft` when `reply_to` is set. When `reply_all` is `false`, the system SHALL NOT populate recipients automatically derived from the original thread's To/Cc participants; the reply SHALL address the caller-supplied To (see Reply Recipient Override) plus any Cc recipients the caller supplied explicitly, falling back to the original sender when no To was supplied. Recipients supplied via `cc` SHALL still be honored — `reply_all: false` narrows the *derived* audience, not the caller's stated one.

On `create_draft`, `reply_all` is meaningful only alongside `reply_to`; for a non-reply draft it SHALL have no effect on the composed recipients. This requirement does not alter `create_draft`'s existing required-field validation: `to` and `subject` remain required on every path, including reply drafts.

#### Scenario: Draft reply narrowed to the original sender
- **WHEN** `create_draft` is called with `{reply_to: "msg123", to: "sender@example.com", subject: "Re: Topic", body: "…", reply_all: false}` for a thread containing additional To/Cc participants
- **THEN** the provider's reply-draft call receives `replyAll: false`
- **AND** the created draft addresses the original sender plus any caller-supplied Cc recipients, but omits automatically derived thread participants

#### Scenario: Draft reply defaults to reply-all
- **WHEN** `create_draft` is called with `{reply_to: "msg123", to: "sender@example.com", subject: "Re: Topic", body: "…"}` and no `reply_all`
- **THEN** the provider's reply-draft call receives `replyAll: true`, preserving existing behavior

#### Scenario: Explicit cc survives a narrowed draft reply
- **WHEN** `create_draft` is called with `{reply_to: "msg123", to: "sender@example.com", subject: "Re: Topic", body: "…", reply_all: false, cc: ["alice@example.com"]}`
- **THEN** the provider's reply-draft call receives `replyAll: false` and still carries `alice@example.com` on Cc

#### Scenario: Send-path reply honors the same toggle
- **WHEN** `reply_to_email` is called with `{message_id: "msg123", body: "…", reply_all: false}`
- **THEN** the reply is addressed only to the original sender, with the thread's other participants omitted

### Requirement: Reply Recipient Override

`create_draft` requires `to` on every path, so on the reply path it SHALL forward those recipients to the provider rather than discarding them. `ReplyOptions` SHALL carry an optional `to` list for this purpose.

An explicit `to` SHALL **replace** the provider-derived To rather than merge with it, unlike `cc`, which merges with the thread's. Replacing is what makes redirecting a thread to a different recipient expressible, and it matches what `to` means on every other compose surface.

Replacing the To line SHALL NOT drop recipients. Under reply-all, providers SHALL move participants displaced from the To line onto Cc, so the effective audience of a reply-all is never narrowed by supplying `to`; a recipient now addressed on To SHALL NOT also appear on Cc. Under `reply_all: false` nothing is preserved — narrowing to an explicit recipient set is the point.

When `to` is absent or empty, providers SHALL leave their derived To untouched: Microsoft omits `toRecipients` from the follow-up PATCH so Graph's auto-populated recipients stand, and Gmail addresses the original sender. `reply_to_email` has no `to` input and therefore SHALL continue to use the provider-derived To on both its send and draft paths.

This override SHALL NOT weaken send gating. `create_draft` bypasses the send allowlist by design; `send_draft` re-reads the stored draft's own To/Cc/Bcc, so a caller-supplied reply To is gated at send time exactly like the To of a non-reply draft.

#### Scenario: Reply draft to a self-sent message honors caller-supplied to (issue #164)
- **WHEN** `create_draft` is called with `{reply_to: "<id of a message the mailbox owner sent>", to: "recipient@example.com", cc: ["someone-else@example.com"], subject: "Re: Topic", body: "…", reply_all: false}`
- **THEN** the created draft is addressed to `recipient@example.com`
- **AND** the mailbox owner's own address, which the provider would otherwise derive from the parent's sender, is absent from the To list

#### Scenario: Reply draft with multiple to recipients forwards all of them (issue #164)
- **WHEN** `create_draft` is called on the reply path with several `to` entries, including one in name-address form
- **THEN** every parsed recipient reaches the provider in order, with display names preserved

#### Scenario: Reply draft to blocked recipient is still gated at send_draft time (issue #164)
- **WHEN** a reply draft is created with a `to` outside the send allowlist, and `send_draft` is then called on it
- **THEN** `create_draft` succeeds, `send_draft` returns `ALLOWLIST_BLOCKED`, and nothing is sent

#### Scenario: reply_to_email draft keeps the provider-derived To (issue #164 no-op guard)
- **WHEN** `reply_to_email` is called with `{message_id: "msg123", body: "…", draft: true}`
- **THEN** no `to` is passed to the provider and the draft is addressed to the original sender, unchanged

### Requirement: Authored-Only Reply Draft Preview

For recognized Microsoft reply drafts, the `preview.bodyHtml` returned by `create_draft`, `update_draft`, and `reply_to_email` (with `draft: true`) SHALL contain only the authored portion of the body by default, omitting the thread history the provider assembles automatically. The preview SHALL set `quotedHistoryOmitted: true` only when it actually omits that history, so the caller can distinguish an authored-only preview from a message that simply had no quoted history.

These surfaces SHALL accept an optional `include_quoted` boolean, defaulting to `false`. When `true`, the full persisted preview SHALL be returned exactly as before, subject to the existing per-field size cap and truncation flags. `send_email` (with `draft: true`) is outside this requirement and SHALL retain its existing preview behavior.

The authored region SHALL be represented provider-neutrally: a provider MAY populate an optional authored-body field on the message it returns, using a verified provider signal for the unique portion of a message or its own unambiguous reply-boundary detection, and SHALL leave that field unset when neither source is safe. Preview construction SHALL consume only that field and SHALL NOT contain provider-specific parsing. It SHALL treat the preview as authored-only only when the calling action requested it, the field is present, and its value differs from the persisted body.

When no authored region can be identified with confidence, the system SHALL **fail open**: return the full persisted preview and leave `quotedHistoryOmitted` unset. Authored HTML that happens to contain a horizontal rule or similar markup SHALL NOT be treated as a reply boundary.

This requirement governs the preview only. The body stored in the draft and the body ultimately sent SHALL be unchanged, and preview content SHALL continue to come from the persisted draft read back from the provider, never from the request payload. Fresh (non-reply) drafts and Gmail-created drafts SHALL retain their current preview behavior and SHALL NOT be subjected to extraction.

#### Scenario: Microsoft reply draft preview omits quoted history by default
- **WHEN** `create_draft` is called with `{reply_to: "msg123", to: "sender@example.com", subject: "Re: Topic", body: "Quick note."}` against a Microsoft mailbox and the resulting draft contains the provider's assembled thread history
- **THEN** `preview.bodyHtml` contains only the persisted authored content
- **AND** `preview.quotedHistoryOmitted` is `true`

#### Scenario: include_quoted returns the full persisted preview
- **WHEN** the same call is made with `include_quoted: true`
- **THEN** `preview.bodyHtml` contains the full persisted body including the quoted thread, subject to the existing size cap and `bodyHtmlTruncated` flag
- **AND** `quotedHistoryOmitted` is not set

#### Scenario: Preview omission does not mutate the persisted draft
- **WHEN** a Microsoft reply draft produces an authored-only preview
- **THEN** the provider message used for the persisted read-back still contains the complete quoted thread in `bodyHtml`
- **AND** building the preview performs no provider write that removes or replaces that history

#### Scenario: Ambiguous body anatomy fails open to the full preview
- **WHEN** a Microsoft reply draft is read back with no authored-body field populated, because neither a provider signal nor an unambiguous reply boundary was available
- **THEN** `preview.bodyHtml` contains the full persisted body
- **AND** `quotedHistoryOmitted` is not set, so the caller is never told content was omitted when the system could not identify it

#### Scenario: Gmail and fresh drafts are unaffected
- **WHEN** a draft is created on Gmail, or a non-reply draft is created on any provider
- **THEN** the preview is returned unchanged from current behavior with no extraction attempted and `quotedHistoryOmitted` unset

