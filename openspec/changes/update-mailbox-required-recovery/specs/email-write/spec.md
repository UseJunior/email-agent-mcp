## ADDED Requirements

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
