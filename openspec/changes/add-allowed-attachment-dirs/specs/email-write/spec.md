## MODIFIED Requirements

### Requirement: Body File Composition

The system SHALL accept an optional `body_file` parameter (local file path) as an alternative to the `body` string. File resolution and security validation SHALL occur in email-core action logic, not the MCP transport layer. When the file is markdown, the system SHALL render it to HTML before sending (see Body Rendering).

Paths SHALL resolve within the safe directory (`EMAIL_MCP_SAFE_DIR`, default the process working directory) or within any additional absolute root the operator allowlists via `AGENT_EMAIL_ALLOWED_DIRS` (a delimiter-separated list; a leading `~` is expanded, non-absolute entries are ignored with a warning). A relative path SHALL resolve against the safe directory only; an absolute path SHALL be checked against each root in order — safe directory first — and the first containment match wins. Every root and the fully resolved target SHALL be canonicalized with `realpath` before the containment check, and a root that cannot be canonicalized SHALL authorize nothing. A rejection message SHALL name the roots that were tried and the env var that widens them.

#### Scenario: Compose from markdown file
- **WHEN** `send_email` is called with `{body_file: "draft.md", to: "..."}`
- **THEN** the system reads the file, renders the markdown to HTML, and ships both the raw source (as plain-text fallback) and the rendered HTML to the provider

#### Scenario: Path traversal rejected
- **WHEN** `body_file` contains `../` or an absolute path outside every allowed root
- **THEN** the system rejects with `PATH_TRAVERSAL` and an error naming the roots that were tried, beginning "body_file must be within the working directory" when no extra roots are configured

#### Scenario: Binary file rejected
- **WHEN** `body_file` points to a binary file (image, PDF)
- **THEN** the system rejects with an error: "body_file must be a text file (.md, .html, .txt)"

#### Scenario: Symlink escape rejected
- **WHEN** `body_file` is a symlink pointing outside every allowed root
- **THEN** the system rejects with `SYMLINK_ESCAPE` and an error beginning "body_file symlink targets outside working directory" when no extra roots are configured

#### Scenario: File not found
- **WHEN** `body_file` points to a non-existent file
- **THEN** the system rejects with an error: "body_file not found: draft.md"

#### Scenario: Configured safe directory
- **WHEN** a safe directory is configured via the `EMAIL_MCP_SAFE_DIR` env var
- **THEN** `body_file` paths are resolved relative to that directory

#### Scenario: Configured additional root
- **WHEN** `AGENT_EMAIL_ALLOWED_DIRS` names `/Users/me/Downloads` and `body_file` is the absolute path `/Users/me/Downloads/note.md`
- **THEN** the system reads the file, even though it lies outside the safe directory

#### Scenario: Relative path does not search allowlisted roots
- **WHEN** `AGENT_EMAIL_ALLOWED_DIRS` names a root holding `note.md` and `body_file` is the relative path `note.md`, absent from the safe directory
- **THEN** the system rejects with `FILE_NOT_FOUND` rather than resolving the copy in the allowlisted root

#### Scenario: Allowlisted root is itself a symlink
- **WHEN** an `AGENT_EMAIL_ALLOWED_DIRS` entry is a symlink to another directory and `body_file` points inside it
- **THEN** the system canonicalizes the root before the containment check and resolves the file to its real path

#### Scenario: Unset configuration preserves the single-root sandbox
- **WHEN** `AGENT_EMAIL_ALLOWED_DIRS` is unset and `body_file` points outside the safe directory
- **THEN** the system rejects with `PATH_TRAVERSAL`, exactly as before the setting existed

#### Scenario: Frontmatter format override
- **WHEN** `body_file` frontmatter declares `format: text`
- **THEN** the system sends the body as plain text without rendering, preserving newlines verbatim
