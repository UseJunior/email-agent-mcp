## Why

PR #82 (closing #77) surfaced the provider-native thread handle — Graph `conversationId`, Gmail `threadId` — on `search_emails` results, so an MCP client can group messages by conversation without parsing subject lines or spending a `get_thread` round trip per message.

`list_emails` has the identical gap. It returns one row per message from `ListEmailsOutput` (`packages/email-core/src/actions/list.ts:14`) and drops the handle the provider already returned. Conversation grouping matters at least as much for an inbox or folder listing as it does for search — listing an inbox is the more common first call. The reusable pieces already exist and are exported: `SearchEmailThreadFieldsSchema` and `getSearchEmailThreadFields` (`actions/search.ts:12-22`, re-exported at `index.ts:53`). See issue #84.

## What Changes

- Extend the `list_emails` output row with the existing thread-fields fragment, in both `packages/email-core/src/actions/list.ts` and the inline `list_emails` tool schema in `packages/email-mcp/src/server.ts`.
- Spread `getEmailThreadFields(m)` in the core `list_emails` row mapping and in the custom MCP `list_emails` mapping used for both the default and an explicitly selected mailbox. There is one mapping per layer: `list_emails` has no multi-mailbox fan-out branch — that exists only for `search_emails`.
- Rename the shared export to `EmailThreadFieldsSchema` / `getEmailThreadFields` now that it is no longer search-specific, keeping `SearchEmailThreadFieldsSchema` / `getSearchEmailThreadFields` as deprecated aliases so the package's public surface stays backwards-compatible.
- Specify the contract once, in `email-threading`, covering both listing surfaces rather than restating it per action. `search_emails`' behavior ships today but was never spec-traced; this change records it alongside the new `list_emails` behavior.
- Fields stay optional and are omitted when the provider does not populate them — no new provider calls, no fallback synthesis. This is a pure response-shaping change.

## Impact

- Affected specs: `email-read`, `email-threading`
- Affected code: `packages/email-core/src/actions/list.ts`, `packages/email-core/src/actions/search.ts` (rename + aliases), `packages/email-core/src/index.ts`, `packages/email-mcp/src/server.ts`
- User-visible behavior: additive optional fields on `list_emails` rows. Existing consumers that ignore unknown fields are unaffected. Callers must not assume the field is always present — a provider that omits the handle yields a row without it, exactly as `search_emails` behaves today.
- Explicitly out of scope (per #84): server-side conversation grouping, and RFC `messageId` / `inReplyTo` / `references` exposure.
