## Why

`reply_to_email` gained a `reply_all` boolean (default `true`) in #51/#53, and the provider's `createReplyDraft` already accepts and honors `ReplyOptions.replyAll` — `reply.ts:170` passes it. The other reply surface did not get the same treatment: `create_draft` with `reply_to` calls the identical provider method at `draft.ts:131` and simply omits the option, so every reply draft created that way is unconditionally reply-all with no way to opt out.

The result is that the same intent produces different routing depending on which tool the agent reaches for, and a caller who learns `reply_all` from `reply_to_email` will reasonably assume it exists on `create_draft`. The provider plumbing is already in place; only the action-level parameter is missing. See issue #58.

Reply scope is also currently unspecified — #53 shipped `reply_all` without a spec requirement. This change specifies the behavior for both surfaces rather than only the new one, so the contract lives in one place.

## What Changes

- Add `reply_all: z.boolean().optional().default(true)` to `CreateDraftInput`, mirroring `reply_to_email`'s schema and description. Default `true` preserves today's behavior exactly.
- Forward it as `replyAll` in the `createReplyDraft` call in the `replyTo` branch of `create_draft`.
- Specify reply-scope semantics for both `reply_to_email` and `create_draft`: `reply_all: false` suppresses the *automatically derived* thread participants, and an explicitly supplied `cc` is still honored on both surfaces.
- The parameter is inert when `reply_to` is absent; a non-reply draft is unaffected.
- Correct the baseline `Draft Workflow` requirement, which states flatly that Microsoft Graph "uses `createReplyAll`". That stopped being unconditionally true when #53 landed — `prepareReplyDraft` routes to `createReply` when `replyAll` is explicitly false (`email-graph-provider.ts:852`). Left alone, the spec would contradict this change on the very page that documents it.

## Impact

- Affected specs: `email-write` (one ADDED requirement, plus a MODIFIED `Draft Workflow` correcting the `createReplyAll` claim)
- Affected code: `packages/email-core/src/actions/draft.ts` (schema + `replyTo` branch), `packages/email-mcp/src/server.ts` only insofar as `create_draft` is registered through the generic action wrapper
- User-visible behavior: purely additive. Callers that omit `reply_all` see identical routing to today.
- Verified before proposing: both providers already honor `replyAll: false` — Graph routes to `createReply` (`email-graph-provider.ts:852`), Gmail drops the derived Cc (`email-gmail-provider.ts:243-245` for the draft path, `:203` for send). This is genuinely an action-level gap, not a provider one.
- Sequencing note: this change modifies `Draft Workflow`. Any later change touching the same requirement (e.g. the reply-draft preview work split out of #87) must be written against the post-archive text produced here, not against today's baseline.
