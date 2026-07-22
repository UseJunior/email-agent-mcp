## Context

This change rests on Microsoft Graph behavior nobody in this repo has verified, and it changes the default content of a response field callers already depend on. Both facts shape the design below.

## Decision 1: verify Graph `uniqueBody` before building on it

Graph exposes `message.uniqueBody`, documented as the portion of the message unique to the current message, retrievable via `?$select=uniqueBody`. The draft actions already perform a post-write `GET /messages/{draftId}` for the preview, so selecting `uniqueBody` there would give us the authored region without parsing provider-generated HTML.

That is the preferred implementation **only if it holds up**. Before any code depends on it, verify against real `createReply` and `createReplyAll` drafts that `uniqueBody`:

1. is populated while `isDraft` is still `true`;
2. contains the persisted rendered authored HTML, including the `force_black` wrapper this project adds;
3. excludes the auto-quoted thread; and
4. updates correctly after a PATCH to the reply draft.

Verification command:

```bash
curl -fsS -H "Authorization: Bearer $GRAPH_ACCESS_TOKEN" \
  "https://graph.microsoft.com/v1.0/me/messages/$DRAFT_ID?\$select=id,isDraft,body,uniqueBody"
```

Exercise both `reply_all: true` and `false`. This mirrors the discipline the scheduled-send spike (#61) used: Graph's documented behavior and Graph's actual behavior on drafts are not reliably the same thing, and mocks cannot catch the difference.

## Decision 2: a provider-neutral field, not a Graph field

`buildDraftPreview` lives in `email-core` and takes a `Pick<EmailReader, 'getMessage'>`. It must not learn what `uniqueBody` is, nor which provider it is talking to — `email-core` does not depend on `provider-microsoft` and should not start.

So the contract is a new optional `EmailMessage.authoredBodyHtml?: string`:

- The Microsoft provider maps Graph's `uniqueBody` (`{contentType, content}`) into it when the value passes verification, or falls back to its own unambiguous reply-boundary detection, and leaves it `undefined` when neither is safe.
- Other providers never populate it.
- `buildDraftPreview` uses it only when the calling action explicitly requests authored-only behavior, and only when it actually differs from the persisted `bodyHtml`.

This keeps the fallback heuristic on the provider side where the provider-specific HTML anatomy is already understood, and keeps the core logic a simple three-way check: requested, present, different.

One consequence to accept openly: there is no dedicated draft read-back path to hook. `buildDraftPreview` calls the generic `EmailReader.getMessage`, and the Graph provider has exactly one implementation of it (`email-graph-provider.ts:332`). So `uniqueBody` must be added to that method's `$select`, and *every* Graph message read will carry the optional field — not just draft previews. The alternative, a dedicated preview-read method on the provider interface, is a broader interface change than this feature justifies. Widening the generic read is the smaller cost, but it should be a decision rather than an accident.

## Decision 3: structural extraction is a fallback, and it fails open

If `uniqueBody` proves absent or inconsistent for drafts, fall back to structural extraction — but only behind an unambiguous Graph reply boundary.

Matching the first `<hr>` is not acceptable. Authored HTML legitimately contains `<hr>`, and this project renders markdown to HTML, so a caller's `---` becomes one. `gmail_quote` and mobile-client classes are not Graph reply boundaries at all.

When no boundary can be identified with confidence, return the **full** persisted preview and do not set `quotedHistoryOmitted`. A preview that silently drops authored text is worse than a preview that is too long: the entire value of the persisted read-back is that a caller can trust it reflects what was stored.

## Decision 4: scope to Microsoft reply drafts, and not to `send_email`

Fresh drafts and Gmail-created reply drafts carry no provider-assembled quote chain, so there is nothing to omit and no reason to run extraction over them. Restricting the behavior keeps the blast radius small and makes the fail-open path rare rather than routine.

`send_email(draft: true)` stays unchanged for the same reason: it creates a draft but not a *reply* draft. #110 named three surfaces; adding a fourth would extend a default-behavior change past what was asked for.

## Decision 5: assert the invariant we own, not the one we don't

"The stored draft retains the full quote chain" is the property that matters, but as a permanent unit-test obligation it is untestable — proving it end-to-end needs a live mailbox and a delivered message.

The spec therefore asserts the code-owned invariant instead: building the preview performs no provider write, and the message used for the read-back still carries the complete history. A live smoke can verify the delivered-message property; the mandatory scenario stays on the part this codebase actually controls.

## Open question

An exact omitted-character count would be more useful than a boolean, but only if computable exactly. Under `uniqueBody` it is a byte difference between two provider-returned strings and is exact; under structural extraction it is an approximation. The boolean is the contract. A count, if added later, is additive and must never be an estimate.
