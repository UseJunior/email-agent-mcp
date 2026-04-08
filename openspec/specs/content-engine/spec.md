---
epic: Content Processing
feature: AI-Ready Email Transformation
---

## Purpose

Transforms raw email content (HTML or plaintext) into a token-efficient representation optimized for LLM consumption. Handles HTML sanitization, signature stripping, encoding normalization, and attachment summarization. Thread dedup is stubbed for v1 — rely on limit parameters instead.

### Requirement: HTML to Token-Efficient Markdown

The system SHALL convert HTML email bodies to token-efficient markdown, preserving tables, lists, links, and non-tracking images while stripping tracking pixels, data URI images, CSS, scripts, and hidden elements.

#### Scenario: HTML with tracking pixel
- **WHEN** an HTML email contains `<img src="https://tracker.example.com/pixel.gif" width="1" height="1">`
- **THEN** the system strips the tracking pixel from the output

#### Scenario: Table preservation
- **WHEN** an HTML email contains a data table
- **THEN** the system converts it to markdown table format

#### Scenario: Non-tracking image preserved as markdown link
- **WHEN** an HTML email contains `<img src="https://example.com/chart.png" alt="Q1 Revenue">`
- **THEN** the system converts it to `![Q1 Revenue](https://example.com/chart.png)`

#### Scenario: CID inline image preserved as markdown link
- **WHEN** an HTML email contains `<img src="cid:image001">`
- **THEN** the system converts it to `![](cid:image001)` so agents can correlate with attachment metadata

#### Scenario: Tracking pixel via inline CSS stripped
- **WHEN** an HTML email contains `<img src="https://tracker.co/px" style="width:1px;height:1px">`
- **THEN** the system strips the tracking pixel from the output

#### Scenario: Data URI image stripped
- **WHEN** an HTML email contains `<img src="data:image/png;base64,...">`
- **THEN** the system strips the data URI image to preserve token efficiency

### Requirement: Signature Stripping

The system SHALL strip email signatures and legal disclaimers using heuristic-based detection. Configurable (can be disabled).

#### Scenario: Common signature pattern
- **WHEN** an email ends with "-- \nJohn Doe\nSenior Partner"
- **THEN** the system strips the signature from the body content

### Requirement: Thread Dedup (Stub for v1)

The system SHALL provide a no-op dedup implementation in v1. Quoted reply chains ("On [date], [user] wrote:") are preserved in full. Rely on `limit` parameters with sensible defaults so the agent reads incrementally and stops at repetitive content.

#### Scenario: Quoted text preserved
- **WHEN** an email contains "On March 1, Alice wrote:" followed by quoted text
- **THEN** the system preserves the full quoted content (no stripping in v1)

### Requirement: Encoding Handling

The system SHALL handle MIME type negotiation (prefer HTML, fall back to plaintext), normalize character encoding to UTF-8, and preserve emoji and non-Latin scripts.

#### Scenario: Non-UTF8 email
- **WHEN** an email is encoded in ISO-8859-1
- **THEN** the system normalizes to UTF-8 without data loss

### Requirement: Attachment Summary

The system SHALL generate inline descriptions of attachments without including full content, to help the agent understand what's attached.

#### Scenario: Attachment list in body
- **WHEN** an email has 3 attachments
- **THEN** the output includes: "Attachments: contract.docx (245KB), logo.png (inline), data.xlsx (1.2MB)"

### Requirement: Outbound Markdown Rendering

The system SHALL provide a shared outbound body renderer in `email-core/content/body-renderer.ts` that converts an author-supplied body string into a transport-ready form consisting of a plain-text field (the raw source) and an optional rendered-HTML field. The renderer SHALL accept `format: 'markdown' | 'html' | 'text'` (default `'markdown'`) and `forceBlack: boolean` (default `true`).

#### Scenario: Markdown to HTML conversion
- **WHEN** the renderer is called with `format: 'markdown'` (or the default) and a markdown string
- **THEN** it produces HTML via GitHub Flavored Markdown semantics (tables, fenced code, strikethrough) with single newlines converted to `<br>` elements
- **AND** the raw source is preserved in the `body` field for plain-text fallback

#### Scenario: HTML passthrough
- **WHEN** the renderer is called with `format: 'html'`
- **THEN** the input is treated as already-rendered HTML and returned as `bodyHtml` unchanged (aside from the force-black wrapper)

#### Scenario: Text mode skips rendering
- **WHEN** the renderer is called with `format: 'text'`
- **THEN** it returns only `{ body: raw }` with no `bodyHtml`, signaling the provider to send as plain text

#### Scenario: Force-black dark-mode wrapper
- **WHEN** the renderer produces HTML and `forceBlack` is not `false`
- **THEN** the HTML is wrapped in `<div style="color: #000000;">…</div>` so Outlook dark mode does not invert body text to white-on-white

#### Scenario: Force-black opt-out
- **WHEN** the renderer is called with `forceBlack: false`
- **THEN** the HTML output is NOT wrapped and the caller's styling applies directly

#### Scenario: Raw HTML embedded in markdown is preserved
- **WHEN** the renderer processes markdown that contains inline raw HTML (e.g. `<a href="...">`)
- **THEN** the raw HTML is preserved verbatim in the output

### Requirement: Frontmatter Format Override

The body-file frontmatter parser SHALL recognize `format` and `force_black` keys so markdown files can declare their rendering preference authoritatively.

#### Scenario: Format declared in frontmatter
- **WHEN** a body file contains `format: text` in its YAML frontmatter
- **THEN** the action sends the body as plain text even if the action input requested `markdown`

#### Scenario: force_black declared in frontmatter
- **WHEN** a body file contains `force_black: false` in its YAML frontmatter
- **THEN** the rendered HTML is not wrapped in the force-black div
