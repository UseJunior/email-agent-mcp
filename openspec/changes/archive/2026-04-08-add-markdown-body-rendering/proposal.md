# Add markdown body rendering for outgoing email

## Why

LLM agents (OpenClaw, Claude Code, and anything else driving `send_email`) natively emit markdown: `### Headers`, `**bold**`, `- bullets`, line-break-separated paragraphs. Today those bodies arrive at the provider layer raw, get wrapped as `contentType: HTML` without rendering, and Outlook/Gmail render them as one giant wall of literal markdown syntax with every newline collapsed. Users see `###` characters in their inbox and paragraphs smooshed into one line.

Confirmed in the 2026-04-08 morning brief:

> `Hi Steven & Marlo, Here is your morning brief for Wednesday, April 8th, 2026. ### 📧 Urgent Customer & Internal Emails * **[Action Required]** Agent-launcher PR failure…`

The sister project `~/Projects/foam-notes` (foam-email-calendar) hits the same Graph endpoint and renders beautifully because its `save_draft_to_outlook.py` runs `markdown.markdown(body, extensions=['nl2br', 'extra'])` before posting. Same target, same `contentType: HTML` declaration — the one render step is the only difference.

## What Changes

1. **email-core adds a body renderer.** New shared helper `packages/email-core/src/content/body-renderer.ts` converts markdown → HTML using `marked` with `{ breaks: true, gfm: true }`. Single newlines become `<br>`, GitHub-flavored markdown (tables, strikethrough, fenced code) works out of the box. Output is wrapped in `<div style="color:#000000">` by default so Outlook dark mode doesn't turn body text invisible.

2. **All four write actions gain a `format` parameter.** `send_email`, `create_draft`, `update_draft`, and `reply_to_email` accept `format: 'markdown' | 'html' | 'text'` (default `'markdown'`) and `force_black: boolean` (default `true`). Frontmatter in `body_file` can set either field, matching foam's workflow.

3. **Providers honor `ComposeMessage.bodyHtml` on the write path.** `bodyHtml` already exists on `ComposeMessage` but was only populated on reads. Now actions populate it from the renderer, and both providers branch on it:
   - Microsoft Graph: `bodyHtml` → `contentType: 'HTML'`; otherwise `contentType: 'Text'` (preserves newlines for plain-text sends).
   - Gmail: `bodyHtml` → `Content-Type: text/html`; otherwise `Content-Type: text/plain`.
   - `ReplyOptions` gains a `bodyHtml?: string` so reply paths carry the rendered HTML through the 2-arg `replyToMessage(messageId, body, opts)` signature without a breaking change.

4. **Raw source stays in `body` as a plain-text fallback.** When rendering to HTML, `body` holds the original markdown string and `bodyHtml` holds the rendered output. This keeps the `ComposeMessage` truthful for any downstream consumer (tests, multipart/alternative support in the future) and makes the semantics obvious.

5. **Deps:** adds `marked ^18.0.0` (MIT, zero-dep, ESM) to `@usejunior/email-core`.

## Impact

- **Affected specs:** `email-write` (MODIFIED — `format`/`force_black` params, rendering behavior), `provider-interface` (MODIFIED — providers must honor `bodyHtml` and `ReplyOptions.bodyHtml`), `content-engine` (ADDED — new outbound rendering capability alongside the existing inbound transform).
- **Affected code:** `packages/email-core/src/content/body-renderer.ts` (new), `packages/email-core/src/content/frontmatter.ts`, `packages/email-core/src/actions/{send,draft,reply}.ts`, `packages/email-core/src/actions/compose-helpers.ts`, `packages/email-core/src/types.ts`, `packages/email-core/src/testing/mock-provider.ts`, `packages/provider-microsoft/src/email-graph-provider.ts`, `packages/provider-gmail/src/email-gmail-provider.ts`.
- **Caller compatibility:** Existing callers that passed plain text or pre-rendered HTML continue to work — marked passes raw HTML through unchanged, and plain text renders as a `<p>` with preserved line breaks. Any caller that specifically wants the old "send raw string as HTML" behavior can pass `format: 'html'`. Any caller that wants plain text over the wire can pass `format: 'text'`.
- **No migration required.** The default behavior becomes "render markdown," which is what every current caller is already trying (and failing) to achieve.
