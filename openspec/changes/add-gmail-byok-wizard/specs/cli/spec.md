## MODIFIED Requirements

### Requirement: Interactive Wizard

The interactive wizard SHALL guide the user through provider selection, credential entry, and connection verification. It uses a provider picker presenting available options.

For Gmail, the wizard SHALL offer the hosted default OAuth client and a bring-your-own-key (BYOK) OAuth client. It SHALL state the hosted client's current Google Testing-status limitations, and the BYOK path SHALL identify the required client type as Desktop app and link to the repository's Gmail Setup instructions.

The wizard SHALL collect a BYOK client secret with a masked prompt, SHALL require both the client ID and client secret, and SHALL NOT render the secret in terminal output. Explicit CLI or environment credentials SHALL continue to take precedence without being replaced by wizard input. Reconnecting an existing mailbox SHALL continue to reuse its saved authentication mode and credentials.

#### Scenario: Provider picker shows available providers
- **WHEN** the interactive wizard starts
- **THEN** it presents a provider picker with both Outlook and Gmail as selectable providers

#### Scenario: Wizard persists config on success
- **WHEN** the wizard completes successfully (credentials validated, connection tested)
- **THEN** it writes the configuration to `~/.email-agent-mcp/config.json`
- **AND** the configured email address is auto-added to the send allowlist

#### Scenario: Gmail wizard offers both authentication modes
- **WHEN** a user selects Gmail in the first-run wizard without explicit BYOK credentials
- **THEN** the wizard offers the hosted default OAuth client and a BYOK OAuth client
- **AND** the hosted option states the current Google Testing-status limitations

#### Scenario: Gmail wizard collects BYOK credentials confidentially
- **WHEN** a user selects BYOK in the Gmail wizard
- **THEN** the wizard identifies Desktop app as the required Google OAuth client type
- **AND** links to the repository's Gmail Setup instructions
- **AND** prompts for the client ID and a masked client secret
- **AND** forwards both values to Gmail configuration without rendering the secret

#### Scenario: Gmail wizard rejects incomplete BYOK credentials
- **WHEN** the Gmail BYOK wizard receives only one non-empty credential half
- **THEN** it exits non-zero before starting OAuth
- **AND** explains that both the client ID and client secret are required

#### Scenario: Gmail wizard preserves explicit credentials
- **WHEN** the wizard is started with both Gmail BYOK credential halves supplied by CLI options or namespaced environment variables
- **THEN** it forwards those credentials without replacing them or prompting for another authentication mode

#### Scenario: Gmail wizard reconnect preserves saved credentials
- **WHEN** a user reconnects an existing Gmail mailbox from the wizard menu
- **THEN** the wizard delegates configuration for that mailbox without prompting for a new authentication mode
- **AND** the saved authentication mode and credentials are reused by Gmail configuration
