# Design

## Transition ownership

Use plain discriminated unions, exhaustive switches and narrow transition functions. No state-machine framework. Business rules stay in email-core; provider request details stay in provider packages; MCP/CLI project internal results into existing wire fields.

## Broker

Stored sessions are pending, ready-with-tokens, denied-with-error, or exchange_failed-with-error. Absence/expiry/consumption are store outcomes, not optional fields. Redis Lua implements expected-pending advancement with KEEPTTL, and atomic verification/consumption. Compute the presented hash before entering the store operation. Compare hashes without early exit; validate state/data before returning tokens. Memory storage uses the same pure transition decisions and rechecks identity/expiry after asynchronous hashing. First terminal callback wins; losers cannot overwrite it. No persistent consumed tombstones are added: preserve the existing not_found/consumed response possibilities.

## Watcher

Mailbox states: bootstrapping, idle(checkpoint), polling, delivering, checkpointing, backing_off, stopping, stopped. A lease wraps proper-lockfile with stale=60000, update=10000 and no acquisition retries. Use its acquired release handle. Compromise stops mailbox work. Legacy lock checks refuse a live or indeterminate owner; stop legacy watchers before upgrade, since old code cannot honor the new protocol.

Each poll captures end=now before fetching. Query inclusive [checkpoint,end], follow all nextLink pages, and abort the poll on repeated URL, excessive paging, failed page, or cancellation. Never checkpoint partial retrieval. Namespace dedup by provider/stable mailbox/message ID. Retain the inclusive lower bound so equal timestamps cannot disappear. Save end only after all eligible wakes succeed; persist before updating memory. Wake delivery remains at-least-once across crashes and ambiguous HTTP outcomes.

Checkpoint v1: {version:1,kind:'timestamp',lastUpdated:ISO_timestamp}. Load legacy {deltaLink,lastUpdated} by reading its valid timestamp; reject malformed existing files with an actionable mailbox error. Absence alone starts at now. Persist temp+rename within the state directory, mode 0600; clean up failed temporary writes. No historical backfill is added.

First signal enters draining: stop scheduling and allow current work up to 15 seconds; then abort and wait for cancellation cleanup before releasing leases. Second signal exits immediately. Transient mailbox failure backs off from the configured poll interval exponentially to five minutes; success resets backoff.

## Auth and initialization

Per-manager auth states: disconnected, connecting, connected(session), refreshing(session,promise), reauth_required(reason), disconnecting. Serialize mutating operations and use generation tokens around external awaits. Disconnect invalidates the generation immediately so stale token acquisition cannot restore runtime access. Refresh callers share a promise; terminal auth failure requires configuration; transient failure retains a coherent prior session. MSAL remains responsible for its cache. Connect/disconnect does not implicitly delete Microsoft metadata.

Gmail OAuth client token events and explicit refresh both update a single token object. Persist rotations through an optional metadata-writer callback at the existing credential-storage path, using atomic file replacement; serialization prevents older rotations overwriting new ones. Report persistence failure distinctly while retaining the valid runtime session; do not replay a delivery because persistence failed. Broker refresh_token never enters OAuth-client credentials. Profile lookup uses the same valid-token acquisition.

Initialization states: pending, connecting(promise,generation), ready(mailboxes,defaultMailboxId), not_configured, failed(mailboxes,error). Mailboxes are connected(provider,auth) or failed(metadata,error). Keep selected identity rather than mutable default flags internally. Preserve current startup selection order. Requests can retry transient initialization after 30 seconds; terminal credentials require configure. Partial success remains ready and failed mailbox metadata stays inspectable.

## Drafts and delivery

DraftSnapshot carries canonical draft/message IDs, optional provider revision, lifecycle editable/deferred/indeterminate, and independent origin reply/non_reply/indeterminate. Central checks use draft-specific reads. Keep uncertain origin fail-closed for body replacement. Do not claim atomicity from a second read; add conditional requests only for verified supported endpoints, with contract tests. Unsupported conditions remain an explicit remote TOCTOU limitation.

Delivery phases: prepared, dispatching, accepted, rejected, unknown. Scheduling preparation phases: draft_created, attachments_ready, deferred_property_set, dispatching, terminal outcome. Every partial failure preserves a surviving draft/message ID. Unknown dispatch never causes automatic replay or cleanup deletion. Deferred markers must be valid and future-dated for cancellation; past markers are residue. Ordinary edit/send refuses verified pending schedules.

Send leases: reserved, dispatched, settled, released. Only reserved may release; settlement is terminal. Dispatched attempts remain blocking until settled, then use existing retention. Preserve sibling identity and strongest evidence. Scope stays process-local; no durable ledger or distributed exactly-once claim.

Authenticated retry takes operation kind and auth-error predicate. Delivery retains only one explicit-401-rejection recovery retry; timeouts/5xx/unknown never replay. Deprecate broad auto-refresh through a safe compatibility wrapper; no production caller currently depends on it. Generic retry waits accept AbortSignal and validate settings.

Rate limiting uses reservations with release for pre-dispatch/proven rejection and consume for accepted/unknown. Existing exported check/record interface gets a deprecated adapter; shipped adapters still have no new default limiter.

## Policy, cache and helper state

Allowlist watcher lifecycle is unstarted/starting/active/degraded/closed; policy is absent/valid/invalid. Validate entries as string arrays. Serialize reloads; start is idempotent; close invalidates completions. Missing send blocks, missing receive accepts; malformed startup blocks governed operations; malformed reload retains last-good policy. Do not convert invalid to absence.

Folder caches are empty/loading(generation,promise)/ready(expiry,data). Invalidation increments generation and affects folder/system-folder caches. Share concurrent loads and never cache partial snapshots.

Subscription existence is exists/missing/unknown; only 404 means missing. Legacy boolean wrapper throws on unknown. Namespace notification dedup; validate timestamps; bound Graph delta/Gmail history pages and reject repeated tokens. Advance cursor only after complete retrieval. Renewal remains caller responsibility, not a newly implemented service.

Loopback OAuth has one terminal settlement owner for callback/error/timeout/abort; cleanup closes timer/listener/connections without waiting indefinitely. Verify expected state before exchanging code. Tooling recording state is deferred: it already has version and atomic write support.

## Compatibility and validation

Add internal types first; exported replacements coexist with deprecated adapters. Existing tool schemas do not change. One focused test suite per group enumerates legal/illegal transitions and barrier-controlled races. Use real disposable Redis for Lua integration and child processes for lock exclusion; mocks alone cannot validate those boundaries. Full tests/build/lint/spec-coverage/manifests/isolated-runtime checks run at integration milestones. Live delivery uses synthetic mailboxes only. Proposal validation is not evidence of implementation completion.
