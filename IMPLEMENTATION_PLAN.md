# Plan: Complete Stubs, Implement Watcher, Fix Mailbox Naming, Add Integration Tests

## Context

Post-E2E audit revealed stubs hidden behind passing unit tests. The watcher (agent invocation by incoming email) is completely stubbed. This plan addresses all gaps with corrections from Gemini + Codex peer review.

## Architecture Decisions (Peer-Review Corrected)

### 1. Graph Endpoint: `/mailFolders/Inbox/messages`, NEVER bare `/messages`
- `/me/messages` returns ALL folders (junk, sent, deleted) — WRONG for watcher
- `/me/mailFolders/Inbox/messages/delta` with `$select=subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments` for efficiency
- Handle `@removed` tombstones (deleted/moved messages) — filter them out
- Handle `@odata.nextLink` paging during initial baseline sync
- Handle `410 Gone` / `syncStateNotFound` — full resync

### 2. Delta Query: Proper Sync Protocol
- **Initial baseline sync**: On first run, consume ALL pages (follow `@odata.nextLink`) silently — do NOT wake. Only save the final `@odata.deltaLink`.
- **Subsequent polls**: Use saved `deltaLink` → get only new changes → wake for new messages only
- **Persist delta state**: Save `deltaLink` to `~/.agent-email/state/{mailbox-id}.delta.json` — survives restarts
- **Tombstone filtering**: Skip items with `@removed` (these are deletes/moves, not new mail)
- **Replay handling**: Delta can return duplicates — dedup by message ID
- **410 Gone reset**: If deltaLink expires (7+ days inactive), do full baseline resync

### 3. Email Address: Single Source of Truth
- Store `emailAddress: string` in `MailboxMetadata` ONLY (the one persistent source)
- Fetch from Graph `/me` during `configure` — fallback to `userPrincipalName` if `mail` is null
- **Filename**: Use filesystem-safe derived key (lowercase, replace non-alphanumeric with `-`), NOT raw email
  - `steven@usejunior.com` → filename: `steven-usejunior-com.json`
  - Raw email stored inside the JSON, not in filename
- Tool inputs: accept email address OR alias; lookup by either

### 4. Wake Payload: Text-Only for `/hooks/wake`
OpenClaw's `normalizeWakePayload` strips everything except `text` and `mode`. Structured fields are ignored.

```json
{
  "text": "New email to steven@usejunior.com from Alice Smith <alice@corp.com>: Contract Review — Q1 2024\nTo: steven@usejunior.com, bob@corp.com\nCc: team@corp.com\nAttachments: yes",
  "mode": "now"
}
```

The `text` field is self-contained — includes receiving mailbox, sender, recipients, subject, attachment indicator. Formatted for LLM readability. No structured `email` object (OpenClaw ignores it).

### 5. Watcher Security: Receive Allowlist
- Load receive allowlist on watcher start
- Gate each new message against `isAllowedSender()` BEFORE waking
- Default: accept all (wildcard `*`) — but log warning if no allowlist configured
- Explicit in spec as v1 behavior

### 6. Stale Build Prevention: Structural Fix
- Add `"pretest": "npm run build"` to each workspace package.json
- Add `"dev:serve": "tsx packages/email-mcp/src/serve-entry.ts"` to root package.json (for development — runs from source)
- Integration tests import from dist and verify expected exports exist

---

## Stubs to Implement

| # | Stub | Severity |
|---|------|----------|
| 1 | `runWatch()` — exits immediately | **CRITICAL** |
| 2 | `getDeltaMessages()` — no paging, no tombstones, no state persistence | **CRITICAL** |
| 3 | `GmailAuthManager.connect()` — mock tokens | MEDIUM |
| 4 | `ClientCredentialsAuthManager.connect()` — mock tokens | MEDIUM |
| 5 | `GmailEmailProvider.createDraft/sendDraft()` — fake IDs | MEDIUM |
| 6 | `dedupThreadContent()` — no-op | LOW (**Accepted v1**) |

---

## Work Packages

### WP1: Spec Updates (establish contracts first)
**Files:** `openspec/specs/mailbox-config/spec.md`, `openspec/specs/email-watcher/spec.md`, `openspec/specs/provider-microsoft/spec.md`

1. `mailbox-config`: mailbox canonical ID = email address, optional alias, filesystem-safe filename
2. `email-watcher`: wake payload is text-only `{text, mode}`, delta query protocol with baseline sync, receive allowlist gating, per-mailbox lock file
3. `provider-microsoft`: explicit "NEVER bare `/messages`" rule, `$select` for delta efficiency

