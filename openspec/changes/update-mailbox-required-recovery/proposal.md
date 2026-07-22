## Why

Every write action calls `checkMailboxRequired` (`packages/email-core/src/actions/compose-helpers.ts:24`), which returns a payload naming the constraint but not the values that satisfy it:

```json
{ "code": "MAILBOX_REQUIRED", "message": "mailbox parameter required when multiple mailboxes are configured", "recoverable": false }
```

The helper already receives `ctx.allMailboxes` — the exact list the caller needs — and discards it. An agent hitting this error must make a discovery round trip before it can retry, and `recoverable: false` actively tells it not to bother: the caller *can* recover, in one retry, by naming a mailbox. Error-driven recovery is the dominant agent pattern; an error that withholds the valid values converts a one-step recovery into a two-step one. See issue #92.

## What Changes

- Extend the `MAILBOX_REQUIRED` payload with `availableMailboxes: string[]` (mailbox **names**, which the `mailbox` selector accepts) and `defaultMailbox?: string`.
- Change `recoverable` from `false` to `true` on this error only — supplying a listed name clears the mailbox-selection condition. It does not promise the call then succeeds; unrelated validation, allowlist, and provider checks still apply, and the spec says so explicitly.
- Keep `code` and the message string byte-identical, so callers matching on either are unaffected. The wording complaint raised alongside #92 is deliberately **not** addressed here; the existing `email-write` scenario asserts that exact string.
- Source the values from `ctx.allMailboxes` (`MailboxEntry.name` / `.isDefault`), which the MCP server populates via `resolveMailboxContext` (`packages/email-mcp/src/server.ts:468`, threaded into the action context at `:721`). No new provider calls and no new state.
- Note the scope precisely: that context is built from **connected** mailboxes, so the payload enumerates the mailboxes available for dispatch, not necessarily every mailbox on disk.
- Establish in `mailbox-config` that a mailbox `name` is a round-trippable *selector*. This deliberately does **not** call `name` the canonical identity — the baseline `Mailbox Canonical Identity` requirement already assigns that role to the email address, with the name as an accepted alias. The new requirement is subordinate to it, not a competing definition.

## Impact

- Affected specs: `email-write`, `mailbox-config`
- Affected code: `packages/email-core/src/actions/compose-helpers.ts`, plus the four output schemas that carry the error shape — `SendEmailOutput` (`send.ts:39`), `ReplyToEmailOutput` (`reply.ts:37`), `DraftOutput` (`draft.ts:25`), `SendDraftOutput` (`draft.ts:182`)
- User-visible behavior: additive fields on an existing error. The only non-additive change is `recoverable: false` → `true`; a caller that branches on `recoverable` will now retry where it previously gave up, which is the intended fix. Verified safe: the retry machinery branches on thrown `ProviderError.recoverable` (`provider.ts:244`, `compose-helpers.ts:393`), never on this returned action error, so there is no path to a retry loop.
- Independent of issue #93. `ctx.allMailboxes` is available today, and the round-trip guarantee is asserted directly against action dispatch rather than through `list_mailboxes` — which core implements but `buildLazyActions()` does not register as an MCP tool. That gap is #93's job, not this change's.
