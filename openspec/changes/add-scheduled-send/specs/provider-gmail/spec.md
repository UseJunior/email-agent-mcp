## ADDED Requirements

### Requirement: Scheduled Send Is Explicitly Unsupported

The Gmail provider integration SHALL NOT emulate Gmail web scheduled-send with private endpoints or an in-process timer. Because the public Gmail API exposes no scheduled-send operation, the email-core scheduled-send actions SHALL report the missing capability as `NOT_SUPPORTED` while leaving immediate Gmail send and draft behavior unchanged.

#### Scenario: Gmail scheduling makes no Gmail API request
- **WHEN** a caller requests future delivery, listing, or cancellation on Gmail
- **THEN** the system returns `NOT_SUPPORTED`
- **AND** no Gmail send, draft, modify, or delete request is issued
