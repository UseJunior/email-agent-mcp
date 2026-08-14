## MODIFIED Requirements

### Requirement: Reply Scope Control

Every reply-producing surface SHALL let the caller choose between a reply-all and a sender-only reply through the same `reply_all` boolean parameter, defaulting to `true`.

This applies to `reply_to_email` (both its send and `draft: true` paths) and to `create_draft` when `reply_to` is set. When `reply_all` is `false`, the system SHALL NOT populate recipients automatically derived from the original thread's To/Cc participants; the reply SHALL address the caller-supplied To (see Reply Recipient Override) plus any Cc recipients the caller supplied explicitly, falling back to the original sender when no To was supplied. Recipients supplied via `cc` SHALL still be honored — `reply_all: false` narrows the *derived* audience, not the caller's stated one.

On `create_draft`, `reply_all` is meaningful only alongside `reply_to`; for a non-reply draft it SHALL have no effect on the composed recipients. New drafts SHALL require both `to` and `subject`. Reply drafts SHALL require neither: the provider SHALL derive the subject from the parent message, and SHALL derive the recipients from the parent message under `reply_all` whenever the caller supplies no `to`.

#### Scenario: Draft reply narrowed to the original sender
- **WHEN** `create_draft` is called with `{reply_to: "msg123", to: "sender@example.com", body: "…", reply_all: false}` for a thread containing additional To/Cc participants
- **THEN** the provider's reply-draft call receives `replyAll: false`
- **AND** the created draft addresses the original sender plus any caller-supplied Cc recipients, but omits automatically derived thread participants

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

### Requirement: Reply Recipient Override

`create_draft` accepts an optional `to` on the reply path and SHALL forward those recipients to the provider rather than discarding them. `ReplyOptions` SHALL carry an optional `to` list for this purpose.

An explicit `to` SHALL **replace** the provider-derived To rather than merge with it, unlike `cc`, which merges with the thread's. Replacing is what makes redirecting a thread to a different recipient expressible, and it matches what `to` means on every other compose surface.

Replacing the To line SHALL NOT drop recipients. Under reply-all, providers SHALL move participants displaced from the To line onto Cc, so the effective audience of a reply-all is never narrowed by supplying `to`; a recipient now addressed on To SHALL NOT also appear on Cc. Under `reply_all: false` nothing is preserved — narrowing to an explicit recipient set is the point.

When `to` is absent or empty, providers SHALL leave their derived To untouched: Microsoft omits `toRecipients` from the follow-up PATCH so Graph's auto-populated recipients stand, and Gmail addresses the original sender. `create_draft` SHALL therefore pass no `to` to the provider when the caller supplied none, rather than rejecting the call. `reply_to_email` has no `to` input and therefore SHALL continue to use the provider-derived To on both its send and draft paths.

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

#### Scenario: Reply-all draft without to derives its recipients (issue #192)
- **WHEN** `create_draft` is called with `{reply_to: "msg123", reply_all: true, body: "Thanks."}` and no `to`
- **THEN** the draft is created successfully, no `to` reaches the provider, and the provider-derived reply-all recipients stand

#### Scenario: Sender-only draft without to targets the original sender (issue #192)
- **WHEN** `create_draft` is called with `{reply_to: "msg123", reply_all: false, body: "Thanks."}` and no `to`
- **THEN** the draft is created successfully and addresses only the parent message's sender

#### Scenario: Non-reply draft still requires to (issue #192)
- **WHEN** `create_draft` is called without `reply_to` and without `to`
- **THEN** the call fails with `MISSING_FIELD`
