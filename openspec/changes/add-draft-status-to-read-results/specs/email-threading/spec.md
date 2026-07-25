## ADDED Requirements

### Requirement: Draft Status on Thread Messages

A conversation thread commonly mixes delivered messages with an unsent draft reply the user has not sent yet. Each message row returned by `get_thread` SHALL carry an always-present `isDraft` boolean with the same semantics as on `list_emails` and `search_emails` rows: `true` for an unsent draft, `false` otherwise, never omitted.

Without it, a thread read renders a draft reply as though the user had already replied — the most consequential place for the confusion, because the draft is the newest message in the thread and reads as the conversation's outcome. `isDraft: true` on a thread message means only that this message is not a sent reply; earlier sent replies from the same author may still exist elsewhere in the thread.

#### Scenario: Thread with an unsent draft reply labels the draft
- **WHEN** `get_thread` returns a conversation whose most recent message is an unsent draft reply
- **THEN** that message row includes `isDraft: true`
- **AND** the delivered messages in the same thread include `isDraft: false`
