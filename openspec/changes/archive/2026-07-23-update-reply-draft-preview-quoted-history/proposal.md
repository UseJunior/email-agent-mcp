## Why

Draft-producing tools return a persisted `preview.bodyHtml` read back from the provider. For Microsoft Graph reply drafts, that read-back contains Graph's full auto-quoted thread alongside the authored text.

The persisted read-back is deliberate and worth keeping: it is how a caller verifies the actual stored recipients and rendered body rather than an echo of its own request (#75), and it is what makes persistence-layer drops like #48 visible without a second round trip. But on a long thread the quoted chain can cost several thousand tokens per draft write — none of it authored by the caller, and most of it already in the agent's context from earlier turns. The response is already capped at 32 KiB with a `bodyHtmlTruncated` signal, which bounds the damage without addressing it.

This affects `create_draft` with `reply_to`, `update_draft` on an existing Graph reply draft, and `reply_to_email` with `draft: true`. It is specific to Microsoft reply drafts; fresh drafts and Gmail-created reply drafts carry no provider-assembled quote chain.

Originally filed as #110 and folded into #87.

## What Changes

- Add `include_quoted: boolean` (default `false`) to `create_draft`, `update_draft`, and the draft branch of `reply_to_email`.
- By default, return only the authored portion of `preview.bodyHtml` for recognized Microsoft reply drafts, and set `quotedHistoryOmitted: true`. `include_quoted: true` restores today's full persisted preview.
- Add a provider-neutral `EmailMessage.authoredBodyHtml?: string`. The Microsoft provider populates it from a verified Graph `uniqueBody`, or from an unambiguous reply-boundary detector, and leaves it `undefined` when neither source is safe. `buildDraftPreview` consumes only this field — no provider-specific logic and no `provider-microsoft` dependency leaks into `email-core`.
- Change nothing about what is stored or sent: the stored draft keeps its full quote chain.
- Leave `send_email(draft: true)` unchanged. It is a draft-creating surface but not a reply surface, and quietly extending it would broaden the behavior change beyond what #110 asked for.

## Scope note

This was split out of `update-read-email-strip-signatures` on review. The GitHub issues stay folded — #110 is closed into #87, and #87 owns both scopes — but the OpenSpec changes are separate because this half depends on live Graph behavior that has not been verified, and the read-path half does not. Bundling them would block a three-line wiring change behind a mailbox spike. Two change-ids under one issue is normal; an unarchivable change is not.

## Dependencies and sequencing

- Depends on `add-create-draft-reply-all` (#58), which also modifies `Draft Workflow`. The MODIFIED block here is written against the **post-#58** text (`createReply` or `createReplyAll` according to `reply_all`). If #58's ordering changes, rebase this delta before implementing.
- The MODIFIED block also adds `bcc` to the preview tuple. That is a deliberate **baseline correction**, not part of this feature: `DraftPreviewSchema` has carried `bcc` since #102, and the baseline spec text simply never caught up. Flagged here so it is not mistaken for silent scope creep.
- Phase 1 of `tasks.md` is a hard gate. Do not write Phase 2 or Phase 3 code before the Graph `uniqueBody` verification is complete and written up on #87.

## Impact

- Affected specs: `email-write`
- Affected code: `packages/email-core/src/types.ts` (`authoredBodyHtml`), `packages/email-core/src/actions/compose-helpers.ts` (`DraftPreviewSchema`, `buildDraftPreview`), `packages/email-core/src/actions/draft.ts`, `packages/email-core/src/actions/reply.ts`, `packages/provider-microsoft/src/email-graph-provider.ts`
- User-visible behavior: this **alters the default content of an existing response field** (`preview.bodyHtml`). It is an intentional behavior change requiring a release note, signalled structurally via `quotedHistoryOmitted` and reversible per call via `include_quoted: true`.
- Principal risk: an over-eager boundary match strips authored content out of the preview and tells the caller their draft is wrong when it is not. Fail-open is therefore a spec requirement, not an implementation preference.
