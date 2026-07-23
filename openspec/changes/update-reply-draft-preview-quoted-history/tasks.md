### Phase 1 — verify Graph `uniqueBody` (hard gate: no Phase 2 code before this is done)

- [x] Against a real Outlook mailbox, create both a `createReply` and a `createReplyAll` draft and record whether `uniqueBody` is populated while `isDraft: true`
- [x] Verify `uniqueBody.content` contains the persisted authored HTML including the `force_black` wrapper, and excludes the assembled thread history
- [x] Verify `uniqueBody` updates correctly after PATCHing the reply draft via `update_draft`
- [x] Write the findings up on issue #87. If `uniqueBody` fails verification, decide between provider-side structural extraction and deferring this change entirely — do not proceed on an assumption

### Phase 2 — provider-neutral plumbing

- [x] Add `authoredBodyHtml?: string` to `EmailMessage` in `packages/email-core/src/types.ts`
- [x] Map Graph's `uniqueBody` `{contentType, content}` shape onto `authoredBodyHtml` in the **generic** `GraphEmailProvider.getMessage()` (`email-graph-provider.ts:332`). There is no dedicated draft read-back path — `buildDraftPreview` calls `EmailReader.getMessage`, so `$select` must be widened there. Accept the consequence explicitly: every Graph message read gains the optional field
- [x] Add a negative control to the Phase 1 verification: confirm that for a **fresh** (non-reply) Graph draft, `uniqueBody` equals the full body — or that the mapping leaves `authoredBodyHtml` unset — so `update_draft` can never misclassify a fresh draft as authored-only
- [x] Implement the provider-side structural fallback behind an unambiguous reply boundary, leaving `authoredBodyHtml` undefined when none is found. Keep it in `provider-microsoft` — `email-core` must not gain a dependency on it
- [x] Add `quotedHistoryOmitted: z.boolean().optional()` to `DraftPreviewSchema` in `packages/email-core/src/actions/compose-helpers.ts`
- [x] Teach `buildDraftPreview` to accept an explicit authored-only request and use `authoredBodyHtml` only when it is present AND differs from the persisted `bodyHtml`; set `quotedHistoryOmitted` only in that case

### Phase 3 — action surfaces

- [x] Add `include_quoted: z.boolean().optional().default(false)` to `create_draft`, `update_draft`, and `reply_to_email`, with a `.describe()` stating it affects only the preview, never the stored or sent body
- [x] Pass the flag explicitly to `buildDraftPreview` from `create_draft`, `update_draft`, and **only the draft branch** of `reply_to_email`
- [x] Leave `send_email(draft: true)` unchanged — verify it still receives the full persisted preview
- [x] Verify the 32 KiB `PREVIEW_BODY_LIMIT` cap and `bodyHtmlTruncated` still apply to whichever body is returned

### Phase 4 — tests and gate

- [x] Add tests under `describe('email-write/Authored-Only Reply Draft Preview')` covering: authored and full HTML differing, being equal (flag must stay unset), the provider signal absent (fail open), `include_quoted: true`, no provider write during preview construction, and Gmail/fresh drafts unaffected
- [x] Every `create_draft` test call MUST supply `to` and `subject` — `validateRequiredFields` runs at `draft.ts:88`, before the `replyTo` branch, so a `{reply_to, body}`-only call returns `MISSING_FIELD` and never reaches the provider
- [x] Assert semantically, not just by scenario name: the coverage checker does not bind an `it()` to its enclosing `describe()`
- [x] Live smoke against a real Outlook reply draft — mocks cannot catch Graph read-back behavior
- [x] Confirm the MODIFIED `Draft Workflow` block still matches the post-`add-create-draft-reply-all` baseline; rebase the delta if #58 archived with different wording
- [x] Run `openspec validate update-reply-draft-preview-quoted-history --strict`
- [x] Run `npm run test:run --workspaces`, `npm run lint --workspaces`, and `npm run check:spec-coverage`
- [x] Draft the release note for the `preview.bodyHtml` default change
