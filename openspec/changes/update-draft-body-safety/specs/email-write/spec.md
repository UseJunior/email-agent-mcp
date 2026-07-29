## MODIFIED Requirements

### Requirement: Draft Workflow

The system SHALL support a draft-then-send pattern: create a draft, allow review/modification, then send. For Microsoft Graph reply drafts, this uses `createReply` or `createReplyAll` according to `reply_all`, preserving embedded images and CID references on either path.

Body edits on an existing draft are constrained by whether that draft carries quoted history. When `update_draft` is called with `body` or `body_file` on a **reply** draft, the system SHALL return a recoverable structured error and SHALL NOT modify the body, because the authored content cannot be separated from the provider's auto-quoted thread without a body heuristic that is not sound across mail clients. The error SHALL name the remedy: create a new draft. When `update_draft` is called with `body` on a **non-reply** draft — where there is no quoted history to protect — the system SHALL replace the body wholesale, and SHALL require the caller to pass `replace_body: true` so the replacement is explicit.

Fields other than the body remain editable on any draft. `subject`, `attachments`, `to` and `cc` SHALL be accepted on reply and non-reply drafts alike. Changing `subject` on a reply draft SHALL be permitted and SHALL emit a non-blocking warning that altering a reply's subject may break threading in clients that group by subject; it SHALL NOT be refused.

#### Scenario: Create and send draft
- **WHEN** `send_email` is called with draft mode
- **THEN** the system creates a draft, returns the draft ID for review, and sends on confirmation

#### Scenario: Draft-creating tools return a persisted preview
- **WHEN** `create_draft`, `update_draft`, `reply_to_email` (with `draft: true`), or `send_email` (with `draft: true`) successfully creates or updates a draft
- **THEN** the response includes a `preview` block (`{ to, cc, bcc, subject, body, bodyHtml, bodyTruncated, bodyHtmlTruncated, quotedHistoryOmitted }`) sourced by reading the persisted draft back from the provider, so persistence-layer drops are visible to the caller without a separate `read_email` round trip
- **AND** if the read-back fails after one short retry, the response includes `previewError: { code, message }` instead of `preview`; the underlying create/update success flag is unchanged

#### Scenario: Body edit on a reply draft is refused
- **WHEN** `update_draft` is called with a `body` on a draft created as a reply
- **THEN** the response is `{ success: false, error: { code: "REPLY_DRAFT_BODY_IMMUTABLE", recoverable: true } }`
- **AND** the stored draft body is unchanged
- **AND** the message directs the caller to create a new draft instead

#### Scenario: Body edit on a non-reply draft requires explicit opt-in
- **WHEN** `update_draft` is called with a `body` on a draft that is not a reply, and `replace_body` is not set
- **THEN** the response is a recoverable error identifying `replace_body: true` as the required opt-in
- **AND** when the same call is repeated with `replace_body: true`, the body is replaced wholesale and the call succeeds

#### Scenario: Subject rename on a reply draft is permitted with a warning
- **WHEN** `update_draft` is called on a reply draft with only a `subject` change
- **THEN** the call succeeds and the stored subject is updated
- **AND** the response includes a non-blocking warning that changing a reply's subject may break threading
- **AND** the body and quoted history are unchanged

#### Scenario: Non-body fields remain editable on a reply draft
- **WHEN** `update_draft` is called on a reply draft with `attachments`, `to`, or `cc` and no `body`
- **THEN** the call succeeds and the quoted history is preserved byte-for-byte

## ADDED Requirements

### Requirement: Non-Blocking Warnings on Draft Writes

Draft-write actions SHALL be able to report advisories that do not prevent the operation from succeeding. When such an advisory applies, the response SHALL include a `warnings` array alongside the success flag, each entry carrying a stable `code` and a human-readable `message`.

Warnings SHALL NOT change the success flag and SHALL NOT be used for conditions that prevent the write — those remain structured errors. The array SHALL be omitted or empty when no advisory applies, so callers can treat its presence as meaningful.

#### Scenario: Warning accompanies a successful write
- **WHEN** a draft-write action succeeds but an advisory applies
- **THEN** the response has `success: true` and a `warnings` array containing at least one `{ code, message }` entry

#### Scenario: No warnings key on an unremarkable write
- **WHEN** a draft-write action succeeds with no advisory
- **THEN** the response contains no `warnings` entries
