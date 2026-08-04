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

Gmail composes replies itself rather than delegating to a provider-side reply endpoint, so it derives the To from the parent's sender. When `ReplyOptions.to` is supplied and non-empty, `replyToMessage` and `createReplyDraft` SHALL address the message to exactly those recipients instead, replacing the derived sender rather than merging with it. When `to` is absent or empty, both SHALL continue to address the original sender, unchanged. Cc derivation is unaffected on either path.

#### Scenario: explicit to replaces the original sender on a self-sent parent (issue #164)
- **WHEN** `createReplyDraft` is called with `replyAll: false` and an explicit `to`, against a parent whose sender is the mailbox owner
- **THEN** the raw message's To header carries the caller's recipient with its display name
- **AND** the mailbox owner's address does not appear in the message

#### Scenario: explicit to with several addresses lands on the To header (issue #164)
- **WHEN** `createReplyDraft` is called with several `to` entries
- **THEN** the To header carries all of them and the original sender is absent

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

