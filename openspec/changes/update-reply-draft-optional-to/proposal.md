# Make `to` Optional on Reply Drafts

## Why

`create_draft` still rejects a reply that omits `to` with `MISSING_FIELD`, even though `reply_to` plus `reply_all` already determine the recipient set. Callers must re-derive and repeat the parent's sender — including on a reply to their own sent message, where the correct recipients are the ones the provider derives, not the caller's own address. This is the remaining edge after issue #164, which made an explicit `to` effective but left it mandatory.

## What Changes

- Require `to` only for new drafts; a reply draft with `reply_to` may omit it.
- When `to` is omitted on the reply path, forward no `to` to the provider so it derives recipients from the parent message under `reply_all`.
- Keep an explicitly supplied `to` as a replacement for the derived To (issue #164 behavior), and keep explicit `cc` merging as today.
- Update the `create_draft` tool and `to` parameter descriptions so callers know `to` is optional on the reply path.

## Impact

- Affected specs: `email-write`
- Affected code: `email-core` draft validation and tests
