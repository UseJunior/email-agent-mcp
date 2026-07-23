## ADDED Requirements

### Requirement: Optional Scheduled Sender Capability

The provider abstraction SHALL define an optional `EmailScheduledSender` capability with methods to schedule a new message, schedule an existing draft, list pending scheduled sends, and cancel a pending scheduled send. `EmailProvider` SHALL compose this capability through `Partial<>`, so providers without public scheduled-send APIs remain source-compatible.

#### Scenario: Scheduling capability is dispatched when present
- **WHEN** a selected provider implements `EmailScheduledSender`
- **THEN** scheduled-send actions call that capability with a UTC timestamp
- **AND** immediate `EmailSender` methods remain unchanged

#### Scenario: Missing capability is reported without mutation
- **WHEN** the selected provider does not implement `EmailScheduledSender`
- **THEN** scheduled-send actions return `NOT_SUPPORTED`
- **AND** no fallback timer or immediate send is attempted
