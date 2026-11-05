## Why

A common email layout is numbered items, each followed by lettered sub-paragraphs ("1. Heading", then "a. …", "b. …"). With `format: "markdown"` there is no way to produce a second level that Outlook shows deeper than the numbers and lets the recipient edit (issue #228):

- Sub-paragraphs indented under their item become `<p>` inside the `<li>`. They line up with the item text, and in Outlook on the web, Tab (or Increase Indent) on one indents the whole `<li>`: the numbered item above turns into "a." and the following items renumber.
- Unindented sub-paragraphs fall outside the list at margin 0, shallower than the numbers.

When a user builds the layout by hand, Outlook saves the list *split* around the sub-paragraphs: `<ol start="N">` segments with the sub-paragraphs outside the list as `<p style="margin-left:80px">`. That shape renders the lettered level deeper than the numbers, Tab / Shift+Tab move a paragraph without touching the numbering, and Outlook still treats the segments as one list.

## What Changes

- Add an optional `list_style` parameter (`"default" | "outlook"`, default `"default"`) to `send_email`, `create_draft`, `update_draft`, and `reply_to_email`, and a `list_style` key to body-file frontmatter.
- With `list_style: "outlook"` and a markdown body, top-level ordered-list items whose content is two or more paragraphs are split: the item keeps its first paragraph, the list closes, the remaining paragraphs follow as `<p style="margin-left:80px">`, and the list reopens with the correct running `start`.
- Paragraphs sitting between two top-level ordered lists whose numbering continues (marked already splits those into separate `<ol>`s) get the same treatment, so the indented and unindented markdown habits yield identical HTML.
- Every segment of a reshaped list carries an explicit `start`, matching Outlook's own saved HTML, and respects the list's own first number.
- Bullet lists, ordered lists with nothing to reshape, and items holding a nested list or any non-paragraph block render exactly as before.
- `list_style` is ignored for `format: "html"` (passthrough — the caller owns the markup) and `format: "text"` (no rendering).
- Omitting `list_style` leaves rendering byte-identical to today.

## Design

The transform runs on marked's token tree, not on rendered HTML. `marked.lexer` produces top-level tokens; ordered-list tokens are grouped into chains (a list plus any following lists separated only by paragraphs and whose `start` continues the count), each item's child tokens decide whether it splits, and the reshaped chain is rendered with marked's own `listitem` and inline renderers. Everything else is handed back to marked's parser unchanged. This avoids regex over HTML, keeps inline rendering (emphasis, links, `breaks: true`) identical to the default path, and makes "nothing to reshape" a token pass-through rather than a string round trip.

Continuation is decided by numbering: a later list continues the chain only when its declared start equals the running count. A list that restarts at `1.` after prose is a new list, and its preceding prose stays flush left. Paragraphs after the last list segment are never indented, so a closing "Thanks," is untouched.

Items containing a nested list are deliberately left whole. Outlook also mishandles that shape (#227), but that is a separate fix; the chain/segment design would extend to it by emitting the nested list outside the `<ol>` at a deeper margin.

## Impact

- Affected specs: `email-write`
- Affected code: `packages/email-core/src/content/body-renderer.ts`, new `packages/email-core/src/content/outlook-lists.ts`, `packages/email-core/src/content/frontmatter.ts`, `packages/email-core/src/actions/{compose-helpers,draft,send,reply}.ts`, `README.md`, `packages/email-agent-mcp/README.md`
- User-visible behavior: one optional input parameter per compose tool and one frontmatter key. Default rendering unchanged.
- Out of scope: nested lists inside list items (#227), ordered lists nested inside blockquotes or bullet items, and changing the default list rendering.
