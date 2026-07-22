## ADDED Requirements

### Requirement: Reply Scope Control

Every reply-producing surface SHALL let the caller choose between a reply-all and a sender-only reply through the same `reply_all` boolean parameter, defaulting to `true`.

This applies to `reply_to_email` (both its send and `draft: true` paths) and to `create_draft` when `reply_to` is set. When `reply_all` is `false`, the system SHALL NOT populate recipients automatically derived from the original thread's To/Cc participants; the reply SHALL address the original sender plus any Cc recipients the caller supplied explicitly. There is no provider-level override for the reply To list — `ReplyOptions` carries `cc`, `bcc`, `attachments`, `bodyHtml`, and `replyAll`, but no `to` — so a caller-supplied `to` does NOT add reply recipients. Recipients supplied via `cc` SHALL still be honored — `reply_all: false` narrows the *derived* audience, not the caller's stated one.

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

## MODIFIED Requirements

### Requirement: Draft Workflow

The system SHALL support a draft-then-send pattern: create a draft, allow review/modification, then send. For Microsoft Graph reply drafts, this uses `createReply` or `createReplyAll` according to `reply_all`, preserving embedded images and CID references on either path.

#### Scenario: Create and send draft
- **WHEN** `send_email` is called with draft mode
- **THEN** the system creates a draft, returns the draft ID for review, and sends on confirmation

#### Scenario: Draft-creating tools return a persisted preview
- **WHEN** `create_draft`, `update_draft`, `reply_to_email` (with `draft: true`), or `send_email` (with `draft: true`) successfully creates or updates a draft
- **THEN** the response includes a `preview` block (`{ to, cc, subject, body, bodyHtml, bodyTruncated, bodyHtmlTruncated }`) sourced by reading the persisted draft back from the provider, so persistence-layer drops are visible to the caller without a separate `read_email` round trip
- **AND** if the read-back fails after one short retry, the response includes `previewError: { code, message }` instead of `preview`; the underlying create/update success flag is unchanged
