# Design: markdown body rendering

## Problem restatement

`email-agent-mcp` accepts a body string from the caller and ships it to Graph / Gmail with `contentType: HTML` hardcoded. Agents (OpenClaw, Claude Code) write markdown by default, so the inbox shows `###` characters and collapsed whitespace. The bug is that we declared HTML without producing HTML.

## Reference implementation

`~/Projects/foam-notes/scripts/save_draft_to_outlook.py:502-509` is the working reference:

```python
body_html = markdown.markdown(
    post.content,
    extensions=['nl2br', 'extra']
)
if not args.no_force_black:
    body_html = f'<div style="color: #000000;">{body_html}</div>'
```

Then `scripts/graph_helpers/graph_email.py:124` posts to Graph with `"body": {"contentType": "HTML", "content": html_body}`. Same endpoint we use. The difference is the render + dark-mode wrap.

## Decisions

### Where does rendering live?

**Chosen: a shared helper in email-core** (`content/body-renderer.ts`), called from each action's `run` method.

Alternatives considered:
- *In the provider*: rejected — providers should stay dumb transport adapters. Putting rendering in two providers duplicates the logic and couples transport to content format.
- *Inside `resolveComposeFields` in compose-helpers*: rejected — `resolveComposeFields` is about field merging (body/frontmatter resolution), not format conversion. Mixing concerns would make it harder to test the render step independently.
- *In a middleware wrapper*: rejected — overkill for a single transform, and actions are already linear enough that adding one function call per action is clearer than threading middleware.

### Which renderer library?

**Chosen: `marked` v18, MIT, ESM-native, zero-dep.**

Foam uses Python `markdown` with `nl2br` + `extra`. The closest TypeScript equivalent is `marked` with `{ breaks: true, gfm: true }`:
- `breaks: true` → single `\n` becomes `<br>` (equivalent to `nl2br`)
- `gfm: true` → GitHub Flavored Markdown: tables, strikethrough, fenced code (superset of `extra`)

Alternatives considered:
- `markdown-it`: more extensible but also larger and slower to set up. We don't need the extensibility.
- `remark` + `remark-html`: unified ecosystem, powerful but heavy (~6 transitive deps) and requires explicit plugin configuration for breaks + gfm.
- Hand-rolled: rejected — would re-implement a battle-tested library badly.

`marked` is also ~30KB, already popular, trivially swappable later if needed.

### How do providers know whether to send HTML or text?

**Chosen: signal via `ComposeMessage.bodyHtml`.**

`bodyHtml` already exists on `ComposeMessage` (types.ts:57) but was previously **unused on the write path** — only populated when reading received messages. We repurpose the write slot: when the action renders to HTML, it populates `bodyHtml`; providers check `msg.bodyHtml !== undefined` and pick HTML content-type, otherwise pick text.

For reply methods (which take `body: string` directly, not a `ComposeMessage`), `ReplyOptions` gains a parallel `bodyHtml?: string` field. Signature stays backwards compatible.

Alternatives considered:
- New `contentType` enum field on `ComposeMessage`: redundant with `bodyHtml` being present/absent, and requires updating all test fixtures.
- Only look at `body` and infer format: impossible from a string alone, and auto-detection is brittle.

### What lives in `body` vs `bodyHtml` after rendering?

**Chosen: `body` always holds the raw source; `bodyHtml` holds the rendered HTML (if any).**

This preserves caller intent — the `body` field matches what the agent wrote — and gives providers a plain-text fallback they can use for multipart/alternative later if desired. The mock provider can assert on either field naturally.

Alternatives considered:
- Clear `body` when rendering: causes existing tests that check `sent[0].body` to see empty strings and requires rewriting assertions even when they weren't about format. Rejected.
- Put rendered HTML in `body` and ignore `bodyHtml`: conflates two fields and loses the raw source. Rejected.

### Force-black dark-mode wrapper

**Chosen: on by default, opt-out via `force_black: false` param or frontmatter.**

Outlook dark mode auto-inverts body text unless an explicit color is set on the container. Without this wrapper, markdown-rendered output becomes unreadable white-on-white. Foam hit this exact issue and shipped the same wrapper (`save_draft_to_outlook.py:509`). Trivial cost, real UX win.

### Truncation

**Chosen: truncate `body` and `bodyHtml` independently, each capped at `BODY_SIZE_LIMIT`.**

The existing `truncateBody` helper in `body-loader.ts` is HTML-aware (cuts at `>` boundaries), so it's safe to run on either field. Truncating both means each field is guaranteed to be within the size limit regardless of which one the provider picks.

### No HTML sanitization

Foam doesn't sanitize either. Callers are gated by the send allowlist, so the trust boundary is already "agent can send emails from my account" — at that level, accepting arbitrary HTML in the body is not a new risk. Adding sanitization is a legitimate future security conversation, but it's out of scope for fixing a rendering bug.

## What this change does NOT do (follow-ups)

1. **Add `body_file` support to `reply_to_email`.** Foam has it via `reply_to_email.py`, we don't. Unrelated to the rendering fix.
2. **Gmail multipart/alternative with both text and HTML parts.** Single-part is simpler and what we ship today; upgrading to multipart is a separate capability.
3. **HTML sanitization on `format: 'html'` input.** Requires choosing a sanitizer, threat-modeling the allowlist, and adding a deny-by-default config. Separate security proposal.
4. **Switching OpenClaw's brief generator to emit via `body_file` + frontmatter.** That's a change on the OpenClaw side, not here.
