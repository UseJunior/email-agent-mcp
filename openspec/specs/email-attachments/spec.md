---
epic: Email Operations
feature: Attachment Handling
---

## Purpose

Defines attachment operations: downloading from inbound emails, attaching to outbound emails, embedded image handling, binary file detection, filename sanitization, and size/type validation. Outbound attachments are file-based only (no CID embedding in v1).

### Requirement: Download Attachments

The system SHALL download attachments from inbound emails using provider-specific retrieval and return metadata (filename, MIME type, size, contentId).

#### Scenario: List attachments
- **WHEN** `read_email` returns an email with attachments
- **THEN** each attachment includes `{id, filename, mimeType, size, contentId, isInline}`

### Requirement: Inline Image Handling

The system SHALL preserve CID references (`<img src="cid:...">`) in HTML email bodies as markdown image links during content transformation. The agent can correlate CID values with attachment metadata from `list_attachments`. Full resolution to attachment content is planned for a future phase.

#### Scenario: Embedded image in HTML body
- **WHEN** an email body contains `<img src="cid:image001">`
- **THEN** the content engine converts it to `![](cid:image001)` in the markdown output
- **AND** the agent can look up `contentId: "image001"` via `list_attachments`

### Requirement: Attach Files to Outbound

The system SHALL accept file attachments for outbound emails from a local file path or buffer. No CID embedding in v1 — email clients will show attachments inline if appropriate.

#### Scenario: Attach file to reply
- **WHEN** `reply_to_email` is called with `{attachments: [{path: "/tmp/report.pdf"}]}`
- **THEN** the system base64-encodes the file and includes it as a Graph/Gmail attachment

### Requirement: Size and Type Validation

The system SHALL validate attachment size (default max 25MB) and MIME type against a configurable allowlist. Reject oversized or disallowed types with clear errors.

#### Scenario: Oversized attachment rejected
- **WHEN** an attachment exceeds 25MB
- **THEN** the system returns an error: "Attachment exceeds maximum size of 25MB"

### Requirement: Binary File Detection

The system SHALL validate file content by checking actual bytes (null byte check + magic byte signatures), not declared content type alone. This prevents binary-as-text hallucination.

#### Scenario: MIME type detected from bytes
- **WHEN** an attachment declares `contentType: text/plain` but contains JPEG magic bytes
- **THEN** the system detects the true type as `image/jpeg` and handles accordingly

### Requirement: Filename Sanitization

The system SHALL sanitize special characters in filenames (spaces, dashes, non-ASCII) before processing, preserving the file extension.

#### Scenario: Special characters in filename
- **WHEN** an attachment has filename "Term Sheet - Alexander Morgan (Draft).pdf"
- **THEN** the system sanitizes to a safe ASCII filename while preserving the `.pdf` extension
