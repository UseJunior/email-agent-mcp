## Why

`update_draft` cannot safely edit the body of a reply draft, and both shipped behaviours fail silently in opposite directions.

The current provider spec says the PATCH "replaces only the caller content above the divider". Detecting that divider from the body HTML is unsound, and the two implementations of it fail differently:

- The build in wide use splices at the **first `<hr>` after `<body>`** with no marker check. Any authored horizontal rule — a markdown `---` in the composed body — becomes a false boundary, so everything below it is preserved as "quoted history" and the next update stacks a second copy of the message on top of the first.
- The current build requires an exact `id="divRplyFwdMsg"`. When that does not match it falls through to a wholesale replace, which **silently deletes the entire quoted thread**.

The marker is not stable enough to carry this weight. Gmail rewrites the id to `m_<digits>divRplyFwdMsg`, nesting on each round trip; Exchange rewrites it to `x_divRplyFwdMsg`; the two combine. A correspondent on Gmail is sufficient to break the match, and the outermost boundary is not reliably clean either. Drafts composed in Outlook mobile do not use that marker at all — they use `mail-editor-reference-message-container` — so the only `divRplyFwdMsg` present may be a Gmail-prefixed one sitting *inside* the quoted history, where splitting would delete the outer quoted layers.

Graph itself is not the constraint: `PATCH /me/messages/{id}` with a full `body` is a clean replace. The concatenation is ours.

See issue #159.

## What Changes

- **Reply drafts reject body edits.** `update_draft` with `body` or `body_file` on a reply draft SHALL return a recoverable error directing the caller to create a new draft, instead of attempting a boundary split.
- **Non-reply drafts allow an explicit replace.** Where there is no quoted history to protect, `body` is permitted behind an explicit `replace_body: true`, and performs a wholesale replace.
- **Subject stays editable on reply drafts, with a warning.** Renaming a reply is a legitimate operation — it is how a superseded draft is marked so the wrong one is not sent. It SHALL be permitted and SHALL return a non-blocking warning that altering a reply's subject may break threading in clients that group on subject.
- **A `warnings` channel is added** to draft-write responses so non-blocking advisories are machine-readable rather than prose.
- The `<hr>`/marker boundary-splice heuristic is retired.

## Scope note

Reply-draft *detection* is a provider-level determination, not a body heuristic — see `design.md`. Body sniffing is the thing this change exists to remove; reintroducing it to answer "is this a reply?" would preserve the defect under a new name.

Deploying a current build is a separate, unblocked action and is not part of this change.

## Impact

- Affected specs: `email-write`, `provider-microsoft`
- Affected code: the Microsoft provider's draft-update path (boundary detection and body merge) and the MCP `update_draft` tool schema/description
- User-visible behavior: **breaking for one case** — callers passing `body` to `update_draft` on a reply draft now receive a recoverable error where they previously received a silently-wrong draft. Both prior outcomes were defects (stale content retained, or quoted history destroyed), so no correct caller loses a working path. `subject`, `attachments`, `to` and `cc` are unaffected.
