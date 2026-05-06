## MODIFIED Requirements

### Requirement: OAuth2 Authentication

The system SHALL authenticate to Gmail via OAuth2 using `@googleapis/gmail` (NOT the full `googleapis` package at 200MB).

#### Scenario: Gmail OAuth
- **WHEN** `configure_mailbox` is called with `{provider: "gmail"}`
- **THEN** the system initiates OAuth2 flow and persists refresh tokens

#### Scenario: Gmail OAuth via hosted broker
- **WHEN** Gmail configure is started without explicit client credentials and no broker override
- **THEN** the system delegates the OAuth dance (auth URL construction, code-for-token exchange) to a hosted OAuth broker that holds the `client_secret` server-side
- **AND** the CLI never possesses or persists the broker's `client_secret`
- **AND** subsequent Gmail API calls go directly from the user's machine to Google with the locally-held access token

#### Scenario: Gmail OAuth via BYOK
- **WHEN** Gmail configure is started with explicit `client_id` and `client_secret`
- **THEN** the system runs a local-loopback OAuth flow against Google directly without involving the broker
- **AND** persists the BYOK credentials in the mailbox metadata for future refreshes

#### Scenario: Gmail token refresh respects mode
- **WHEN** an access token needs to be refreshed for a Gmail mailbox
- **THEN** broker-mode mailboxes refresh by POSTing the refresh token to the broker's `/api/refresh` endpoint
- **AND** byok-mode mailboxes refresh directly via Google's token endpoint using the stored `client_id` and `client_secret`
