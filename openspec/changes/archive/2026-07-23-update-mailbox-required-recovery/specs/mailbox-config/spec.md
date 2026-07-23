## ADDED Requirements

### Requirement: Mailbox Names Are Round-Trippable Selectors

A mailbox `name` surfaced as an available action selector SHALL be accepted verbatim by every action's `mailbox` parameter. This name is a round-trippable selector; it does not replace the email address as the canonical mailbox identity defined by Mailbox Canonical Identity.

#### Scenario: Mailbox name from an error is accepted on retry
- **WHEN** a write action returns `MAILBOX_REQUIRED` with an available mailbox name "work"
- **AND** the same call is retried with `{mailbox: "work"}`
- **THEN** action dispatch selects the "work" mailbox
- **AND** the retry does not return `MAILBOX_REQUIRED`
