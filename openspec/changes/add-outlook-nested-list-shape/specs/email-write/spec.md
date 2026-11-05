## MODIFIED Requirements

### Requirement: Outlook List Style

The `send_email`, `create_draft`, `update_draft`, and `reply_to_email` actions SHALL accept an optional `list_style` parameter — one of `"default" | "outlook"`, defaulting to `"default"` — and body-file frontmatter SHALL accept a `list_style` key that overrides the parameter, like `format`.

When `list_style` is `"outlook"` and the body is rendered from markdown, the system SHALL emit top-level ordered lists in the split shape Outlook's own editor saves. An ordered-list item whose content is two or more paragraphs and nothing else SHALL keep its first paragraph inside the list; the list SHALL close after that item, the remaining paragraphs SHALL follow outside the list as `<p style="margin-left:80px">`, and the list SHALL reopen with `<ol start="N">` where `N` continues the running item count. Paragraphs that sit between two top-level ordered lists, where the later list's start number continues the earlier list's count, SHALL be treated the same way, so that indented and unindented sub-paragraphs produce identical HTML. Every segment of a reshaped list SHALL carry an explicit `start`, beginning at the list's own first number.

An item of a top-level ordered or bullet list that holds exactly one nested list followed only by one or more paragraphs SHALL keep its content up to and including the nested list inside its `<li>`; the list SHALL close after that item, the paragraphs that followed the nested list SHALL come next outside the list as `<p style="margin-left:80px">`, and the list SHALL reopen after them — as `<ol start="N">` continuing the running count for an ordered list, or as `<ul>` for a bullet list. Other items of a bullet list split this way SHALL keep the markup the default mode gives them.

Bullet lists with no such item, ordered lists with no item to split and no bridging paragraphs, and items whose nested list is their last block, that hold more than one nested list, or that hold any block other than paragraphs (apart from a single nested list followed only by paragraphs) SHALL render exactly as in the default mode. Paragraphs after the last segment of a list, and paragraphs before a list that restarts its numbering, SHALL NOT be indented.

When `list_style` is omitted or `"default"`, rendering SHALL be byte-identical to the behavior without this parameter. `list_style` SHALL be ignored when `format` is `"html"` or `"text"`.

#### Scenario: Indented sub-paragraphs render in Outlook's split-list shape
- **WHEN** a markdown body has numbered items 1–3 where items 1 and 2 carry indented lettered sub-paragraphs, rendered with `list_style: "outlook"`
- **THEN** the HTML contains `<ol start="1">`, `<ol start="2">`, and `<ol start="3">` segments, each holding one item
- **AND** each lettered sub-paragraph follows its item outside the list as `<p style="margin-left:80px">`

#### Scenario: Unindented sub-paragraphs render identically
- **WHEN** the same body is written with the lettered sub-paragraphs flush left between items 1., 2., and 3.
- **THEN** the rendered HTML is byte-identical to the indented variant's

#### Scenario: A list's own start number is respected
- **WHEN** an ordered list starting at `3.` has an item with a sub-paragraph, rendered with `list_style: "outlook"`
- **THEN** the segments carry `start="3"` and then `start="4"`

#### Scenario: Lists with nothing to reshape are unchanged
- **WHEN** a body containing a bullet list with continuation paragraphs, an ordered list whose items have no sub-paragraphs, a heading, and a table is rendered with `list_style: "outlook"`
- **THEN** the HTML is byte-identical to the default rendering

#### Scenario: Items containing a nested list stay whole
- **WHEN** an ordered-list item's nested list is its last block, or the item holds two nested lists or a code block or quote after its nested list, rendered with `list_style: "outlook"`
- **THEN** the nested list and the item's other content remain inside that item's `<li>`, exactly as in the default rendering

