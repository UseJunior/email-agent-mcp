---
epic: Infrastructure
feature: Gmail Provider
---

## Purpose

Implements the provider interface for Gmail API email operations. Uses `@googleapis/gmail` (lightweight, ~1.1MB). Supports OAuth2 authentication, Gmail-specific label/star mapping, dual watch mode (Pub/Sub with 7-day auto-renewal + history.list polling fallback), and anti-spoofing via Authentication-Results headers.
## Requirements
### Requirement: OAuth2 Authentication

The system SHALL authenticate to Gmail via OAuth2 using `@googleapis/gmail` (NOT the full `googleapis` package at 200MB).

#### Scenario: Gmail OAuth
- **WHEN** `configure_mailbox` is called with `{provider: "gmail"}`
- **THEN** the system initiates OAuth2 flow and persists refresh tokens

#### Scenario: Gmail OAuth via hosted broker
- **WHEN** Gmail configure is started without explicit client credentials and no broker override
- **THEN** the CLI generates a fresh `session_id` and a private `pickup_secret`, registers the session at `POST /api/sessions` with the SHA-256 hash of the secret, opens the browser at `GET /api/start?session=<id>`, and waits for tokens at `POST /api/tickets/claim` (presenting the raw `pickup_secret` as proof of ownership)
- **AND** the broker exchanges Google's authorization code for tokens server-side using its held `client_secret`
- **AND** the CLI never possesses, persists, or sees the broker's `client_secret`
- **AND** subsequent Gmail API calls go directly from the user's machine to Google with the locally-held access token

#### Scenario: Public session_id is not a bearer credential
- **WHEN** anyone other than the originating CLI possesses a `session_id` (e.g. via browser history or server logs)
- **THEN** they cannot exchange that `session_id` for tokens
- **AND** the broker requires the matching `pickup_secret` (compared in constant time against the registered SHA-256 hash) before releasing tokens

#### Scenario: Atomic one-shot ticket claim
- **WHEN** two `POST /api/tickets/claim` calls present a valid `session_id` + `pickup_secret` pair concurrently
- **THEN** at most one returns the tokens; the other returns 410 (`consumed` or `not_found`)
- **AND** on KV-backed deployments this atomicity is implemented with a single Redis `GETDEL` command after constant-time secret verification

#### Scenario: Distinguishable terminal states
- **WHEN** the CLI polls `/api/tickets/claim` while the user has not yet completed consent
- **THEN** the broker returns 202 `{status: "pending"}`
- **WHEN** the user denies consent on Google's screen
- **THEN** the broker advances the session to `denied` and subsequent claim returns 410 `{status: "denied", error_description: ...}`
- **WHEN** Google's token exchange fails server-side
- **THEN** the broker advances the session to `exchange_failed` and subsequent claim returns 410 `{status: "exchange_failed", error_description: ...}`
- **WHEN** the session has expired
- **THEN** subsequent claim returns 410 `{status: "expired"}`

#### Scenario: Gmail OAuth via BYOK
- **WHEN** Gmail configure is started with explicit `client_id` and `client_secret`
- **THEN** the system runs a local-loopback OAuth flow against Google directly without involving the broker
- **AND** persists the BYOK credentials in the mailbox metadata for future refreshes

#### Scenario: Broker-mode refresh routes through the broker
- **WHEN** an access token needs to be refreshed for a broker-mode Gmail mailbox
- **THEN** the CLI POSTs the refresh token to the broker's `/api/refresh` endpoint
- **AND** the underlying `OAuth2Client` is configured so its built-in `refreshAccessTokenAsync()` path is NOT reachable: the `refresh_token` is not stored on `oauth2Client.credentials`, an `expiry_date` is always set on `oauth2Client.credentials` whenever an access token is present, and `refreshHandler` proxies to the broker
- **AND** byok-mode mailboxes refresh directly via Google's token endpoint using the stored `client_id` and `client_secret`

#### Scenario: Broker requires Redis in production
- **WHEN** the broker starts with `VERCEL_ENV=production` (or `BROKER_REQUIRE_KV=true`) and `KV_REST_API_URL` is unset
- **THEN** the broker fails fast with a configuration error rather than silently falling back to in-memory state that is not shared across function invocations

### Requirement: Message Mapping

The system SHALL map Gmail message format to the common `EmailMessage` type, including labels, thread IDs, and attachment metadata.

#### Scenario: Gmail message to EmailMessage
- **WHEN** a Gmail message is fetched
- **THEN** it is mapped to `EmailMessage` with `threadId`, labels, and standard fields

### Requirement: Reply To Recipients

