## ADDED Requirements

### Requirement: Raw HTML Body Output

The `read_email` action SHALL accept an optional `format` parameter with the values `markdown` and `html`, defaulting to `markdown`.

When `format` is omitted or `markdown`, the returned `body` SHALL be identical to current behavior — the token-efficient markdown conversion, with the existing `strip_quoted_history` and `strip_signatures` transforms applied as before. The markdown default is deliberate: it is what keeps a routine read cheap, and this requirement SHALL NOT change it.

When `format` is `html`, the system SHALL return the message's raw body HTML verbatim as `body`, so that inline styling the markdown conversion cannot carry — `color`, `background-color`, `text-decoration`, `<u>` — survives a read, edit, and write-back round trip. Because byte fidelity is the purpose of this mode, the system SHALL NOT apply the markdown-shaped text transforms (`strip_quoted_history`, `strip_signatures`) and SHALL NOT append the attachment summary, even when those flags are set; attachments remain reported structurally in `attachments`.

The response SHALL carry a `bodyFormat` field, always present, reporting what `body` actually contains: `markdown`, `html`, or `text`. `text` SHALL be reported when `format: 'html'` was requested for a message that carries no HTML part, in which case the plain-text body is returned — a caller must be able to tell that case apart from real HTML, because writing plain text back as HTML would mangle it.

The body returned for `format: 'html'` SHALL be capped at a documented byte budget — covering both the raw HTML and the plain-text fallback, since both are the same response headed for the same transport budget — and, when the cap fires, SHALL set `bodyTruncated: true` rather than being silently cut. The flag SHALL be absent rather than `false` when nothing was cut, so its absence means the body is safe to write back. The markdown path SHALL remain unbounded exactly as before.

The tool description SHALL tell the agent that raw HTML costs materially more tokens than markdown, that the markdown path discards styling, that `bodyFormat` and `bodyTruncated` must be checked before writing a body back, and that writing raw HTML back requires `force_black: false` on the compose action — `force_black` defaults to true and wraps the body in a force-black div, so leaving it on nests another wrapper on every round trip.

#### Scenario: Omitting format returns markdown exactly as before
- **WHEN** `read_email` is called with `{id: "msg123"}` on a message whose HTML body carries inline colour, background-colour, and underline styling
- **THEN** the returned `body` is the markdown conversion, carrying the prose but none of the styling
- **AND** `bodyFormat` is `markdown` and `bodyTruncated` is absent
- **AND** the result is byte-identical to calling with the pre-existing defaults explicitly

#### Scenario: format 'html' returns styling the markdown conversion destroys
- **WHEN** `read_email` is called with `{id: "msg123", format: "html"}` on that same message
- **THEN** the returned `body` is the message's raw body HTML verbatim
- **AND** `color`, `background-color`, `text-decoration`, and `<u>` are all present
- **AND** `bodyFormat` is `html`

#### Scenario: format 'html' skips the markdown-shaped text transforms
- **WHEN** `read_email` is called with `{id: "msg123", format: "html", strip_quoted_history: true, strip_signatures: true}`
- **THEN** the returned `body` is the raw HTML unmodified, with no quoted-history marker inserted and no signature removed

#### Scenario: format 'html' does not append the attachment summary
- **WHEN** `read_email` is called with `{format: "html"}` on a message with attachments
- **THEN** the returned `body` is the raw HTML with no `Attachments: …` line appended
- **AND** the attachments are still reported in the `attachments` array

#### Scenario: Oversized raw HTML body is flagged as truncated
- **WHEN** `read_email` is called with `{format: "html"}` on a message whose raw HTML body exceeds the response byte budget
- **THEN** `body` is cut at a safe UTF-8 boundary and is a prefix of the original
- **AND** `bodyTruncated` is `true`

#### Scenario: Oversized plain-text fallback is flagged as truncated
- **WHEN** `read_email` is called with `{format: "html"}` on a plain-text-only message whose body exceeds the response byte budget
- **THEN** `bodyFormat` is `text` and `bodyTruncated` is `true`
- **AND** the same message read on the default markdown path is returned in full, unflagged

#### Scenario: Raw HTML round-trips unchanged through the compose renderer
- **WHEN** a body read with `{format: "html"}` is written back with `format: "html"` and `force_black: false`, repeatedly
- **THEN** the HTML is byte-identical after every cycle
- **AND** leaving `force_black` at its default wraps the body in a force-black div, nesting one more wrapper per cycle — which is why the tool description requires `force_black: false`

#### Scenario: Raw HTML body under the budget is not flagged as truncated
- **WHEN** `read_email` is called with `{format: "html"}` on a message whose raw HTML body is within the budget
- **THEN** `body` is the complete raw HTML
- **AND** `bodyTruncated` is absent rather than `false`

#### Scenario: format 'html' on a message with no HTML part reports text
- **WHEN** `read_email` is called with `{format: "html"}` on a message that has only a plain-text body
- **THEN** the plain-text body is returned
- **AND** `bodyFormat` is `text` so the caller does not write it back as HTML

#### Scenario: Every read reports what body it returned
- **WHEN** `read_email` is called with any `format`
- **THEN** the response includes a `bodyFormat` key
- **AND** the key is present rather than omitted, so a caller never has to infer the body's format
