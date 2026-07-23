## MODIFIED Requirements

### Requirement: OAuth2 Authentication

The system SHALL authenticate to Gmail via OAuth2 using `@googleapis/gmail`
(NOT the full `googleapis` package at 200MB). It SHALL request
`https://www.googleapis.com/auth/gmail.modify` as its sole default Gmail scope
because the provider reads, composes, sends, labels, and moves messages to
trash, but does not permanently delete messages.

#### Scenario: Gmail OAuth
- **WHEN** `configure_mailbox` is called with `{provider: "gmail"}`
- **THEN** the system initiates OAuth2 flow and persists refresh tokens

#### Scenario: Gmail OAuth requests the narrowest implemented scope
- **WHEN** the direct/BYOK flow or hosted broker builds a Google authorization URL
- **THEN** it requests `https://www.googleapis.com/auth/gmail.modify`
- **AND** it does not request `https://mail.google.com/`

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
