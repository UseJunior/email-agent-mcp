## MODIFIED Requirements

### Requirement: Reply-All Controls

Every reply-producing surface SHALL let the caller choose between a reply-all and a sender-only reply through the same `reply_all` boolean parameter, defaulting to `true`.

This applies to `reply_to_email` (both its send and `draft: true` paths) and to `create_draft` when `reply_to` is set. When `reply_all` is `false`, the system SHALL NOT populate recipients automatically derived from the original thread's To/Cc participants; the reply SHALL address the caller-supplied To (see Reply Recipient Override) plus any Cc recipients the caller supplied explicitly, falling back to the original sender when no To was supplied. Recipients supplied via `cc` SHALL still be honored — `reply_all: false` narrows the *derived* audience, not the caller's stated one.

On `create_draft`, `reply_all` is meaningful only alongside `reply_to`; for a non-reply draft it SHALL have no effect on the composed recipients. New drafts SHALL require both `to` and `subject`. Reply drafts SHALL require `to` but SHALL NOT require or use a caller-supplied `subject`; the provider SHALL derive the subject from the parent message.

#### Scenario: Draft reply narrowed to the original sender
- **WHEN** `create_draft` is called with `{reply_to: "msg123", to: "sender@example.com", body: "…", reply_all: false}` for a thread containing additional To/Cc participants
- **THEN** the provider's reply-draft call receives `replyAll: false`

#### Scenario: Draft reply defaults to reply-all
- **WHEN** `create_draft` is called with `{reply_to: "msg123", to: "sender@example.com", body: "…"}` and no `reply_all`
- **THEN** the provider's reply-draft call receives `replyAll: true`, preserving existing behavior

#### Scenario: Explicit cc survives a narrowed draft reply
- **WHEN** `create_draft` is called with `{reply_to: "msg123", to: "sender@example.com", body: "…", reply_all: false, cc: ["alice@example.com"]}`
- **THEN** the provider's reply-draft call receives `replyAll: false` and still carries `alice@example.com` on Cc

#### Scenario: Reply draft derives its subject
- **WHEN** `create_draft` is called with `reply_to`, `to`, and a body but no `subject`
- **THEN** the reply draft is created with the provider-derived parent-thread subject

#### Scenario: Send-path reply honors the same toggle
- **WHEN** `reply_to_email` is called with `{message_id: "msg123", body: "…", reply_all: false}`
- **THEN** the reply is addressed only to the original sender, with the thread's other participants omitted
