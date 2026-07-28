## Why

`read_email` always returns the body as markdown, so a formatted body cannot be round-tripped. That is a real, repeated failure, not a theoretical one.

Take a body that carries hand-applied inline styling which only exists in HTML — red strikethrough and blue underline marking proposed edits, background highlight on a figure under discussion. An agent needs to change one sentence and leave every other byte alone. Today it has two options:

1. `read_email` → markdown → edit → write back. `htmlToMarkdown` (`content/sanitize.ts:164`) cannot carry `color`, `background-color`, `text-decoration`, or `<u>`, so the styling is **destroyed** on the way out. Every regeneration flattens the document a little more.
2. Have a human copy the formatted body out of the mail client by hand and paste it back in.

Option 2 is what actually happens. In one observed case it happened twice in a single day, across roughly fifteen revisions of one message.

The write path is already capable. `renderEmailBody` treats `format: 'html'` as a pure passthrough (`content/body-renderer.ts:61-62`, `html = raw`) with no write-path sanitiser — arbitrary styled HTML *can* be written. The gap is entirely on the read side:

- `actions/read.ts` unconditionally calls `transformEmailContent(...)`, which routes any HTML body through `htmlToMarkdown`.
- `ReadEmailOutput` has no HTML field at all.

So the provider hands the action `bodyHtml` and the action throws it away before any caller can see it. Nothing else in the codebase can recover it.

## What Changes

- Add `format?: 'markdown' | 'html'` to the `read_email` input, defaulting to `'markdown'`.
- When `'html'`, return the message's raw `bodyHtml` **verbatim** as `body`.
- Add `bodyFormat: 'markdown' | 'html' | 'text'` to the output, always present.
- Add `bodyTruncated?: boolean`, set only when the body returned for `format: 'html'` — the raw HTML, or the plain-text fallback when the message has no HTML part — exceeded `READ_HTML_BODY_LIMIT`. The markdown path stays uncapped.
- Mirror the change in the re-declared MCP transport schemas in `packages/email-mcp/src/server.ts`, and in the demo fallback payload.
- Document `read_email`'s `format` and the compose-side `format` in both the root README and the README published with the `email-agent-mcp` npm package. Both were undocumented; the compose-side one is the other half of the round trip and is useless if a caller cannot discover it.

### The other half of the round trip: `force_black`

`renderEmailBody` defaults `forceBlack` to true even for `format: 'html'`, wrapping whatever HTML it is handed in `<div style="color: #000000;">`. On a body that was just read back, that nests one more wrapper on every cycle — fifteen revisions, fifteen nested divs. So the round trip this change advertises is only exact when the compose call also passes `force_black: false`.

The compose-side default is deliberately **not** changed. It is correct for its actual job: HTML the agent authored itself, which may be a bare fragment with no colour of its own and which Outlook dark mode would otherwise render white-on-white. Flipping it for `format: 'html'` would silently change how every existing HTML sender's mail renders, in a published package, to fix a problem that only arises on the read-back path. Instead both agent-facing tool descriptions and both READMEs state the requirement explicitly, and a test pins it: three cycles with `force_black: false` are byte-identical, and the wrapper demonstrably appears without it.

### The markdown default stays

It is deliberate and it is correct. Markdown is token-efficient and that matters on every single read. This change is strictly additive and opt-in: with `format` omitted, the returned body is byte-identical to today's, asserted directly by a test.

### Why the html branch skips the text transforms

`strip_quoted_history` and `stripSignature` are markdown-shaped text transforms. Both rewrite the string; `stripSignature` in particular cuts by a length-percentage heuristic that has no meaning over HTML tag soup and would happily amputate a `</div>`. The attachment summary that `transformEmailContent` appends is prose, and appending prose to raw HTML means writing that prose into the message body on the next round trip.

So the `'html'` branch applies none of them. Byte fidelity is the entire feature; anything that rewrites the string defeats it. Attachments are still reported structurally in `attachments`, so nothing is actually lost.

### Why `bodyFormat` is required and `bodyTruncated` is not

`bodyFormat` follows the recipient-topology precedent from issue #102: an omitted key is ambiguous, and a caller about to write this body back must not have to guess what it is holding. In particular, `format: 'html'` on a message with no HTML part yields the plain-text body — writing that back as HTML would mangle it, so `text` must be distinguishable from `html` rather than silently looking like it.

`bodyTruncated` is a warning, not a status field. It follows `DraftPreviewSchema`'s `bodyTruncated` / `bodyHtmlTruncated`, which are set only when they fire. Absence means "safe to write back," which is exactly the question the caller is asking. The cap covers whatever the `'html'` branch returns, including the plain-text fallback: that is still a `format: 'html'` response headed for the same transport budget, and an unbounded one truncated by the transport instead would arrive mangled with no flag on it. The markdown path stays uncapped — it is the default, and the default does not change.

### Why the cap is 256 KB and not `PREVIEW_BODY_LIMIT`

`PREVIEW_BODY_LIMIT` is 32 KB because a draft preview exists so an agent can *eyeball* what was persisted. The raw-HTML read exists so an agent can *round-trip* a body, and a truncated body cannot be written back at all — truncation defeats the purpose rather than merely degrading it. Outlook-authored HTML with inline `mso-` styling routinely runs well past 32 KB for a body whose markdown reduction is a few KB, so a 32 KB cap would truncate the majority of the bodies this feature exists to serve. 256 KB covers hand-authored formatted mail with headroom while still bounding the MCP response. The byte-safe cut helper itself is shared with the preview path so the two signals cannot disagree about a codepoint boundary.

## Impact

- Affected specs: `email-read`
- Affected code: `packages/email-core/src/actions/read.ts`, `packages/email-core/src/actions/compose-helpers.ts` (export the truncation helper), `packages/email-core/src/index.ts`, `packages/email-mcp/src/server.ts`, `README.md`
- User-visible behavior: one optional input parameter and two additive output fields. `format` omitted → byte-identical to today. Consumers that ignore unknown fields are unaffected.
- Cost: none on the default path. The `'html'` path returns materially more tokens by construction, which is why it is opt-in and why the tool description says so.
- Out of scope: a raw-HTML option on `get_thread` or `search_emails` (their rows carry snippets, not full bodies, and the round-trip use case is single-message), sanitising HTML on the read path (the write path does not sanitise either, and sanitising would break the byte fidelity that is the point), and any change to the compose-side `format` behavior — it already works and is only being documented.
