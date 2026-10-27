## ADDED Requirements

### Requirement: Large Attachment Upload Sessions

The Microsoft provider SHALL support individual outbound file attachments up to 25 MiB. It SHALL use `createUploadSession` and sequential chunked PUT requests for files above the Graph inline attachment threshold, and SHALL use a draft-first flow when a direct-send payload cannot safely carry its attachments inline.

#### Scenario: Large direct send
- **WHEN** a direct send contains an attachment above the inline threshold and no larger than 25 MiB
- **THEN** the provider creates a draft without inline attachments, uploads the file through an attachment upload session, and sends the draft

#### Scenario: Upload chunks
- **WHEN** an attachment upload session is used
- **THEN** each non-final PUT chunk has a size that is a multiple of 320 KiB and carries the correct `Content-Range`

#### Scenario: Large draft attachment
- **WHEN** a draft creation, reply draft, or draft update contains an attachment above the inline threshold
- **THEN** the provider uploads it through an attachment upload session and leaves the completed message as a draft
