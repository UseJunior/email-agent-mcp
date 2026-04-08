# email-write delta: markdown body rendering

## MODIFIED Requirements

### Requirement: Body File Composition

The system SHALL accept an optional `body_file` parameter (local file path) as an alternative to the `body` string. File resolution and security validation SHALL occur in email-core action logic, not the MCP transport layer. When the file is markdown, the system SHALL render it to HTML before sending (see Body Rendering).

#### Scenario: Compose from markdown file
- **WHEN** `send_email` is called with `{body_file: "draft.md", to: "..."}`
- **THEN** the system reads the file, renders the markdown to HTML, and ships both the raw source (as plain-text fallback) and the rendered HTML to the provider

#### Scenario: Path traversal rejected
- **WHEN** `body_file` contains `../` or an absolute path outside the working directory
- **THEN** the system rejects with an error: "body_file must be within the working directory"

#### Scenario: Binary file rejected
- **WHEN** `body_file` points to a binary file (image, PDF)
- **THEN** the system rejects with an error: "body_file must be a text file (.md, .html, .txt)"

#### Scenario: Symlink escape rejected
- **WHEN** `body_file` is a symlink pointing outside the working directory
- **THEN** the system rejects with an error: "body_file symlink targets outside working directory"

#### Scenario: File not found
- **WHEN** `body_file` points to a non-existent file
- **THEN** the system rejects with an error: "body_file not found: draft.md"

#### Scenario: Configured safe directory
- **WHEN** a safe directory is configured via `AGENT_EMAIL_SAFE_DIR` env var
- **THEN** `body_file` paths are resolved relative to that directory

#### Scenario: Frontmatter format override
- **WHEN** `body_file` frontmatter declares `format: text`
- **THEN** the system sends the body as plain text without rendering, preserving newlines verbatim

## ADDED Requirements

### Requirement: Body Rendering

The `send_email`, `create_draft`, `update_draft`, and `reply_to_email` actions SHALL accept an optional `format` parameter — one of `"markdown" | "html" | "text"`, defaulting to `"markdown"` — and an optional `force_black` boolean defaulting to `true`. When `format` is `"markdown"`, the system SHALL render the body as GitHub Flavored Markdown with single-newline-to-`<br>` conversion. When `format` is `"html"`, the system SHALL treat the body as pre-rendered HTML and pass it through. When `format` is `"text"`, the system SHALL send the body as plain text with no rendering. For `"markdown"` and `"html"`, the rendered output SHALL be wrapped in `<div style="color: #000000;">…</div>` by default so Outlook dark mode does not invert body text to unreadable white-on-white; callers SHALL be able to opt out via `force_black: false`.

#### Scenario: Markdown rendering by default
- **WHEN** `send_email` is called with `body: "### Header\n\n**bold** text"` and no `format` parameter
- **THEN** the recipient sees `Header` rendered as an `<h3>` and `bold` in bold, not as literal `###` and `**`
- **AND** the raw markdown is preserved in the provider's plain-text body field

#### Scenario: Single newlines preserved as line breaks
- **WHEN** `send_email` is called with `body: "line one\nline two\nline three"`
- **THEN** the recipient sees each line on its own line (rendered as `<br>`-separated content, not a single collapsed paragraph)

#### Scenario: GFM tables render
- **WHEN** `send_email` is called with a body containing a markdown pipe-table
- **THEN** the recipient sees a rendered HTML `<table>`

#### Scenario: format text bypasses rendering
- **WHEN** `send_email` is called with `{body: "### Literal", format: "text"}`
- **THEN** the recipient sees the characters `### Literal` verbatim as plain text

#### Scenario: format html passthrough
- **WHEN** `send_email` is called with `{body: "<h1>Pre-rendered</h1>", format: "html"}`
- **THEN** the system ships the HTML without re-rendering

#### Scenario: Raw HTML embedded in markdown is preserved
- **WHEN** `send_email` is called with a markdown body containing `<a href="https://example.com">link</a>`
- **THEN** the rendered output preserves the anchor tag verbatim

#### Scenario: force_black wrapper default
- **WHEN** any write action renders a body to HTML and `force_black` is unset
- **THEN** the rendered HTML is wrapped in `<div style="color: #000000;">…</div>`

#### Scenario: force_black opt-out
- **WHEN** any write action is called with `force_black: false`
- **THEN** the rendered HTML is NOT wrapped in the force-black div

#### Scenario: Frontmatter format is authoritative
- **WHEN** `body_file` frontmatter contains `format: text` and the action call contains `format: markdown`
- **THEN** the system uses `text` (frontmatter overrides action parameters)

#### Scenario: reply_to_email also renders
- **WHEN** `reply_to_email` is called with a markdown body
- **THEN** the reply is sent with the markdown rendered to HTML, matching `send_email` behavior

#### Scenario: create_draft and update_draft also render
- **WHEN** `create_draft` or `update_draft` is called with a markdown body
- **THEN** the draft stored on the provider contains the rendered HTML and can be sent later without re-rendering
