## Context

Issue #87 asks for a parameter to be wired through, and explicitly poses the default as an open question with two options. This file records the answer and why.

## Decision: MCP `strip_signatures` defaults to `false`, not the action's `true`

`readEmailAction` defaults `strip_signatures` to `true`. Adopting that default at the MCP layer would change the body returned to every existing MCP caller with no opt-out signal in the response — a silent content change on the most-used read tool, and one a caller could only detect by diffing against a body they no longer have.

`false` preserves today's MCP behavior and makes the capability opt-in. The tool description carries the discovery burden instead.

This leaves the MCP tool and the core action with different defaults for the same parameter. That inconsistency is real and should be documented in the tool description rather than hidden. It is still the better trade: the alternative buys consistency with an undetectable behavior change.

The signature heuristic is intentionally aggressive (`packages/email-core/src/content/signatures.ts` — it matches RFC-3676 `-- ` delimiters, "Sent from my iPhone" footers, and confidentiality disclaimers). An aggressive, lossy transform should be requested, not inherited.

## Composition order

`readEmailAction` already applies `transformEmailContent` → `stripQuotedHistory` → `stripSignature`. Exposing `strip_signatures` does not change that order; it only makes the last stage reachable from MCP. The spec states the order so callers setting both flags know what they get, and so a future refactor cannot silently reorder two lossy transforms.

## Related work

The reply-draft-preview half of #87 (folded in from #110) is proposed separately as `update-reply-draft-preview-quoted-history`. See that change's `design.md` for the Graph `uniqueBody` verification plan — nothing in this change depends on it.
