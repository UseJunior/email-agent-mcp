## MODIFIED Requirements

### Requirement: Size and Type Validation

The system SHALL validate each outbound attachment against a maximum size of 25 MiB and MIME type against a configurable allowlist. An attachment of exactly 25 MiB SHALL be accepted. An oversized or disallowed attachment SHALL be rejected before provider upload with a clear typed error.

#### Scenario: Oversized attachment rejected
- **WHEN** an outbound attachment is larger than 25 MiB
- **THEN** the system returns `ATTACHMENT_TOO_LARGE` with a message that identifies the 25 MB maximum

#### Scenario: Attachment at the limit accepted
- **WHEN** an outbound attachment is exactly 25 MiB
- **THEN** size validation accepts it for provider upload
