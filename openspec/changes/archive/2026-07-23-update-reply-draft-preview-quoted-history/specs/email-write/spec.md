## MODIFIED Requirements

### Requirement: Draft Workflow

The system SHALL support a draft-then-send pattern: create a draft, allow review/modification, then send. For Microsoft Graph reply drafts, this uses `createReply` or `createReplyAll` according to `reply_all`, preserving embedded images and CID references on either path.

#### Scenario: Create and send draft
- **WHEN** `send_email` is called with draft mode
- **THEN** the system creates a draft, returns the draft ID for review, and sends on confirmation

#### Scenario: Draft-creating tools return a persisted preview
- **WHEN** `create_draft`, `update_draft`, `reply_to_email` (with `draft: true`), or `send_email` (with `draft: true`) successfully creates or updates a draft
- **THEN** the response includes a `preview` block (`{ to, cc, bcc, subject, body, bodyHtml, bodyTruncated, bodyHtmlTruncated, quotedHistoryOmitted }`) sourced by reading the persisted draft back from the provider, so persistence-layer drops are visible to the caller without a separate `read_email` round trip
- **AND** if the read-back fails after one short retry, the response includes `previewError: { code, message }` instead of `preview`; the underlying create/update success flag is unchanged

## ADDED Requirements

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
