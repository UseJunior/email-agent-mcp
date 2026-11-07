## ADDED Requirements

### Requirement: Optional Scheduled Sender Capability

The provider abstraction SHALL define an optional `EmailScheduledSender` capability with methods to schedule a new message, schedule an existing draft, list pending scheduled sends, and cancel a pending scheduled send. `EmailProvider` SHALL compose this capability through `Partial<>`, so providers without public scheduled-send APIs remain source-compatible.

`ScheduledSendResult` SHALL retain all existing fields, with optional internal workflow evidence for preparation (`draft_created`, `attachments_ready`, `deferred_property_set`), dispatching, and terminal accepted/rejected/unknown outcomes. Existing implementations returning legacy results remain source-compatible. Actions SHALL explicitly project existing wire fields without exposing workflow evidence. No exported method is removed or replaced, so no deprecated adapter is required.

#### Scenario: Scheduling capability is dispatched when present
- **WHEN** a selected provider implements `EmailScheduledSender`
- **THEN** scheduled-send actions call that capability with a UTC timestamp
- **AND** immediate `EmailSender` methods remain unchanged

#### Scenario: Missing capability is reported without mutation
- **WHEN** the selected provider does not implement `EmailScheduledSender`
- **THEN** scheduled-send actions return `NOT_SUPPORTED`
- **AND** no fallback timer or immediate send is attempted
