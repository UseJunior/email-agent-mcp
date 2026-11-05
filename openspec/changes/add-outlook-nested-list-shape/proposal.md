## Why

Outlook's compose editor (reproduced in new Outlook for Mac, 2026-10-29) hoists any content that follows a nested `<ul>`/`<ol>` inside an `<li>` to *above* that nested list when a message is opened for editing, and saves it in that order (issue #227). Graph stores and returns the HTML in the right order, so nothing server-side shows the problem until someone edits the draft or the received message in Outlook.

GFM produces exactly that shape for a list item whose nested list is followed by a continuation paragraph:

```md
1. **Lead-in.** Body ending with a colon:

   - bullet a;
   - bullet b.

   After-bullets paragraph.
```

`list_style: "outlook"` (#228) deliberately left items containing a nested list whole. Callers sending `format: "html"` can hit the same shape with no indication anything is wrong.

## What Changes

- With `list_style: "outlook"`, an item of a top-level ordered **or bullet** list that holds exactly one nested list followed only by paragraphs keeps everything up to and including the nested list in its `<li>`. The list closes after that item, the following paragraphs come next as `<p style="margin-left:80px">`, and the list reopens — `<ol start="N">` with the running count for ordered lists, a plain `<ul>` for bullet lists. This is the shape Outlook keeps (issue #227, "Outlook's own shape").
- The indented and unindented forms of the follow-on paragraph produce identical HTML (the unindented form already did this via #228's bridging paragraphs).
- Items whose nested list is their last block, items with two or more nested lists, and items with a non-paragraph block after their nested list stay whole, as before. Bullet lists with no such item, and every other case pinned by `add-outlook-list-style`, are unchanged. Default rendering (no `list_style`) is unchanged.
- `send_email`, `create_draft`, `update_draft` (when the body is replaced), and `reply_to_email` inspect the HTML they store or send and, when any `<li>` holds visible content after a nested list, return a `warnings` entry with code `OUTLOOK_NESTED_LIST_REORDER` naming the affected items. HTML is never rewritten. `send_email` and `reply_to_email` gain the optional `warnings` output field `create_draft`/`update_draft` already have.

## Design

**Indent: 80px, not the 40px in the issue's capture.** Outlook's hand-fixed capture wrote `<p style="margin:0 40px">` — aligned with the item's text. `list_style: "outlook"` already puts an item's continuation paragraphs at `margin-left:80px` (#228). Markdown cannot tell "continuation after a nested list" from "continuation paragraph", so using 40px here would put two continuation paragraphs of the same item, or of adjacent items in one email, at different depths depending only on whether a nested list came first. 80px also lines up with the nested list's own item text (40px `<ol>` padding + 40px `<ul>` padding), so the follow-on paragraph reads as part of the item's body. Only `margin-left` is set, matching #228, so vertical paragraph spacing is the same as everywhere else in the body (Outlook's `margin:0` reflects its own `margin:0` paragraph convention). The value is one constant (`OUTLOOK_SUBPARAGRAPH_STYLE`).

**The nested list stays inside the `<li>`.** Outlook's capture shows the nested `<ul>` as a direct child of `<ol>` (invalid HTML that Outlook normalizes to). Only content *after* the nested list is hoisted, so keeping marked's valid nesting fixes the reorder while every other client renders standard HTML.

**Bullet parents.** The hoisting is a property of `<li>`, not of numbering, so bullet lists get the same split. Bullet items with plain continuation paragraphs (no nested list) stay unchanged, as #228 decided.

**Opt-in, not default.** The issue proposes reshaping unconditionally. This change keeps it under `list_style: "outlook"` for consistency with #228: the default path stays `marked.parse` byte-for-byte, and the split shape trades standard semantics (the paragraph is no longer inside the `<li>` for screen readers and non-Outlook clients) for Outlook editability. The new warning gives default-mode markdown callers a pointer to the option.

**Warning mechanism.** Reuses the `{ code, message }` `warnings` array already returned by `create_draft`/`update_draft` (`BCC_RECIPIENT_ALSO_VISIBLE`, `REPLY_SUBJECT_THREADING_WARNING`), extracted to a shared `ActionWarningSchema`. Detection parses the rendered HTML with `node-html-parser` — already installed as `node-html-markdown`'s dependency, now declared directly by `@usejunior/email-core` (no new package in the tree) — so implicit `</li>` closes and wrapper elements are handled as a browser would. Whitespace, `<br>`, `&nbsp;`, empty elements and never-displayed elements (`<script>`, `<style>`) after the nested list do not count as content. All tree walks are iterative (deeply nested email HTML overflows the parser's recursive `querySelectorAll`), the check runs on the HTML after truncation, and any analysis failure is logged to stderr and skipped so the advisory check can never block a compose call.

## Impact

- Affected specs: `email-write` (MODIFIED `Outlook List Style`, ADDED `Outlook Nested List Warning`)
- Affected code: `packages/email-core/src/content/outlook-lists.ts`, new `packages/email-core/src/content/outlook-list-hazards.ts`, `packages/email-core/src/actions/{compose-helpers,draft,send,reply}.ts`, `packages/email-core/package.json`, `README.md`, `packages/email-agent-mcp/README.md`
- User-visible behavior: different HTML under `list_style: "outlook"` for items with paragraphs after a nested list; a new optional `warnings` entry on compose responses. Default rendering unchanged.
- Out of scope: hazards inside nested lists or blockquotes (warned, not reshaped), items with multiple nested lists or non-paragraph blocks after the nested list (warned, not reshaped), making the reshape the default.