#### Scenario: Content after a nested list moves out of the item
- **WHEN** a numbered item has a lead-in paragraph, a nested bullet list, and a follow-on paragraph, and another item follows (the issue #227 repro), rendered with `list_style: "outlook"`
- **THEN** `<ol start="1">` holds the item with its lead-in and nested list and closes after it
- **AND** the follow-on paragraph comes next outside the list as `<p style="margin-left:80px">`, after the bullets
- **AND** the list reopens as `<ol start="2">` for the next item

#### Scenario: Follow-on paragraph indentation does not change the output
- **WHEN** the follow-on paragraph of the issue #227 repro is written flush left instead of indented under its item
- **THEN** the rendered HTML is byte-identical to the indented variant's

#### Scenario: Bullet-list items with content after a nested list are split
- **WHEN** a top-level bullet item has a lead-in, a nested list, and a follow-on paragraph, rendered with `list_style: "outlook"`
- **THEN** the `<ul>` closes after that item, the paragraph follows as `<p style="margin-left:80px">`, and a new `<ul>` holds the remaining items with their default markup

#### Scenario: Closing prose and restarted lists are not indented
- **WHEN** a reshaped list is followed by a closing paragraph, or by prose and then a list that restarts at `1.`
- **THEN** those paragraphs render as plain `<p>` without a margin and the restarted list is rendered as a separate list

#### Scenario: Omitting list_style leaves rendering unchanged
- **WHEN** the issue #228 repro body, or the issue #227 repro body, is rendered with no `list_style`
- **THEN** the HTML is byte-identical to the rendering before `list_style` existed

#### Scenario: list_style is ignored for html and text formats
- **WHEN** a body is rendered with `list_style: "outlook"` and `format: "html"` or `format: "text"`
- **THEN** the output is identical to rendering without `list_style`

#### Scenario: Every compose action accepts list_style
- **WHEN** `create_draft`, `update_draft`, `send_email`, or `reply_to_email` is called with a markdown body and `list_style: "outlook"`
- **THEN** the HTML stored or sent through the provider carries the split-list shape

#### Scenario: Frontmatter list_style is authoritative
- **WHEN** a `body_file` declares `list_style: outlook` in its frontmatter and the action call omits `list_style`
- **THEN** the body is rendered in the split-list shape

## ADDED Requirements

### Requirement: Outlook Nested List Warning

The `send_email`, `create_draft`, `update_draft`, and `reply_to_email` actions SHALL inspect the HTML body they store or send — caller-supplied (`format: "html"`) or rendered from markdown — and, when any `<li>` holds a nested `<ul>` or `<ol>` followed by visible content inside the same `<li>`, SHALL include a warning with code `OUTLOOK_NESTED_LIST_REORDER` in the response's `warnings` array. The warning SHALL name the affected items by a short snippet of their lead-in text and SHALL say how to fix the markup. The HTML SHALL NOT be modified.

Whitespace, `<br>`, non-breaking spaces, and empty elements after a nested list SHALL NOT count as content. A nested list that is the last visible content of its item, and a list placed directly inside another list outside any `<li>` (Outlook's own shape), SHALL NOT produce the warning. `update_draft` SHALL check only when the call replaces the body. Text bodies (`format: "text"`) SHALL NOT be checked.

#### Scenario: HTML with content after a nested list returns a warning
- **WHEN** `create_draft` is called with `format: "html"` and the issue #227 repro HTML
- **THEN** the response includes an `OUTLOOK_NESTED_LIST_REORDER` warning naming the item
- **AND** the stored HTML is the caller's HTML unchanged

#### Scenario: Every compose action returns the nested-list warning
- **WHEN** `update_draft` (replacing the body), `send_email` (send or draft mode), or `reply_to_email` (send or draft mode) is called with the issue #227 repro HTML
- **THEN** each response includes the `OUTLOOK_NESTED_LIST_REORDER` warning and the HTML is passed to the provider unchanged

#### Scenario: A nested list that ends its item does not warn
- **WHEN** a compose action is called with HTML whose nested lists are each the last content of their item, or with a text body
- **THEN** the response carries no `warnings`

#### Scenario: Markdown bodies are checked after rendering
- **WHEN** the markdown equivalent of the issue #227 repro is rendered without `list_style`
- **THEN** the response includes the warning and suggests `list_style: "outlook"`
- **AND** with `list_style: "outlook"` the reshaped HTML produces no warning
