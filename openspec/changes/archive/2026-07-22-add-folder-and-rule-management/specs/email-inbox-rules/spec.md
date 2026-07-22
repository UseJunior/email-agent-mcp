## ADDED Requirements

### Requirement: Faithful Inbox Rule Listing

The system SHALL provide a read-only `list_inbox_rules` action that returns all fields supplied by the provider, including unsafe actions on rules created outside this system.

#### Scenario: List externally created forwarding rule
- **WHEN** Graph returns a rule containing `forwardTo`
- **THEN** `list_inbox_rules` returns the rule and its `forwardTo` action unchanged

### Requirement: Safe Approved Inbox Rule Creation

The system SHALL provide `create_inbox_rule` with minimal safe actions and SHALL require the caller to affirm intent via `user_explicitly_approved` before a rule is created.

This affirmation is caller attestation and audit metadata — NOT a security boundary. The flag is supplied by the calling model, which can set it without consulting a human, so it cannot enforce human approval on its own. Genuine human-in-the-loop MUST come from the MCP client's tool-approval UI. The system SHALL NOT describe this flag as human approval in user-facing text.

#### Scenario: Create attested move rule
- **WHEN** `create_inbox_rule` receives an attested rule that moves matching mail to a custom folder
- **THEN** the system resolves the folder and creates the rule through the provider

#### Scenario: Missing intent affirmation
- **WHEN** `create_inbox_rule` is called without `user_explicitly_approved: true`
- **THEN** it returns a typed `APPROVAL_REQUIRED` error without calling the provider

### Requirement: Unsafe Rule Action Rejection

The system MUST reject creation of any inbox rule whose actions contain `forwardTo`, `forwardAsAttachmentTo`, `redirectTo`, or `delete`, returning a typed error instead of throwing.

#### Scenario: Reject forwarding action
- **WHEN** `create_inbox_rule` receives an action containing `forwardTo`
- **THEN** it returns `{success: false, error: {code: "UNSAFE_RULE_ACTION", ...}}`
- **AND** it does not call the provider

### Requirement: Inbox Rule Deletion

The system SHALL provide a destructive `delete_inbox_rule` action that deletes a rule by id.

#### Scenario: Delete a rule
- **WHEN** `delete_inbox_rule` is called with `{id: "rule123"}`
- **THEN** the provider deletes `rule123` from the inbox rules collection

### Requirement: Unsupported Rule Provider

Inbox-rule actions SHALL return a typed `NOT_SUPPORTED` result when the selected provider does not implement `EmailRuleManager`.

#### Scenario: Gmail rule request
- **WHEN** `list_inbox_rules` is called for a Gmail provider
- **THEN** the action returns `{success: false, error: {code: "NOT_SUPPORTED", ...}}`

### Requirement: Destructive Rule Destination Rejection

The system MUST reject creation of any inbox rule whose `moveToFolder` or `copyToFolder` destination resolves to a mail-discarding folder (Deleted Items, recoverable-items dumpster, or their aliases such as `trash`/`deleted`). Filing mail into these is functionally equivalent to the blocked `delete` action and, combined with empty conditions, would discard the entire mailbox.

#### Scenario: Reject a rule that files mail into Deleted Items
- **WHEN** `create_inbox_rule` receives `{"actions": {"moveToFolder": "trash"}}`
- **THEN** it returns `{success: false, error: {code: "UNSAFE_RULE_DESTINATION", ...}}`
- **AND** it does not call the provider

#### Scenario: Reject aliases and case variants after resolution
- **WHEN** a destination such as `deleted`, `DeletedItems`, or ` Trash ` normalizes to the deleted-items folder
- **THEN** the provider rejects it with `UNSAFE_RULE_DESTINATION` before issuing any write

### Requirement: Provider-Layer Rule Action Enforcement

Provider implementations of `EmailRuleManager.createInboxRule` MUST independently enforce the safe-action allowlist using case-normalized keys, because Microsoft Graph accepts JSON keys case-insensitively and the interface is callable without passing through the MCP action layer.

#### Scenario: Reject case-variant forwarding at the provider
- **WHEN** `createInboxRule` is called directly with an action key of `ForwardTo` or `REDIRECTTO`
- **THEN** the provider throws `UNSAFE_RULE_ACTION` without issuing a write

#### Scenario: Fail closed on unknown actions
- **WHEN** an action key outside the safe allowlist is supplied
- **THEN** the provider throws `UNSUPPORTED_RULE_ACTION` rather than forwarding it to Graph

### Requirement: Gated Rule Deletion

`delete_inbox_rule` MUST be disabled by default and gated behind the same operator deletion policy as `delete_email`, because removing a rule can silently re-expose the mailbox to filtered mail or remove an organization/anti-abuse rule. It MUST require an explicit `user_explicitly_requested_deletion` affirmation and MUST return a typed `DELETE_DISABLED` error when the policy is off or the affirmation is absent.

#### Scenario: Rule deletion is disabled by default
- **WHEN** `delete_inbox_rule` is called and the operator has not enabled deletion
- **THEN** it returns `{success: false, error: {code: "DELETE_DISABLED", ...}}` without calling the provider

#### Scenario: Rule deletion requires explicit affirmation
- **WHEN** `delete_inbox_rule` is called with `user_explicitly_requested_deletion: false`
- **THEN** it returns `DELETE_DISABLED` without calling the provider
