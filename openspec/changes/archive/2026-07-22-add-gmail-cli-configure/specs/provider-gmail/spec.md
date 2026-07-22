## MODIFIED Requirements

### Requirement: OAuth2 Authentication

The system SHALL authenticate to Gmail via OAuth2 using `@googleapis/gmail` (NOT the full `googleapis` package at 200MB).

#### Scenario: Gmail OAuth
- **WHEN** `configure_mailbox` is called with `{provider: "gmail"}`
- **THEN** the system initiates OAuth2 flow and persists refresh tokens

#### Scenario: Gmail CLI OAuth callback
- **WHEN** `email-agent-mcp configure --provider gmail` is run with a valid Google OAuth client configuration
- **THEN** the system opens a browser authorization URL or prints it for the user to visit
- **AND** receives the authorization callback on a local loopback address
- **AND** exchanges the code for tokens using PKCE before persisting the refresh token
