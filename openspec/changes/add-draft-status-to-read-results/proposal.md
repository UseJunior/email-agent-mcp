## Why

Read actions return unsent drafts in the same JSON shape as delivered mail, with no field that says so. A `search_emails` row for a draft looks exactly like a row for a sent message:

```json
{
  "id": "AQMkAD…",
  "subject": "RE: Sfumato Fund Docs",
  "from": "Steven Obiajulu <Steven@usejunior.com>",
  "receivedAt": "2026-07-25T17:50:18Z",
  "isRead": true,
  "hasAttachments": false,
  "mailbox": "Steven@usejunior.com"
}
```

Every cue in that row reads as "sent": the mailbox owner is in `from`, the subject is a reply prefix, and `receivedAt` carries a plausible timestamp (for a Graph draft it is the creation/modification time, not a delivery time). Agents consuming these results routinely report the draft as an email that was already sent — which is a correctness failure with real consequences, since the user then believes a reply went out when it never did.

The signal exists at both providers and is being thrown away:

- Microsoft Graph returns `isDraft` on `message`. `GraphMessage.isDraft` is already declared (`packages/provider-microsoft/src/email-graph-provider.ts:1565`) and used by scheduled-send (`:929`), but `mapGraphMessage` never reads it, and `MESSAGE_SELECT` (`:215`) does not select it — so `read_email` and `get_thread` actively narrow it out of the response.
- Gmail returns the `DRAFT` label, which `mapGmailMessage` already carries into `labels` (`packages/provider-gmail/src/email-gmail-provider.ts:474`), but never projects into a row. `folder` is left `undefined` for drafts even though `FOLDER_TO_LABEL` maps `drafts → DRAFT` (`:25`).

## What Changes

- Add `isDraft` to the core `EmailMessage` domain type as an optional provider-populated field.
- Populate it in both provider mappers: Graph from `message.isDraft`, Gmail from `labelIds` containing `DRAFT`. Add `isDraft` to `MESSAGE_SELECT` so `getMessage`/`getThread` — the two Graph paths that send an explicit `$select` — stop narrowing it out. `DELTA_SELECT` is deliberately left alone: it feeds only the watcher wake payload for newly-delivered inbox mail, which never surfaces draft status, and widening it would change a spec'd projection for no benefit.
- Also set Gmail's `folder` to `drafts` when the `DRAFT` label is present, closing an existing gap where a Gmail draft reported no folder at all.
- Surface `isDraft` as a **required, always-present boolean** on every read surface: `list_emails` rows, `search_emails` rows, `get_thread` message rows, and the `read_email` response — in both the core action schemas and the duplicated inline schemas in `packages/email-mcp/src/server.ts`. Always-present rather than omitted-when-false follows the precedent set for recipient topology in issue #102: an absent key is ambiguous between "not a draft" and "not reported", and only an explicit `false` positively asserts the message was really sent.
- State the consequence in the tool descriptions the agent actually reads, so the field is interpreted rather than merely present: a row with `isDraft: true` has **not** been sent, its `receivedAt` is a creation/modification time rather than a delivery time, and it must never be described as sent or received.

## Impact

- Affected specs: `email-read`, `email-threading`, `provider-microsoft`, `provider-gmail`
- Affected code: `packages/email-core/src/types.ts`, `packages/email-core/src/actions/{search,list,conversation,read}.ts`, `packages/email-mcp/src/server.ts`, `packages/provider-microsoft/src/email-graph-provider.ts`, `packages/provider-gmail/src/email-gmail-provider.ts`
- User-visible behavior: one additive boolean field on four read surfaces, plus richer tool descriptions. Existing consumers that ignore unknown fields are unaffected. No filtering behavior changes — drafts are still returned by search and listing exactly as before; they are now merely labeled.
- Graph cost: `isDraft` is already on the wire for `listMessages`/`searchMessages` (no `$select` is sent, so Graph's default projection includes it). Adding it to `MESSAGE_SELECT`/`DELTA_SELECT` widens two existing projections by one scalar field and adds no round trips.
- Out of scope: excluding or down-ranking drafts in search/list results, a `sentAt`/`lastModifiedAt` timestamp distinct from `receivedAt`, and surfacing draft status in the watcher wake payload.
