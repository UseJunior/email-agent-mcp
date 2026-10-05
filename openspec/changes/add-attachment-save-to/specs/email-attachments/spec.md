## ADDED Requirements

### Requirement: Save Attachment To Disk

`download_attachment` SHALL accept an optional `save_to` directory. When it is supplied, the system SHALL write the decoded attachment bytes inside the server and return `{path, filename, original_filename, mimeType, size, sha256}` without any base64 payload. When it is omitted, the existing inline base64 response SHALL be returned unchanged.

`save_to` SHALL resolve under the same sandbox as `body_file` and `attachments[].path`: relative paths against the safe directory only, and absolute paths within the safe directory or any `AGENT_EMAIL_ALLOWED_DIRS` root. Traversal (`..`), a leading `~`, paths outside every root (`PATH_TRAVERSAL`), and symlink escapes (`SYMLINK_ESCAPE`) SHALL be rejected before any bytes are fetched. Missing subdirectories SHALL be created.

Existing files SHALL never be overwritten. A collision SHALL produce a deterministic numeric suffix (`name-1.ext`, `name-2.ext`, …). The returned `size` and `sha256` SHALL describe the exact bytes written.

#### Scenario: inline response is unchanged when save_to is omitted
- **WHEN** `download_attachment` is called without `save_to`
- **THEN** the response carries inline base64 and nothing is written to disk

#### Scenario: a 15 MB video saved with save_to matches SHA-256 and returns metadata only
- **WHEN** a 15 MB `video/quicktime` attachment is downloaded with `save_to`
- **THEN** the file on disk has the returned size and SHA-256 and the response contains no base64

#### Scenario: inline download above the cap is refused with a save_to hint
- **WHEN** an inline download exceeds `max_size_mb`
- **THEN** the system returns `ATTACHMENT_TOO_LARGE`, marked recoverable, with a message pointing to `save_to`

#### Scenario: collisions are suffixed, never overwritten
- **WHEN** the same attachment is saved twice into the same directory
- **THEN** the second file is written as `name-1.ext` and the first is untouched

#### Scenario: path confinement errors surface before any download
- **WHEN** `save_to` is outside every sandbox root
- **THEN** the system returns `PATH_TRAVERSAL` without calling the provider

### Requirement: Download Message

The system SHALL provide `download_message`, which writes the raw RFC 822 message as stored by the provider (Graph `/$value`, Gmail `format=raw`) to a `save_to` directory under the same sandbox and collision rules as `download_attachment`. It SHALL return `{path, filename, mimeType: "message/rfc822", size, sha256}` and never the bytes. A missing message SHALL return `MESSAGE_NOT_FOUND`.

#### Scenario: writes the as-received MIME named after the subject
- **WHEN** `download_message` is called with `save_to`
- **THEN** the raw bytes are written byte-for-byte to `<sanitized subject>.eml` and the SHA-256 matches

#### Scenario: missing message maps to MESSAGE_NOT_FOUND and writes nothing
- **WHEN** the provider reports the message does not exist
- **THEN** the system returns `MESSAGE_NOT_FOUND` and no file is created
