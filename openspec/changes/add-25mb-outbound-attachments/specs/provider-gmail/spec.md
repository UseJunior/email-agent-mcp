## ADDED Requirements

### Requirement: Large Raw MIME Uploads

The Gmail provider SHALL support individual outbound file attachments up to 25 MiB by sending the composed RFC 822 message through Gmail's media upload path. Messages whose raw MIME bytes exceed 5 MiB SHALL use multipart media upload for sends and draft create/update operations.

#### Scenario: Large message send
- **WHEN** a composed RFC 822 message exceeds 5 MiB
- **THEN** `messages.send` receives `message/rfc822` media through a multipart upload rather than an inline JSON `raw` field

#### Scenario: Large draft create or update
- **WHEN** a composed draft exceeds 5 MiB
- **THEN** `drafts.create` or `drafts.update` receives `message/rfc822` media through a multipart upload while preserving thread metadata
