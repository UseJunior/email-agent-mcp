## MODIFIED Requirements

### Requirement: Configure Mailbox

The system SHALL provide a `configure_mailbox` action that connects a named mailbox to a provider with credentials. The resulting metadata SHALL include the `emailAddress` field fetched from the provider during configuration.

#### Scenario: Add work mailbox
- **WHEN** `configure_mailbox` is called with `{name: "work", provider: "microsoft", credentials: {...}, default: true}`
- **THEN** the system connects to the Microsoft Graph API, fetches the email address, and marks "work" as the default mailbox
- **AND** the stored metadata includes `emailAddress`

#### Scenario: Gmail mailbox metadata is mode-discriminated
- **WHEN** a Gmail mailbox is configured
- **THEN** the stored metadata records a `source` discriminator equal to `'broker'` or `'byok'`
- **AND** for `'byok'` the metadata stores the user-supplied `clientId` and `clientSecret` plus the `refreshToken`
- **AND** for `'broker'` the metadata stores the `brokerUrl` plus the `refreshToken` and SHALL NOT store any `clientSecret` on disk

#### Scenario: Pre-broker metadata is parsed as BYOK
- **WHEN** the system loads a Gmail mailbox metadata file written before the broker change (no `source` field, but with `clientId` and `clientSecret`)
- **THEN** the system treats it as `source: 'byok'` for the purposes of subsequent loads and reconnects