### WP2: Mailbox Naming + Email Address
**Files:** `provider-microsoft/src/auth.ts`, `email-core/src/actions/registry.ts`, `email-mcp/src/cli.ts`, `email-mcp/src/server.ts`

1. Add `emailAddress: string` to `MailboxMetadata`
2. Configure: fetch email from `/me`, fallback to `userPrincipalName`
3. Filesystem-safe filename: `steven-usejunior-com.json` (lowercase, sanitized)
4. Store raw email in metadata JSON
5. Tool inputs: accept email or alias, lookup by either

**Test:** Run `configure`, verify metadata file exists with correct email, verify `list_mailboxes` shows email.

### WP3: Real Watcher with Delta Query
**Files:** `email-mcp/src/watcher.ts`, `email-mcp/src/cli.ts`, `provider-microsoft/src/email-graph-provider.ts`

1. Fix `getDeltaMessages()`: proper `$select`, `@odata.nextLink` paging, `@removed` filtering
2. Implement delta state persistence: `~/.agent-email/state/{mailbox-id}.delta.json`
3. Implement `runWatch()`:
   - Load mailboxes, create providers
   - First run: silent baseline sync (consume all pages, save deltaLink, don't wake)
   - Poll loop: get delta changes → filter tombstones → dedup → check receive allowlist → build text payload → POST wake
   - Interval: `--poll-interval <seconds>` (default 30)
   - Lock file: `~/.agent-email/state/{mailbox-id}.watcher.lock`
   - Graceful shutdown on SIGINT/SIGTERM
   - Log every cycle and every wake to stderr
4. Receive allowlist: gate each new message before waking

**Test:** Start watcher → verify baseline sync logs → wait for organic email or send test → verify wake POST → verify dedup → verify lock file.

### WP4: Client Credentials Auth (Real)
**Files:** `provider-microsoft/src/auth.ts`

Replace mock with real `ClientSecretCredential`.

### WP5: Gmail Auth + Draft (Real)
**Files:** `provider-gmail/src/auth.ts`, `provider-gmail/src/email-gmail-provider.ts`

Replace mocks with real `@googleapis/gmail` OAuth2. Real `createDraft`/`sendDraft`.

### WP6: Integration Tests + Build Fix
**Files:** New `packages/email-mcp/src/integration.test.ts`, all `package.json` files

1. Add `"pretest": "npm run build"` to each package
2. Add `"dev:serve"` and `"dev:watch"` scripts to root
3. Integration test: import from dist → verify expected API surface
4. Integration test: mock delta query → verify watcher sends wake POST
5. Integration test: mock delta with tombstones → verify they're filtered

---

## Acceptance Criteria

| # | Criterion | Verification method |
|---|-----------|-------------------|
| 1 | Watcher polls and logs each cycle | Start watcher, check stderr after 60s |
| 2 | Baseline sync: first run doesn't wake for old emails | Start watcher on inbox with 100+ emails → 0 wake POSTs during initial sync |
| 3 | New email triggers wake POST | Send/receive email during watch → verify wake POST in logs |
| 4 | Wake text includes: receiving mailbox, sender, to, cc, subject | Inspect wake POST body in logs |
| 5 | Tombstones filtered | Move email out of inbox during watch → no wake POST |
| 6 | Dedup works | Same delta returns same message → only one wake |
| 7 | Lock file prevents duplicate watchers | Start two watchers → second exits with error |
| 8 | Delta state persisted | Kill watcher → restart → no duplicate wakes for already-processed messages |
| 9 | 410 Gone handled | Corrupt delta link → watcher resyncs silently |
| 10 | Receive allowlist gates wakes | Configure allowlist → messages from non-allowed senders don't wake |
| 11 | Mailbox metadata has `emailAddress` | `cat ~/.agent-email/tokens/*.json \| jq .emailAddress` |
| 12 | Filesystem-safe filename | `ls ~/.agent-email/tokens/` shows sanitized name |
| 13 | `npm run test:run` all pass | 119+ tests, 0 failures |
| 14 | `npm run build` succeeds | 0 errors |
| 15 | No stubs remain (except dedup) | `grep -r "In real implementation" packages/*/src/*.ts` returns 0 |

## Execution Order

1. **WP1** (specs) → establishes contracts
2. **WP2** (mailbox naming) → small, unblocks WP3
3. **WP3** (watcher) → CRITICAL, most complex
4. **WP4** (client credentials) → small, independent
5. **WP5** (Gmail) → medium, may need user input
6. **WP6** (integration tests + build fix) → after implementations
