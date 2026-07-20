## ADDED Requirements

### Requirement: Optional Folder and Rule Capabilities

The provider abstraction SHALL define `EmailFolderManager` and `EmailRuleManager` as optional capabilities on the combined `EmailProvider` type and SHALL advertise `folders` and `rules` in provider capability metadata.

#### Scenario: Provider omits optional capabilities
- **WHEN** a provider implements email reading and sending but not folder or rule management
- **THEN** it remains a valid `EmailProvider`
- **AND** folder and rule actions can detect the missing capability

### Requirement: Microsoft Mailbox Settings Consent

The Microsoft delegated authentication configuration SHALL request `MailboxSettings.ReadWrite` in both the short and full-URL Graph scope lists.

#### Scenario: Existing user reconnects
- **WHEN** an existing Microsoft user reconnects after this capability is introduced
- **THEN** the consent request includes `MailboxSettings.ReadWrite`
- **AND** user-facing documentation states that re-consent is required
