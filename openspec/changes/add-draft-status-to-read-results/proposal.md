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

- Microsoft Graph returns `isDraft` on `message`. The `GraphMessage` interface already declares it and scheduled-send already reads it, but `mapGraphMessage` never did, and `MESSAGE_SELECT` did not select it — so `read_email` and `get_thread`'s anchor lookup actively narrowed it out of the response.
- Gmail returns the `DRAFT` label, which `mapGmailMessage` already carries into `labels`, but never projects into a row. `folder` is left `undefined` for drafts even though `FOLDER_TO_LABEL` maps `drafts → DRAFT`.

## What Changes

- Add `isDraft` to the core `EmailMessage` domain type as an optional provider-populated field.
- Populate it in both provider mappers: Graph from `message.isDraft`, Gmail from `labelIds` containing `DRAFT`. Add `isDraft` to `MESSAGE_SELECT`, the projection used by `getMessage` and by `getThread`'s anchor lookup, so those paths stop narrowing it out. `DELTA_SELECT` is deliberately left alone: it feeds only the watcher wake payload for newly-delivered inbox mail, which never surfaces draft status, and widening it would change a spec'd projection for no benefit.
- Also set Gmail's `folder` to `drafts` when the `DRAFT` label is present, closing an existing gap where a Gmail draft reported no folder at all.
- Surface `isDraft` as a **required, always-present boolean** on every read surface: `list_emails` rows, `search_emails` rows, `get_thread` message rows, and the `read_email` response — in both the core action schemas and the duplicated inline schemas in `packages/email-mcp/src/server.ts`. Always-present rather than omitted-when-false follows the precedent set for recipient topology in issue #102: an absent key is ambiguous between "not a draft" and "not reported". `false` asserts only that the provider did not mark the message as an unsent draft — received mail is `false` too — so no wording anywhere equates `false` with "the owner sent this."
- State the consequence in the tool descriptions the agent actually reads, so the field is interpreted rather than merely present: a row with `isDraft: true` has **not** been sent, its `receivedAt` is provider-supplied metadata rather than evidence of delivery, and it must never be described as sent or received.

## Impact

- Affected specs: `email-read`, `email-threading`, `provider-microsoft`, `provider-gmail`
- Affected code: `packages/email-core/src/types.ts`, `packages/email-core/src/actions/{search,list,conversation,read}.ts`, `packages/email-mcp/src/server.ts`, `packages/provider-microsoft/src/email-graph-provider.ts`, `packages/provider-gmail/src/email-gmail-provider.ts`
- User-visible behavior: one additive boolean field on four read surfaces, plus richer tool descriptions. Existing consumers that ignore unknown fields are unaffected. No filtering behavior changes — drafts are still returned by search and listing exactly as before; they are now merely labeled.
- Graph cost: `isDraft` is already on the wire for `listMessages`, `searchMessages`, and `getThread`'s paged conversation collection (none send a `$select`, so Graph's default projection includes it — verified live, 25/25 drafts). Adding it to `MESSAGE_SELECT` widens one existing projection by a single scalar field and adds no round trips.
- **Known limitation.** Those three no-`$select` paths depend on Graph's default projection, and Microsoft publishes no stable guarantee of its contents. Because the mapper coerces an absent property to `false`, a future narrowing would convert a real draft into an affirmative `isDraft: false` — a worse failure than today's no-signal. Hardening them with an explicit projection is deliberately deferred: it means narrowing three hot paths to `MESSAGE_SELECT` (which carries `uniqueBody`, material payload at 25–50 rows/page) and deserves its own change with projection-aware tests, rather than riding along here.
- Out of scope: excluding or down-ranking drafts in search/list results, a `lastModifiedAt` timestamp distinct from `receivedAt` (Graph's `lastModifiedDateTime` is the correct source and differed from `receivedDateTime` on 19 of 25 sampled live drafts — worth surfacing if edit recency ever matters), and surfacing draft status in the watcher wake payload.
