## MODIFIED Requirements

### Requirement: Attach Files to Outbound

The system SHALL accept file attachments for outbound emails from a local file path or buffer. No CID embedding in v1 — email clients will show attachments inline if appropriate.

A caller-supplied `attachments[].path` SHALL be read under the same sandbox as `body_file`: it resolves within the safe directory (`EMAIL_MCP_SAFE_DIR`, default the process working directory) or within any absolute root the operator allowlists via `AGENT_EMAIL_ALLOWED_DIRS`, with every root canonicalized before the containment check. A path outside every root SHALL be rejected with `PATH_TRAVERSAL`, and a symlink escaping every root with `SYMLINK_ESCAPE`.

#### Scenario: Attach file to reply
- **WHEN** `reply_to_email` is called with `{attachments: [{path: "/tmp/report.pdf"}]}` and `/tmp` is an allowed root
- **THEN** the system base64-encodes the file and includes it as a Graph/Gmail attachment

#### Scenario: Attach a file from an allowlisted directory
- **WHEN** `AGENT_EMAIL_ALLOWED_DIRS` names `/Volumes/Shared/Contracts` and `send_email` is called with `{attachments: [{path: "/Volumes/Shared/Contracts/agreement.pdf"}]}`
- **THEN** the file is attached without being copied into the working directory

#### Scenario: Attachment outside every allowed root rejected
- **WHEN** `attachments[].path` points outside the safe directory and outside every allowlisted root
- **THEN** the system rejects with `PATH_TRAVERSAL` and an error naming the roots that were tried
