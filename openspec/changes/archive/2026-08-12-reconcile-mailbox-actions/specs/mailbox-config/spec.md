## MODIFIED Requirements

### Requirement: Configure Mailbox

The system SHALL provide CLI configuration that connects a named mailbox to a provider with credentials. The resulting metadata SHALL include the `emailAddress` field fetched from the provider during configuration. Credential collection SHALL NOT be exposed through an agent-facing MCP tool.

#### Scenario: Add work mailbox
- **WHEN** the user runs the configure CLI flow for `{name: "work", provider: "microsoft", credentials: {...}, default: true}`
- **THEN** the system connects to the Microsoft Graph API, fetches the email address, and marks "work" as the default mailbox
- **AND** the stored metadata includes `emailAddress`

#### Scenario: Gmail mailbox metadata is mode-discriminated
- **WHEN** a Gmail mailbox is configured
- **THEN** the stored metadata records a `source` discriminator equal to `'broker'` or `'byok'`
- **AND** for `'byok'` the metadata stores the user-supplied `clientId` and `clientSecret` plus the `refreshToken`
- **AND** for `'broker'` the metadata stores the `brokerUrl` plus the `refreshToken` and SHALL NOT store any `clientSecret` on disk

#### Scenario: Pre-broker metadata is parsed as BYOK only when unambiguous
- **WHEN** the system loads a Gmail mailbox metadata file written before the broker change (no `source` field) that has both `clientId` and `clientSecret` and NO `brokerUrl`
- **THEN** the system treats it as `source: 'byok'` for the purposes of subsequent loads and reconnects

#### Scenario: Ambiguous mixed-shape metadata is rejected
- **WHEN** the system loads a Gmail mailbox metadata file that contains BOTH `clientSecret` and `brokerUrl`
- **THEN** the system refuses to interpret the record (returns null) and leaves the mailbox unconfigured, forcing the user to re-run configure
- **AND** `source: 'broker'` records that lack `brokerUrl`, and `source: 'byok'` records that lack `clientSecret`, are likewise rejected

### Requirement: List Mailboxes

The MCP server SHALL provide a `list_mailboxes` diagnostic tool backed by its configured mailbox state. It SHALL return all configured mailboxes with their status, including the `emailAddress` field.

#### Scenario: List all mailboxes
- **WHEN** `list_mailboxes` is called
- **THEN** the system returns `[{name: "work", emailAddress: "test-user@example.com", provider: "microsoft", isDefault: true, status: "connected"}, ...]`

### Requirement: Mailbox Status

The MCP server SHALL provide a state-backed `get_mailbox_status` diagnostic tool returning connection state, provider type, and warnings (e.g., "outbound disabled — no send allowlist configured").

#### Scenario: Status with warning
- **WHEN** `get_mailbox_status` is called and no send allowlist is configured
- **THEN** the result includes warnings explaining that outbound email is disabled

## REMOVED Requirements

### Requirement: Remove Mailbox

The unreachable in-memory `remove_mailbox` core action is removed because it never affected persisted configuration. Mailboxes are removed by changing their persisted CLI configuration.
