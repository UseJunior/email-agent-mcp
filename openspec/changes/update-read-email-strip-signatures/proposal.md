## Why

`readEmailAction` accepts `strip_signatures` and defaults it to `true` (`packages/email-core/src/actions/read.ts:11`), but the MCP `read_email` tool hardcodes `strip_signatures: false` (`packages/email-mcp/src/server.ts:832`) with a comment marking it as deferred work. MCP callers — the primary consumers of this server — cannot opt into the signature stripping the core already implements and tests.

#76 is what unblocks this: it refactored MCP `read_email` into a thin adapter over `readEmailAction.run()`, so exposing the flag is now a parameter-passing change rather than a reimplementation. See issue #87.

## What Changes

- Add `strip_signatures: z.boolean().optional().default(false)` to the inline MCP `read_email` input schema and forward the caller's value to `readEmailAction.run()` instead of the hardcoded `false`.
- Default `false`, not the action's `true` — see `design.md`. Matching the action default would silently change the body every existing MCP caller receives.
- Update the tool description so the flag is discoverable in the tool listing.
- Specify that the two stripping flags compose, in the established order: quoted-history stripping first, then signature stripping.

## Scope note

Issue #87 also absorbed #110 (omitting Graph's auto-quoted history from Microsoft reply-draft previews). That half is **not** in this change. It is proposed separately as `update-reply-draft-preview-quoted-history` because it depends on live Microsoft Graph behavior (`uniqueBody` on drafts) that has not been verified, and bundling an unverified spike with a three-line wiring change would block the latter behind the former. The GitHub issues stay folded; only the OpenSpec changes are separate, so each can be validated, implemented, and archived on its own schedule.

## Impact

- Affected specs: `email-read`
- Affected code: `packages/email-mcp/src/server.ts` (`read_email` tool schema, description, and the delegated call)
- User-visible behavior: purely additive and opt-in. Callers that omit the flag receive exactly what they receive today. This deliberately leaves the MCP tool and the core action with different defaults — a documented inconsistency, chosen over an undetectable behavior change.
