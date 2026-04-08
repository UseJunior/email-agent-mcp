# content-engine delta: outbound body rendering

## ADDED Requirements

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
