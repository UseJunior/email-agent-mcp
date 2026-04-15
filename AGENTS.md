# Agent Email — AI Agent Instructions

## OpenSpec Instructions

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

## Project Conventions

- TypeScript ESM with explicit `.js` import suffixes
- snake_case for MCP tool/action names, PascalCase for types/interfaces
- All email actions defined in `packages/email-core/src/actions/` — the single source of truth
- MCP server and CLI are thin adapters — never put business logic in transport layers
- Zod v4 schemas as single source of truth for tool input validation
- Tests: Vitest with spec traceability
- Logging: ALWAYS to stderr, NEVER stdout (corrupts MCP stdio transport)

## Draft & Reply Tools — extended flags

`create_draft` and `reply_to_email` support three extra behaviors beyond
simple body+recipients. These are driven by parameters on the MCP tool
call (and, for `create_draft`, also by YAML frontmatter in a `body_file`).

### `attachments` — outbound file attachments

Pass an array of file paths. Paths are resolved against the directory
pointed to by the environment variable `EMAIL_AGENT_MCP_ATTACHMENT_DIR`,
which **must be set, absolute, and refer to an existing directory**.
Paths outside that sandbox — including sibling-prefix attacks like
`/allowed-evil/x.pdf` when the base is `/allowed`, and symlink escapes —
are rejected via realpath-based `path.relative()` checks.

- **Size cap:** 3 MiB per file. Zero-byte files are allowed.
- **Dedupe:** multiple paths that resolve to the same realpath (via
  symlinks or relative/absolute duplication) become a single attachment.
- **Filename collisions:** if two different files share a basename, the
  second gets `(2)` inserted before the extension (`report.pdf` →
  `report (2).pdf`), matching native-client behavior.
- **`body_file` frontmatter:** if `body_file` lists `attachments:` in
  its frontmatter, those paths are unioned with the parameter list
  (dedup by realpath). Attachments are the one field where frontmatter
  and parameter values are additive rather than frontmatter-wins.
- **Rollback:** on Microsoft, attachments are uploaded via follow-up
  `POST /messages/{id}/attachments`. If any upload fails, the draft is
  `DELETE`d so there's no half-attached draft in the user's mailbox.
  If the cleanup DELETE also fails, the orphaned draftId is logged to
  stderr.
- **Gmail:** outbound attachments return `NOT_SUPPORTED` — Gmail's
  `buildRawMessage` doesn't yet emit `multipart/mixed`. Documented
  follow-up.

### `reply_all` — sender-only vs reply-all

Default `true` (reply to all original recipients, matching the historical
behavior of Microsoft's `createReplyAll`). Set to `false` to narrow to
the original sender only.

- **Microsoft:** switches between `POST /messages/{id}/createReplyAll`
  and `POST /messages/{id}/createReply` endpoints.
- **Gmail:** when `replyAll=false`, skips the `mergeAddressLists(to, cc)`
  auto-population; when `replyAll=true`, includes original `to + cc` in
  the outgoing `Cc` header.
- **Reply-all send path goes through a draft.** `reply_to_email` (send
  mode) creates a draft server-side, fetches the populated recipients,
  allowlist-checks them, and only then calls `sendDraft`. This closes
  a bypass where the old code only checked `from.email` while Graph's
  `createReplyAll` silently cc'd every original recipient.
- **`create_draft(reply_to=...)` validation:** `to` and `subject` are
  NOT required when creating a reply draft — the provider auto-
  populates them from the original thread. They are still required
  when `reply_all=false` (you must explicitly name the narrowed
  recipient).

### `update_source_frontmatter` — back-link the draft into your .md file

Opt-in flag (default `false`) on `create_draft`. When `true` AND
`body_file` is set AND draft creation succeeds, the tool patches the
source Markdown file's frontmatter with:

- `draft_id: <id>` and `draft_link: <outlook-deep-link>` for standard
  drafts
- `draft_reply_id: <id>` and `draft_reply_link: <outlook-deep-link>`
  for reply drafts (matches `save_draft_to_outlook.py` convention)

The Outlook deep link is
`https://outlook.office.com/mail/deeplink/compose?ItemID=<urlencoded-draftId>`.

This is **silent-fail**: if the write fails (read-only file, unsupported
multiline YAML, missing closing `---`), the helper logs to stderr and
returns — the draft was already created, and the back-link is a
convenience metadata patch, not a delivery guarantee.

### Worked example

```yaml
# weekly-status.md
---
reply_to: AAMkAGI2TG93AAA=
reply_all: false
attachments: q1-report.pdf
---

Here's the quarterly rollup — let me know if anything looks off.
```

```json
// MCP tool call
{
  "tool": "create_draft",
  "arguments": {
    "body_file": "weekly-status.md",
    "attachments": ["q2-addendum.pdf"],
    "update_source_frontmatter": true
  }
}
```

This creates a reply draft to the sender of message `AAMkAGI2TG93AAA=`
only (no cc), with both `q1-report.pdf` and `q2-addendum.pdf` attached
(merged from frontmatter + parameter), then writes `draft_reply_id`
and `draft_reply_link` back into `weekly-status.md` so you can reopen
the draft in Outlook from the source file.