Gmail composes replies itself rather than delegating to a provider-side reply endpoint, so it derives the To from the parent's sender. When `ReplyOptions.to` is supplied and non-empty, `replyToMessage` and `createReplyDraft` SHALL address the message to exactly those recipients instead, replacing the derived sender rather than merging with it. When `to` is absent or empty, both SHALL continue to address the original sender with Cc computed exactly as before, unchanged.

Under reply-all, an explicit `to` displaces the parent's sender from the To line; that sender SHALL be carried onto Cc so the thread's audience is never narrowed, and any address now on To SHALL be excluded from Cc so nobody is listed twice. Under `replyAll: false` no such preservation applies. Both reply methods SHALL resolve recipients through one shared helper so the send and draft paths cannot drift apart.

#### Scenario: explicit to replaces the original sender on a self-sent parent (issue #164)
- **WHEN** `createReplyDraft` is called with `replyAll: false` and an explicit `to`, against a parent whose sender is the mailbox owner
- **THEN** the raw message's To header carries the caller's recipient with its display name
- **AND** the mailbox owner's address does not appear in the message

#### Scenario: explicit to with several addresses lands on the To header (issue #164)
- **WHEN** `createReplyDraft` is called with several `to` entries
- **THEN** the To header carries all of them and the original sender is absent

#### Scenario: explicit to under reply-all moves the displaced sender to Cc (issue #164)
- **WHEN** `createReplyDraft` is called with an explicit `to` and reply-all left at its default
- **THEN** the To header carries the caller's recipient
- **AND** the parent's sender appears on Cc alongside the thread's other participants

#### Scenario: a caller addressed on To is not also listed on Cc (issue #164)
- **WHEN** a caller `to` entry matches a thread participant, differing only in case
- **THEN** that address appears on To and is absent from the Cc header

#### Scenario: omitted to keeps the original sender as To (issue #164 no-op guard)
- **WHEN** `createReplyDraft` is called with no `to`
- **THEN** the To header is the original sender, unchanged

#### Scenario: empty to array keeps the original sender as To (issue #164)
- **WHEN** `createReplyDraft` is called with `to: []`
- **THEN** the To header is the original sender, unchanged

#### Scenario: replyToMessage honors explicit to (issue #164)
- **WHEN** `replyToMessage` is called with an explicit `to`
- **THEN** the sent raw message is addressed to those recipients rather than the original sender

#### Scenario: replyToMessage without to keeps the original sender (issue #164 no-op guard)
- **WHEN** `replyToMessage` is called with no `to`
- **THEN** the sent raw message is addressed to the original sender, unchanged

### Requirement: Dual Watch Mode

The system SHALL support Pub/Sub push notifications (requires Google Cloud project, auto-renewal every 7 days) and `history.list` polling as a fallback for local/NAT environments.

#### Scenario: Pub/Sub auto-renewal
- **WHEN** the Pub/Sub watch registration approaches 7-day expiry
- **THEN** the system automatically re-registers via `users.watch()`

#### Scenario: history.list fallback
- **WHEN** Pub/Sub is not configured
- **THEN** the system polls `history.list` at a configurable interval (default 30s)

### Requirement: Label Mapping

The system SHALL map Gmail labels to folder/category concepts: `INBOX`, `SENT`, `TRASH`, `SPAM`, `STARRED`, `IMPORTANT`, and custom labels.

#### Scenario: Label as folder
- **WHEN** `list_emails` is called with `{folder: "junk"}`
- **THEN** the system queries messages with the `SPAM` label

### Requirement: NemoClaw Compatibility

The system SHALL document required egress domains: `gmail.googleapis.com`, `oauth2.googleapis.com`, `pubsub.googleapis.com`.

#### Scenario: NemoClaw egress
- **WHEN** running in NemoClaw
- **THEN** these domains are added to the egress policy

### Requirement: Draft-Only Deletion

The Gmail provider SHALL implement `deleteMessage` for drafts only, using `users.drafts.delete`, which the default `gmail.compose` scope authorizes. It SHALL accept either a draft id or the id of the draft's message, resolving a message id to its draft id through `users.drafts.list` across every page. A Gmail draft delete SHALL be permanent regardless of `hard_delete`, because Gmail has no trash for drafts, and SHALL NOT call any `gmail.modify` endpoint.

A message that exists but is not a draft SHALL be refused with a non-recoverable `NOT_SUPPORTED` error stating that only drafts can be deleted with the current scopes and that sent or received mail would need `gmail.modify`. An id that names nothing, or a DRAFT-labelled message absent from `drafts.list`, SHALL raise `MessageNotFoundError`; so SHALL a non-draft id on a client without `drafts.list`, which can resolve only draft ids. A `drafts.delete` 404 for a draft that resolved immediately before SHALL count as a successful delete, because the draft is already gone (for example after the client retried a DELETE whose first attempt succeeded). Other `drafts.delete` failures SHALL be classified as Gmail provider errors. A Gmail client without draft deletion SHALL report `NOT_SUPPORTED`.

