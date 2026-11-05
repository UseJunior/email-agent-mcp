## ADDED Requirements

### Requirement: Outlook List Style

The `send_email`, `create_draft`, `update_draft`, and `reply_to_email` actions SHALL accept an optional `list_style` parameter — one of `"default" | "outlook"`, defaulting to `"default"` — and body-file frontmatter SHALL accept a `list_style` key that overrides the parameter, like `format`.

When `list_style` is `"outlook"` and the body is rendered from markdown, the system SHALL emit top-level ordered lists in the split shape Outlook's own editor saves. An ordered-list item whose content is two or more paragraphs and nothing else SHALL keep its first paragraph inside the list; the list SHALL close after that item, the remaining paragraphs SHALL follow outside the list as `<p style="margin-left:80px">`, and the list SHALL reopen with `<ol start="N">` where `N` continues the running item count. Paragraphs that sit between two top-level ordered lists, where the later list's start number continues the earlier list's count, SHALL be treated the same way, so that indented and unindented sub-paragraphs produce identical HTML. Every segment of a reshaped list SHALL carry an explicit `start`, beginning at the list's own first number.

Bullet lists, ordered lists with no item to split and no bridging paragraphs, and items that contain a nested list or any block other than paragraphs SHALL render exactly as in the default mode. Paragraphs after the last segment of a list, and paragraphs before a list that restarts its numbering, SHALL NOT be indented.

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
- **WHEN** an ordered-list item contains a nested bullet list, rendered with `list_style: "outlook"`
- **THEN** the nested list and the item's paragraphs remain inside that item's `<li>`

#### Scenario: Closing prose and restarted lists are not indented
- **WHEN** a reshaped list is followed by a closing paragraph, or by prose and then a list that restarts at `1.`
- **THEN** those paragraphs render as plain `<p>` without a margin and the restarted list is rendered as a separate list

#### Scenario: Omitting list_style leaves rendering unchanged
- **WHEN** the issue #228 repro body is rendered with no `list_style`
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