A Gmail draft delete SHALL remain behind the existing delete policy: it requires `AGENT_EMAIL_DELETE_ENABLED=true` and `user_explicitly_requested_deletion: true`, and a caller-supplied `hard_delete: true` still requires `AGENT_EMAIL_HARD_DELETE_ENABLED=true`. It SHALL NOT otherwise require the hard-delete gate.

#### Scenario: Delete a Gmail draft by draft id
- **WHEN** `deleteMessage` is called with a draft id
- **THEN** the provider calls `drafts.delete` with that id without listing drafts

#### Scenario: Delete a Gmail draft by its message id
- **WHEN** `deleteMessage` is called with the id of a DRAFT-labelled message
- **THEN** the provider finds the matching draft in `drafts.list` and calls `drafts.delete` with its draft id

#### Scenario: Draft id resolution follows drafts.list pagination
- **WHEN** the matching draft is on a later `drafts.list` page
- **THEN** the provider follows `nextPageToken` until it finds the draft

#### Scenario: Deleting sent or received Gmail mail is not supported
- **WHEN** `deleteMessage` is called with the id of a message without the DRAFT label
- **THEN** it fails with `NOT_SUPPORTED` naming `gmail.modify`, and no delete or modify request is made

#### Scenario: Deleting an unknown Gmail id reports not found
- **WHEN** the id names neither a draft nor a message
- **THEN** `deleteMessage` raises `MessageNotFoundError`

#### Scenario: A DRAFT-labelled message missing from drafts.list reports not found
- **WHEN** the message carries the DRAFT label but no draft in `drafts.list` points at it
- **THEN** `deleteMessage` raises `MessageNotFoundError` and deletes nothing

#### Scenario: Gmail draft delete ignores hard and is always permanent
- **WHEN** `deleteMessage` is called with `hard: true`
- **THEN** the provider calls `drafts.delete` exactly as for a soft delete

#### Scenario: drafts.delete failures are classified as provider errors
- **WHEN** `drafts.delete` fails with an HTTP error
- **THEN** `deleteMessage` raises a Gmail `ProviderError`

#### Scenario: A drafts.delete 404 after resolution counts as deleted
- **WHEN** the draft resolves but `drafts.delete` returns 404
- **THEN** `deleteMessage` succeeds

#### Scenario: Gmail client without drafts.list resolves only draft ids
- **WHEN** the concrete Gmail client has no `listDrafts` and the id is not a draft id
- **THEN** `deleteMessage` raises `MessageNotFoundError` without reading the message

#### Scenario: Gmail client without drafts.delete reports NOT_SUPPORTED
- **WHEN** the concrete Gmail client has no `deleteDraft`
- **THEN** `deleteMessage` raises `NOT_SUPPORTED` before any request

#### Scenario: Gmail draft delete stays behind the delete policy gate
- **WHEN** `delete_email` targets a Gmail draft with deletion disabled, without caller intent, or with `hard_delete: true` but no hard-delete gate
- **THEN** it returns `DELETE_DISABLED` and deletes nothing
- **AND WHEN** only `AGENT_EMAIL_DELETE_ENABLED` and caller intent are present
- **THEN** the draft is deleted

#### Scenario: delete_email on Gmail sent mail returns NOT_SUPPORTED
- **WHEN** `delete_email` targets a sent Gmail message with deletion enabled
- **THEN** it returns `{success: false, error: {code: "NOT_SUPPORTED"}}` naming `gmail.modify`

#### Scenario: listDrafts maps draft ids to their message ids
- **WHEN** the googleapis client lists drafts
- **THEN** it returns each draft id with its message id and the next page token, skipping drafts without an id

#### Scenario: deleteDraft uses Gmail drafts.delete
- **WHEN** the googleapis client deletes a draft
- **THEN** it calls `users.drafts.delete` for `me` with the draft id

### Requirement: Draft Id Resolution

Gmail draft reads and edits SHALL accept the id of a draft's message as well as its draft id, using the same resolution as draft deletion, so a draft found through `list_emails(folder: "drafts")`, `read_email`, or `get_thread` can be edited by the id those tools report.

#### Scenario: update_draft accepts a Gmail draft message id
- **WHEN** `updateDraft` is called with a draft's message id
- **THEN** the provider resolves the draft id and calls `drafts.update` with it, preserving the existing body

#### Scenario: update_draft refuses a Gmail message that is not a draft
- **WHEN** `updateDraft` is called with the id of a sent message
- **THEN** it returns `NOT_A_DRAFT` and makes no update

#### Scenario: Draft reply status resolves a Gmail draft message id
- **WHEN** `getDraftReplyStatus` or `getDraft` is called with a draft's message id
- **THEN** it reads the resolved draft

